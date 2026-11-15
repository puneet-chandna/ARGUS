import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { canonical, decide, extract, type PageRead } from "../lib/ingestion/index.ts";
import { grounded, type Candidate } from "../lib/ingestion/facts.ts";
import { cacheKey } from "../lib/ingestion/providers.ts";

const read = (reader: PageRead["reader"], page: number, value: string, quote = `Engine capacity: ${value} cc`): PageRead => ({
  reader, model: reader, page, transcript: quote,
  candidates: [{field: "engine_cc", value, quote, box: null}],
});

test("fields require two independently grounded reads of the same page", () => {
  const sarvam = read("sarvam", 1, "998");
  const nvidia = read("nvidia-super-vl", 1, "998");
  assert.equal(decide("source.pdf", [sarvam, nvidia]).engine_cc.value, "998");
  assert.equal(decide("source.pdf", [sarvam, sarvam]).engine_cc.reason, "insufficient_agreement");
  assert.equal(decide("source.pdf", [sarvam, {...nvidia, page: 2}]).engine_cc.value, null);
  assert.equal(decide("source.pdf", [sarvam, {...nvidia, transcript: "Seats: 998"}]).engine_cc.value, null);
  assert.equal(decide("source.pdf", [sarvam, nvidia], false).engine_cc.reason, "incomplete_independent_page_coverage");
});

test("later page disagreement preserves both citations and prevents acceptance", () => {
  const decisions = decide("source.pdf", [
    read("sarvam", 1, "998"), read("nvidia-super-vl", 1, "998"),
    read("sarvam", 2, "1086"), {...read("nvidia-super-vl", 2, "1086"), candidates: []},
  ]);
  assert.equal(decisions.engine_cc.reason, "conflicting_readings");
  assert.equal(decisions.engine_cc.value, null);
  assert.deepEqual(decisions.engine_cc.evidence.map(({file, page}) => [file, page]), [
    ["source.pdf", 1], ["source.pdf", 1], ["source.pdf", 2],
  ]);
});

test("normalizes unambiguous dates and exact amounts conservatively", () => {
  assert.equal(canonical("start_date", "03/04/2026"), null);
  assert.equal(canonical("start_date", "2026-02-31"), null);
  assert.equal(canonical("start_date", "13/04/2026"), "2026-04-13");
  assert.equal(canonical("start_date", "28-February-2026"), "2026-02-28");
  assert.equal(canonical("net_premium", "₹१,२३,४५६.५०"), "123456.5");
  assert.equal(canonical("net_premium", "1,234,50"), null);
  assert.equal(canonical("engine_cc", "1O00"), null);
});

test("wrong term, premium component and partial RTO cannot ground a candidate", () => {
  const valid = (field: Candidate["field"], value: string, quote: string) => grounded({field, value, quote, box: null}, quote);
  assert.equal(valid("current_ncb", "35%", "Previous NCB: 35%"), false);
  assert.equal(valid("net_premium", "1180.50", "Net OD premium: INR 1,180.50"), false);
  assert.equal(valid("basic_od_premium", "765", "Basic OD/TP premium: 1230 | 765"), false);
  assert.equal(valid("net_od_premium", "100", "Net OD premium: INR 100.10"), false);
  assert.equal(valid("net_od_premium", "100.1", "Net OD premium: INR 100.10"), true);
  assert.equal(valid("rto", "UP7", "Registration No. UP78AB1234"), false);
  assert.equal(valid("rto", "UP78", "Registration No. UP78AB1234"), true);
  assert.equal(valid("rto", "MH01", "RTO: MH-01"), true);
});

function syntheticPdf(text: string) {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Count 1 /Kids [3 0 R] >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  const page = `BT /F1 12 Tf 30 200 Td (${text}) Tj ET`;
  objects.push(`<< /Length ${page.length} >>\nstream\n${page}\nendstream`);
  let pdf = "%PDF-1.4\n";
  const pointers = ["0000000000 65535 f "];
  objects.forEach((object, i) => {
    pointers.push(pad(pdf.length) + " 00000 n ");
    pdf += `${i+1} 0 obj\n${object}\nendobj\n`;
  });
  const table = `xref\n0 ${pointers.length}\n${pointers.join("\n")}\n`;
  return Buffer.from(pdf + table + `trailer\n<< /Size ${pointers.length} /Root 1 0 R >>\nstartxref\n${pdf.length}\n%%EOF\n`);
}

