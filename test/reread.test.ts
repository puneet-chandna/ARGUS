import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { decide, type PageRead } from "../lib/ingestion/facts.ts";
import { cacheKey, EXTRACTION_VERSION, readLive } from "../lib/ingestion/providers.ts";
import { extract, previewPage, type Extraction, type RereadContext } from "../lib/ingestion/index.ts";
import { applyRating } from "../lib/report.ts";
import { targetedReread } from "../lib/reread.ts";
import { rebindExtraction, verifiedOcr } from "../lib/verified-ocr.ts";
import { syntheticPdf } from "./fixtures/pdf.ts";

const fields = { insurer: "Go Digit General Insurance Ltd.", policy_type: "Private Car SATP", rto: "UP78", fuel: "petrol", start_date: "2026-03-25" };
function reading(reader: PageRead["reader"], capacity?: string): PageRead {
  const candidates = Object.entries(fields).map(([field, value]) => ({ field: field as keyof typeof fields, value, quote: `${field.replaceAll("_", " ")}: ${value}`, box: null }));
  const quote = `Engine capacity: ${capacity ?? "1086"} cc`;
  return { reader, page: 1, model: reader, transcript: [...candidates.map(item => item.quote), quote].join("\n"),
    candidates: [...candidates, ...(capacity ? [{ field: "engine_cc" as const, value: capacity, quote, box: null }] : [])] };
}
function setup(reads = [reading("sarvam", "1086"), reading("nvidia-super-vl")]) {
  const extraction: Extraction = { filename: "synthetic.pdf", checksum: "f".repeat(64), extraction_version: EXTRACTION_VERSION,
    fields: decide("synthetic.pdf", reads), reader_failures: {}, clarifications: [] };
  const context: RereadContext = { reads, pageCount: 1, signal: new AbortController().signal,
    render: async () => Buffer.from("original rendered page"), haltedReaders: new Set() };
  let calls = 0, reservations = 0;
  const options = { allowCloud: true, available: (reader: PageRead["reader"]) => reader === "sarvam" || reader === "nvidia-super-vl",
    reserve: async () => { reservations++; return true; },
    read: async (reader: PageRead["reader"], page: number, image: Buffer, _signal: AbortSignal, requested: readonly string[]) => {
      calls++;
      assert.equal(image.toString(), "original rendered page");
      assert.deepEqual(requested, ["engine_cc"]);
      return { ...reading(reader, "1086"), page };
    } };
  return { extraction, context, options, count: () => ({ calls, reservations }) };
}

test("a targeted read corroborates the blocking fact, preserves originals and ignores unsolicited fields", async () => {
  const s = setup();
  assert.equal(applyRating(s.extraction).tp.status, "ambiguous");
  const result = await targetedReread(s.extraction, s.context, s.options);
  assert.equal(applyRating(result).tp.rate, "29.5");
  assert.deepEqual(s.count(), { calls: 1, reservations: 1 });
  assert.deepEqual(result.fields.fuel, s.extraction.fields.fuel);
  assert.ok(result.fields.engine_cc.evidence.some(item => item.reader === "sarvam"));
  assert.ok(result.fields.engine_cc.evidence.some(item => item.protocol?.includes("targeted")));
  const cache = verifiedOcr(applyRating(result));
  assert.ok(cache);
  assert.equal(rebindExtraction(cache.extraction, "renamed.pdf").fields.engine_cc.value, "1086");
  assert.ok(cache.extraction.reread);
});

test("same-reader retries cannot supply independent corroboration", async () => {
  const s = setup();
  const result = await targetedReread(s.extraction, s.context, { ...s.options, available: reader => reader === "sarvam" });
  assert.equal(result.fields.engine_cc.value, null);
  assert.equal(applyRating(result).tp.status, "ambiguous");
});

test("a quote-only observation grounded by its peer counts when selecting the independent retry", async () => {
  const sarvam = { ...reading("sarvam", "1086"), transcript: "", quoteOnly: true as const };
  const s = setup([sarvam, reading("nvidia-super-vl")]);
  let selected: PageRead["reader"] | undefined;
  const result = await targetedReread(s.extraction, s.context, { ...s.options, read: async (reader, page) => {
    selected = reader;
    return { ...reading(reader, "1086"), page };
  } });
  assert.equal(selected, "nvidia-super-vl");
  assert.equal(result.fields.engine_cc.value, "1086");
  assert.deepEqual(new Set(result.fields.engine_cc.evidence.map(source => source.reader)), new Set(["sarvam", "nvidia-super-vl"]));
});

test("an exhausted optional quota does not displace an equally independent NVIDIA reader", async () => {
  const s = setup();
  let quotaChecks = 0;
  const result = await targetedReread(s.extraction, s.context, { ...s.options,
    available: reader => ["sarvam", "gemini-flash", "nvidia-super-vl"].includes(reader),
    reserveGemini: async () => { quotaChecks++; return false; },
  });
  assert.equal(result.reread?.reader, "nvidia-super-vl");
  assert.equal(result.fields.engine_cc.value, "1086");
  assert.equal(quotaChecks, 0);
  assert.deepEqual(s.count(), { calls: 1, reservations: 1 });
});

