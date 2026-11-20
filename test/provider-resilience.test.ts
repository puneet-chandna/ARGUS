import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extract, decide } from "../lib/ingestion/index.ts";
import { cacheKey, liveOcrStatus, readLive } from "../lib/ingestion/providers.ts";
import { readerNotice } from "../app/ocr.ts";
import { syntheticPdf } from "./fixtures/pdf.ts";

function environment(t: TestContext) {
  for (const [key, value] of Object.entries({ SARVAM_API_KEY: "test", NVIDIA_API_KEY: "test", GEMINI_API_KEY: "",
    ARGUS_OCR_CACHE_DIR: "", ARGUS_WRITE_OCR_CACHE: "0", ARGUS_NVIDIA_ENDPOINT: "" })) {
    const before = process.env[key]; process.env[key] = value;
    t.after(() => { if (before === undefined) delete process.env[key]; else process.env[key] = before; });
  }
}
const transcript = "Engine capacity: 998 cc";
const fields = [{ field: "engine_cc", value: "998", quote: transcript }];
const chat = (model: string) => Response.json({ model,
  choices: [{ finish_reason: "stop", message: { content: JSON.stringify({ transcript, fields }) } }] });

test("failed fallback lanes retain each actual provider cause rather than relabelling the final failure", async t => {
  environment(t);
  t.mock.method(globalThis, "fetch", async (url: string) => {
    if (url.endsWith("/extract")) return Response.json({}, { status: 402 });
    return Response.json({}, { status: 503 });
  });
  const result = await extract(syntheticPdf(transcript), "failures.pdf", true);
  assert.equal(result.reader_failures[1].sarvam, "http_402");
  assert.equal(result.reader_failures[1]["nvidia-mistral"], "http_503");
  assert.equal(result.reader_failures[1]["nvidia-super-vl"], "http_503");
  assert.equal(result.fields.engine_cc.value, null);
  const notice = readerNotice(result.reader_failures)!;
  assert.match(notice, /Sarvam.*(?:credits|billing|quota)/i);
  assert.match(notice, /temporarily unavailable/i);
});

test("DeepSeek reads the original image through Sarvam with structured output and its own provenance", async t => {
  environment(t);
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    assert.equal(url, "https://api.sarvam.ai/v2/chat/completions");
    assert.equal((init.headers as Record<string, string>)["api-subscription-key"], "test");
    const body = JSON.parse(String(init.body));
    assert.equal(body.model, "deepseekv4.1-flash-1017");
    assert.equal(body.reasoning_effort, "none");
    assert.equal(body.response_format.type, "json_schema");
    assert.equal(body.messages[0].content[1].image_url.url, "data:image/png;base64,aW1hZ2U=");
    assert.match(body.messages[0].content[0].text, /Basic OD Premium/);
    return chat(body.model);
  });
  const read = await readLive("sarvam-deepseek", 1, Buffer.from("image"), AbortSignal.timeout(5000), ["basic_od_premium"]);
  assert.equal(read.model, "deepseekv4.1-flash-1017");
  assert.deepEqual(read.candidates, [], "Unrequested fields stay out of the targeted re-read");
  assert.notEqual(cacheKey("sarvam-deepseek", Buffer.from("image")), cacheKey("sarvam", Buffer.from("image")));
});

test("an unavailable NVIDIA reader uses DeepSeek once, while healthy and unconsented paths make no fallback call", async t => {
  environment(t);
  const directory = await mkdtemp(join(tmpdir(), "argus-fallback-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  process.env.ARGUS_OCR_CACHE_DIR = directory;
  process.env.ARGUS_WRITE_OCR_CACHE = "1";
  let failNvidia = true, fallbackCalls = 0;
  const transport = t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    if (url.endsWith("/extract")) return Response.json({ job_id: "test-job", status: "completed" });
    if (url.endsWith("/results")) return Response.json({ result: { transcript, engine_cc: [{ value: "998", quote: transcript }] } });
    const body = JSON.parse(String(init.body));
    if (url.includes("api.sarvam.ai/v2/")) { fallbackCalls++; return chat(body.model); }
    return failNvidia ? Response.json({}, { status: 503 }) : chat(body.model);
  });
  const pdf = syntheticPdf(transcript);
  const result = await extract(pdf, "fallback.pdf", true);
  assert.equal(fallbackCalls, 1);
  assert.deepEqual(result.reader_failures, {});
  assert.equal(result.fields.engine_cc.value, "998");
  assert.deepEqual(result.fields.engine_cc.evidence.map(source => source.reader).sort(), ["sarvam", "sarvam-deepseek"]);
  const beforeReplay = transport.mock.callCount();
  const replay = await extract(pdf, "cached-fallback.pdf", false);
  assert.equal(replay.fields.engine_cc.value, "998");
  assert.equal(transport.mock.callCount(), beforeReplay, "Fallback readings replay without another cloud call");
  process.env.ARGUS_OCR_CACHE_DIR = "";
  const reading = await readLive("sarvam-deepseek", 1, Buffer.from("image"), AbortSignal.timeout(5000));
  assert.equal(decide("same.pdf", [reading, reading]).engine_cc.value, null);
  failNvidia = false;
  const before = fallbackCalls;
  assert.equal((await extract(pdf, "healthy.pdf", true)).fields.engine_cc.value, "998");
  assert.equal(fallbackCalls, before);
  const requests = transport.mock.callCount();
  await extract(pdf, "no-consent.pdf", false);
  assert.equal(transport.mock.callCount(), requests);
  process.env.NVIDIA_API_KEY = "";
  assert.equal(liveOcrStatus(), "ready", "Sarvam Vision plus DeepSeek can provide independent model readings");
});