function pad(offset: number) {
  return String(offset).padStart(10, "0");
}

test("a synthetic PDF uses its rendered image cache or fails closed with zero network calls", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "argus-ocr-test-"));
  t.after(() => rm(directory, {recursive: true, force: true}));
  const fetch = t.mock.method(globalThis, "fetch", () => { throw new Error("attempted network call"); });
  const previous = process.env.ARGUS_OCR_CACHE_DIR;
  process.env.ARGUS_OCR_CACHE_DIR = directory;
  t.after(() => {
    if (previous === undefined) delete process.env.ARGUS_OCR_CACHE_DIR;
    else process.env.ARGUS_OCR_CACHE_DIR = previous;
  });
  const pdf = syntheticPdf("Engine capacity: 998 cc");
  const absent = await extract(pdf, "unseen.pdf", false);
  assert.match(absent.checksum, /^[0-9a-f]{64}$/);
  assert.ok(Object.values(absent.fields).every(field => field.value === null));
  assert.equal(absent.reader_failures[1].sarvam, "cloud_not_authorized");

  const file = join(directory, "synthetic.pdf");
  await writeFile(file, pdf);
  const {stdout: image} = await promisify(execFile)("pdftoppm", [
    "-f", "1", "-l", "1", "-r", "225", "-scale-to", "2048", "-png", "-singlefile", file,
  ], {encoding: "buffer", maxBuffer: 16 * 1024 * 1024});
  const {transcript, candidates: fields} = read("sarvam", 1, "998");
  const sarvam = {transcript, fields};
  const superVl = {choices: [{finish_reason: "stop", message: {content: JSON.stringify(sarvam)}}]};
  await Promise.all([
    writeFile(join(directory, `${cacheKey("sarvam", image)}.json`), JSON.stringify(sarvam)),
    writeFile(join(directory, `${cacheKey("nvidia-super-vl", image)}.json`), JSON.stringify(superVl)),
  ]);
  const replay = await extract(pdf, "unseen.pdf", false);
  assert.equal(replay.fields.engine_cc.value, "998");
  assert.equal(replay.fields.engine_cc.evidence.length, 2);
  assert.deepEqual(replay.reader_failures, {});
  assert.equal(fetch.mock.callCount(), 0);
});