test("quota denial before a send leaves the durable re-read allowance untouched", async () => {
  const s = setup();
  const result = await targetedReread(s.extraction, s.context, { ...s.options,
    available: reader => reader === "gemini-flash", reserveGemini: async () => false,
  });
  assert.deepEqual(s.count(), { calls: 0, reservations: 0 });
  assert.deepEqual(result, s.extraction);
});

test("grounded conflicts survive a third reading that agrees with one candidate", async () => {
  const s = setup([reading("sarvam", "998"), reading("nvidia-super-vl", "1086")]);
  const result = await targetedReread(s.extraction, s.context, { ...s.options, available: () => true, reserveGemini: async () => true });
  assert.equal(result.fields.engine_cc.reason, "conflicting_readings");
  assert.equal(result.fields.engine_cc.value, null);
  assert.ok(result.fields.engine_cc.evidence.some(item => item.raw === "998"));
  assert.ok(result.fields.engine_cc.evidence.some(item => item.raw === "1086"));
});

test("multiple blocking fields on one page share a single call", async () => {
  const second = reading("nvidia-super-vl");
  second.candidates = second.candidates.filter(item => !["insurer", "policy_type"].includes(item.field));
  const s = setup([reading("sarvam", "1086"), second]);
  let calls = 0;
  const result = await targetedReread(s.extraction, s.context, { ...s.options,
    read: async (reader, page, _image, _signal, fields) => {
      calls++;
      assert.deepEqual([...fields].sort(), ["insurer", "policy_type"]);
      return { ...reading(reader, "1086"), page };
    } });
  assert.equal(calls, 1);
  assert.equal(result.fields.insurer.status, "accepted");
  assert.equal(result.fields.policy_type.status, "accepted");
  assert.equal(result.fields.engine_cc.value, null);
});

test("grounded candidates outrank policy boilerplate when choosing the only page", async () => {
  const initial = reading("sarvam", "1086"); initial.page = 2;
  const other = { ...reading("nvidia-super-vl", "1086"), page: 2 };
  other.candidates = other.candidates.filter(item => item.field !== "policy_type");
  const s = setup([{ ...reading("sarvam"), page: 1, transcript: "Please quote the policy number in correspondence.", candidates: [] }, initial, other]);
  s.context.pageCount = 2;
  let selected: number | undefined;
  await targetedReread(s.extraction, s.context, { ...s.options, read: async (reader, page) => {
    selected = page;
    return { ...reading(reader, "1086"), page };
  } });
  assert.equal(selected, 2);
});

test("independent issue-date quotes cannot become an accepted policy start", async () => {
  const first = reading("sarvam", "1086");
  first.candidates = first.candidates.filter(item => item.field !== "start_date");
  first.candidates.push({ field: "start_date", value: "2026-03-25", quote: "Issue Date: 2026-03-25", box: null });
  first.transcript += "\nPeriod of insurance from: 2026-02-14\nIssue Date: 2026-03-25";
  const second = reading("nvidia-super-vl", "1086");
  second.candidates = second.candidates.filter(item => item.field !== "start_date");
  const s = setup([first, second]);
  const result = await targetedReread(s.extraction, s.context, { ...s.options, read: async (reader, page) => ({
    reader, page, model: "test", transcript: "Issue Date: 2026-03-25",
    candidates: [{ field: "start_date", value: "2026-03-25", quote: "Issue Date: 2026-03-25", box: null }],
  }) });
  assert.equal(result.fields.start_date.value, null);
  assert.equal(applyRating(result).tp.rate, null);
});

test("resolved, excluded, external-only and unlocatable blockers make no re-read call", async () => {
  const resolved = setup([reading("sarvam", "1086"), reading("nvidia-super-vl", "1086")]);
  await targetedReread(resolved.extraction, resolved.context, resolved.options);
  assert.deepEqual(resolved.count(), { calls: 0, reservations: 0 });
  const excluded = setup();
  excluded.extraction.fields.rto = { ...excluded.extraction.fields.rto, value: "XX99" };
  await targetedReread(excluded.extraction, excluded.context, excluded.options);
  assert.deepEqual(excluded.count(), { calls: 0, reservations: 0 });
  const missing = setup();
  missing.context.reads = [];
  missing.extraction.fields.engine_cc.evidence = [];
  await targetedReread(missing.extraction, missing.context, missing.options);
  assert.deepEqual(missing.count(), { calls: 0, reservations: 0 });
  const external = setup();
  external.extraction.fields = Object.fromEntries(Object.entries({ insurer: "HDFC ERGO", policy_type: "Private Car Package Policy",
    start_date: "2026-03-25", rto: "HR26", fuel: "diesel", current_ncb: "35" }).map(([field, value]) =>
    [field, { value, status: "accepted", reason: "independent_agreement", evidence: [] }]));
  await targetedReread(external.extraction, external.context, external.options);
  assert.deepEqual(external.count(), { calls: 0, reservations: 0 });
});

test("consent, durable reservation and deadline gate the provider call", async () => {
  const s = setup();
  await targetedReread(s.extraction, s.context, { ...s.options, allowCloud: false });
  assert.deepEqual(s.count(), { calls: 0, reservations: 0 });
  await targetedReread(s.extraction, s.context, { ...s.options, reserve: async () => false });
  assert.equal(s.count().calls, 0);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(targetedReread(s.extraction, { ...s.context, signal: controller.signal }, s.options));
  assert.equal(s.count().calls, 0);
});

test("failed or ungrounded re-reads preserve the initial decisions", async () => {
  const s = setup();
  for (const read of [async () => { throw new Error("unavailable"); }, async () => ({ ...reading("nvidia-super-vl", "1086"), transcript: "unreadable" })]) {
    const result = await targetedReread(s.extraction, s.context, { ...s.options, read });
    assert.deepEqual(result.fields, s.extraction.fields);
  }
});

test("deadline exhaustion preserves the initial result and cancellation rejects the enrichment", async () => {
  for (const cancel of [false, true]) {
    const s = setup();
    const deadline = new AbortController(), cancellation = new AbortController();
    const pending = targetedReread(s.extraction, { ...s.context, signal: deadline.signal, cancelledSignal: cancellation.signal }, {
      ...s.options, read: async () => {
        (cancel ? cancellation : deadline).abort();
        throw new Error("aborted");
      },
    });
    if (cancel) await assert.rejects(pending);
    else assert.deepEqual((await pending).fields, s.extraction.fields);
  }
});

test("ingestion enriches from the same rendered page while full-page cached reads stay intact", async t => {
  const directory = await mkdtemp(join(tmpdir(), "argus-reread-"));
  const previous = process.env.ARGUS_OCR_CACHE_DIR;
  process.env.ARGUS_OCR_CACHE_DIR = directory;
  t.after(async () => {
    if (previous === undefined) delete process.env.ARGUS_OCR_CACHE_DIR; else process.env.ARGUS_OCR_CACHE_DIR = previous;
    await rm(directory, { recursive: true, force: true });
  });
  t.mock.method(globalThis, "fetch", () => { throw new Error("unexpected network request"); });
  const pdf = syntheticPdf("Synthetic motor schedule - engine capacity 1086 cc");
  const image = await previewPage(pdf, 1);
  assert.ok(image);
  for (const read of [reading("sarvam", "1086"), reading("nvidia-super-vl")]) {
    const payload = { transcript: read.transcript, fields: read.candidates };
    await writeFile(join(directory, `${cacheKey(read.reader, image)}.json`), JSON.stringify(read.reader === "sarvam" ? payload :
      { choices: [{ finish_reason: "stop", message: { content: JSON.stringify(payload) } }] }));
  }
  let calls = 0;
  const result = await extract(pdf, "synthetic.pdf", false, undefined, undefined, undefined, new AbortController().signal,
    (initial, context) => targetedReread(initial, context, { allowCloud: true, available: reader => reader === "nvidia-super-vl",
      reserve: async () => true, read: async (reader, page, original) => {
        calls++;
        assert.deepEqual(original, image);
        return { ...reading(reader, "1086"), page };
      } }));
  assert.equal(applyRating(result).tp.rate, "29.5");
  assert.equal(calls, 1);
  assert.equal((await readdir(directory)).length, 2);
});

test("targeted provider prompt omits competing values and leaves full-page cache entries untouched", async () => {
  const priorFetch = globalThis.fetch, key = process.env.NVIDIA_API_KEY;
  process.env.NVIDIA_API_KEY = "stubbed-key";
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    const prompt = body.messages[0].content[0].text;
    assert.match(prompt, /Read only the requested fields/);
    assert.match(prompt, /basic_od_premium/);
    assert.match(prompt, /Basic OD/);
    assert.ok(!prompt.includes("1086"));
    assert.deepEqual(body.response_format.json_schema.schema.properties.fields.items.properties.field.enum, ["basic_od_premium"]);
    return Response.json({ model: "nvidia/nemotron-3.5-super-vl-120b-a12b", choices: [{ finish_reason: "stop", message: { content: JSON.stringify({
      transcript: "Basic OD Premium: 3000", fields: [{ field: "basic_od_premium", value: "3000", quote: "Basic OD Premium: 3000" },
        { field: "fuel", value: "diesel", quote: "Fuel: diesel" }],
    }) } }] });
  };
  try {
    const read = await readLive("nvidia-super-vl", 1, Buffer.from("image"), new AbortController().signal, ["basic_od_premium"]);
    assert.deepEqual(read.candidates.map(item => item.field), ["basic_od_premium"]);
    assert.match(read.protocol!, /targeted/);
  } finally {
    globalThis.fetch = priorFetch;
    if (key === undefined) delete process.env.NVIDIA_API_KEY; else process.env.NVIDIA_API_KEY = key;
  }
});