test("OCR falls back in order without reserving NVIDIA quota", async t => {
  const directory = await mkdtemp(join(tmpdir(), "argus-live-cache-"));
  t.after(() => rm(directory, {recursive: true, force: true}));
  for (const [key, value] of Object.entries({
    SARVAM_API_KEY: "test", GEMINI_API_KEY: "test", NVIDIA_API_KEY: "test",
    ARGUS_OCR_CACHE_DIR: directory, ARGUS_WRITE_OCR_CACHE: "0", ARGUS_NVIDIA_ENDPOINT: "",
  })) {
    const saved = process.env[key];
    process.env[key] = value;
    t.after(() => {
      if (saved === undefined) delete process.env[key];
      else process.env[key] = saved;
    });
  }

  const {transcript, candidates: fields} = read("sarvam", 1, "998");
  const response = {transcript, fields};
  const submissions: string[] = [];
  let sarvamStatus = 200;
  let geminiStatus = 200;
  const transport = t.mock.method(globalThis, "fetch", async (url: string, options: RequestInit) => {
    assert.equal(options.redirect, "error");
    if (url.endsWith("/extract")) {
      assert.ok(options.body instanceof FormData);
      assert.ok(options.body.get("file") instanceof File);
      submissions.push("sarvam");
      return Response.json({job_id: "synthetic-job", status: "completed"}, {status: sarvamStatus});
    }
    if (url.endsWith("/results")) {
      return Response.json({result: {transcript, engine_cc: [null, {value: null, quote: null}, {value: "998", quote: transcript}]}});
    }
    assert.equal(typeof options.body, "string");
    const payload = JSON.parse(options.body as string);
    if (url.startsWith("https://generativelanguage.googleapis.com/")) {
      assert.ok(url.endsWith("/gemini-3.8-flash:generateContent"));
      assert.equal(payload.contents[0].parts[1].inlineData.mimeType, "image/png");
      assert.equal(payload.generationConfig.responseMimeType, "application/json");
      submissions.push("gemini-flash");
      return Response.json({modelVersion: "gemini-3.8-flash", candidates: [{
        finishReason: "STOP", content: {parts: [{text: JSON.stringify(response)}]},
      }]}, {status: geminiStatus});
    }
    assert.equal(url, "https://integrate.api.nvidia.com/v1/chat/completions");
    if (payload.model === "nvidia/nemotron-3.5-super-vl-120b-a12b") {
      assert.equal(payload.chat_template_kwargs.enable_thinking, false);
      submissions.push("nvidia-super-vl");
    } else {
      assert.equal(payload.model, "mistralai/mistral-large-4-1t-a52b");
      submissions.push("nvidia-mistral");
    }
    return Response.json({model: payload.model, choices: [{finish_reason: "stop", message: {content: JSON.stringify(response)}}]});
  });

  const pdf = syntheticPdf(transcript);
  for (const scenario of [
    { name: "primary pair", sarvamStatus: 200, geminiStatus: 200, allowed: ["sarvam"], secondary: "sarvam", requests: ["sarvam"] },
    { name: "Sarvam limit reached", sarvamStatus: 200, geminiStatus: 200, allowed: ["gemini-flash"], secondary: "gemini-flash", requests: ["gemini-flash"] },
    { name: "Sarvam credits exhausted", sarvamStatus: 402, geminiStatus: 200, allowed: ["sarvam", "gemini-flash"],
      secondary: "gemini-flash", requests: ["sarvam", "gemini-flash"] },
    { name: "both caps reached", sarvamStatus: 200, geminiStatus: 200, allowed: [], secondary: "nvidia-mistral", requests: ["nvidia-mistral"] },
    { name: "Gemini rate limited", sarvamStatus: 200, geminiStatus: 429, allowed: ["gemini-flash"],
      secondary: "nvidia-mistral", requests: ["gemini-flash", "nvidia-mistral"] },
  ]) {
    submissions.length = 0;
    sarvamStatus = scenario.sarvamStatus;
    geminiStatus = scenario.geminiStatus;
    const reservations: string[] = [];
    const result = await extract(pdf, "unseen.pdf", true, async (reader, page) => {
      assert.equal(page, 1);
      assert.ok(reader === "sarvam" || reader === "gemini-flash");
      reservations.push(reader);
      return scenario.allowed.includes(reader);
    });
    assert.deepEqual(reservations, scenario.secondary === "sarvam" ? ["sarvam"] : ["sarvam", "gemini-flash"], scenario.name);
    assert.deepEqual(submissions.filter(reader => reader !== "nvidia-super-vl"), scenario.requests, scenario.name);
    assert.deepEqual(submissions.filter(reader => reader === "nvidia-super-vl"), ["nvidia-super-vl"], scenario.name);
    assert.deepEqual(result.reader_failures, {}, scenario.name);
    assert.equal(result.fields.engine_cc.value, "998", scenario.name);
    assert.deepEqual(result.fields.engine_cc.evidence.map(item => item.reader).sort(),
      [scenario.secondary, "nvidia-super-vl"].sort(), scenario.name);
  }

  process.env.ARGUS_WRITE_OCR_CACHE = "1";
  const live = await extract(pdf, "unseen.pdf", true);
  assert.deepEqual(live.fields.engine_cc.evidence.map(item => item.reader).sort(), ["nvidia-mistral", "nvidia-super-vl"]);
  const originalCalls = transport.mock.callCount();
  const replay = await extract(pdf, "unseen.pdf", false);
  assert.equal(replay.fields.engine_cc.value, "998");
  assert.equal(transport.mock.callCount(), originalCalls);
});
