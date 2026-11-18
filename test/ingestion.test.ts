import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { canonical, decide, extract, type PageRead } from "../lib/ingestion/index.ts";
import { grounded, type Candidate } from "../lib/ingestion/facts.ts";
import { cacheKey, readLive } from "../lib/ingestion/providers.ts";
import { syntheticPdf } from "./fixtures/pdf.ts";

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

test("a quote-only reading needs an independent same-page transcript", () => {
  const sarvam = { ...read("sarvam", 11, "998"), transcript: "", quoteOnly: true as const };
  const peer = read("nvidia-super-vl", 11, "998");
  assert.equal(decide("source.pdf", [sarvam, peer]).engine_cc.value, "998");
  assert.equal(decide("source.pdf", [sarvam, {...peer, page: 12}]).engine_cc.value, null);
  assert.equal(decide("source.pdf", [sarvam, {...peer, candidates: []}]).engine_cc.value, null);
  assert.equal(decide("source.pdf", [sarvam, {...peer, transcript: ""}]).engine_cc.value, null);
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

test("RTO location punctuation spacing does not trigger a false OCR conflict", () => {
  const reads = (["sarvam", "nvidia-super-vl"] as const).map((reader, i) => {
    const value = i === 0 ? "Kanpur Nagar, UTTAR PRADESH" : "Kanpur Nagar,UTTAR PRADESH";
    const quote = `RTO Location ${value}`;
    return { reader, model: reader, page: 1, transcript: quote,
      candidates: [{ field: "rto_location" as const, value, quote, box: null }] };
  });
  const result = decide("source.pdf", reads).rto_location;
  assert.equal(result.value, "kanpur nagar, uttar pradesh");
  assert.equal(result.evidence.length, 2);
});

test("RTO location needs a registration authority label and vehicle class excludes policy titles", () => {
  const valid = (field: Candidate["field"], value: string, quote: string) =>
    grounded({ field, value, quote, box: null }, quote);
  assert.ok(valid("rto_location", "Delhi", "RTO Location: Delhi"));
  assert.ok(!valid("rto_location", "Delhi", "Address for Communication: New Delhi"));
  assert.ok(!valid("rto_location", "Mumbai", "Place of issue: Mumbai"));
  assert.ok(!valid("vehicle_class", "Auto Secure - Liability Only Policy", "Auto Secure - Liability Only Policy"));
});

test("transcribed registrations and current premium NCB work across policies", () => {
  for (const [plate, rto] of [["MH-12-AB-0123", "MH12"], ["UP 78 CC 9844", "UP78"], ["DL 1C AA 1234", "DL1C"]]) {
    const reads: PageRead[] = (["sarvam", "nvidia-super-vl"] as const).map((reader, i) => ({
      reader, page: i + 1, model: "test",
      transcript: `Vehicle Registration No: ${plate}\nLess: No Claim Bonus (35%) 852\nNCB 25%`,
      candidates: [{ field: "current_ncb", value: "25", quote: "NCB 25%", box: null }],
    }));
    const result = decide("unseen.pdf", reads);
    assert.equal(result.rto.value, rto);
    assert.equal(result.current_ncb.value, "35");
    assert.equal(decide("unseen.pdf", reads.slice(0, 1)).rto.value, null);
    const different = { ...reads[1], transcript: reads[1].transcript.replace("35%", "45%") };
    assert.equal(decide("unseen.pdf", [reads[0], different]).current_ncb.reason, "conflicting_readings");
  }
});

test("previous-policy deductions cannot override the current NCB", () => {
  const prior = "Less: No Claim Bonus (25%)";
  const current = "No Claim Bonus 0%";
  const reads: PageRead[] = (["sarvam", "nvidia-super-vl"] as const).map(reader => ({
    reader, model: reader, page: 1,
    transcript: `Current Policy Premium\n${current}\nPrevious Insurance Details\n${prior} 200`,
    candidates: [{ field: "current_ncb", value: "0", quote: current, box: null }],
  }));
  const decision = decide("unseen.pdf", reads).current_ncb;
  assert.equal(decision.value, "0");
  assert.ok(decision.evidence.every(source => source.quote === current));
  assert.equal(grounded({ field: "current_ncb", value: "25", quote: prior, box: null }, reads[0].transcript), false);
  const reopened = reads.map(reading => ({ ...reading, transcript: `Previous Insurance Details\n${prior}\nCurrent Policy Premium\n${current}` }));
  assert.equal(decide("unseen.pdf", reopened).current_ncb.value, "0");
  for (const heading of ["3. Previous Insurance Details", "Previous Policy Details (if applicable)", "Previous Insurance Details |",
    "II. Previous Insurance Details", "## Previous Insurance Details", "Previous Insurer Details", "Previous Policy No: 4501000"]) {
    const decorated = reads.map(reading => ({ ...reading, transcript: reading.transcript.replace("Previous Insurance Details", heading) }));
    assert.equal(decide("unseen.pdf", decorated).current_ncb.value, "0", heading);
  }
});

test("NCB readings need a printed percentage unit", () => {
  for (const field of ["current_ncb", "previous_ncb"] as const) {
    const label = field === "current_ncb" ? "NCB" : "Previous NCB";
    for (const suffix of [": 35%", " percentage: 35", " (%) | 35", ": 35 per cent"]) {
      const quote = label + suffix;
      assert.ok(grounded({ field, value: "35", quote, box: null }, quote), quote);
    }
    for (const suffix of [": 35", " discount: ₹35", " amount (Rs): 35", " percentage: INR 35"]) {
      const quote = label + suffix;
      assert.equal(grounded({ field, value: "35", quote, box: null }, quote), false, quote);
    }
  }
  assert.equal(canonical("current_ncb", "₹35"), null);
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
  assert.equal(valid("rto", "DL1C", "Registration No: DL 1C AA 1234"), true);
  assert.equal(valid("rto", "DL1", "Registration No: DL 1C AA 1234"), false);
  assert.equal(valid("rto", "DL14", "Registration No: DL14CAA1234"), false);
  assert.equal(valid("rto", "DL14C", "Registration No: DL14CAA1234"), false);
  assert.equal(valid("rto", "DL14C", "RTO: DL14C"), true);
  assert.equal(valid("rto", "DL1C", "| Registration No | DL 1 C AA 1234 |"), true);
  assert.equal(valid("rto", "DL1", "| Registration No | DL 1 C AA 1234 |"), false);
  assert.equal(valid("rto", "DL1", "Registration Mark: DL 1 C AA 1234"), false);
  assert.equal(valid("rto", "DL14C", "| Registration No | DL14CAA1234 |"), false);
  assert.equal(valid("rto", "DL1C", "RTO / Regn No: DL 1 C AA 1234"), true);
  assert.equal(valid("rto", "DL1", "RTO / Regn No: DL 1 C AA 1234"), false);
  assert.equal(valid("rto", "DL14", "RTO / Regn No: DL14CAA1234"), false);
  assert.equal(valid("rto", "DL14C", "RTO: DL14CAA1234"), false);
  assert.equal(valid("rto", "DL14C", "| RTO Code | DL 14C |"), true);
});

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
  const progress: [number, number][] = [];
  const replay = await extract(pdf, "unseen.pdf", false, undefined, async (completed, total) => {
    progress.push([completed, total]);
  });
  assert.deepEqual(progress, [[0, 1], [1, 1]]);
  assert.equal(replay.fields.engine_cc.value, "998");
  assert.equal(replay.fields.engine_cc.evidence.length, 2);
  assert.deepEqual(replay.reader_failures, {});
  assert.equal(fetch.mock.callCount(), 0);
});

test("OCR tries Sarvam first and only reserves Gemini quota", async t => {
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
  let sarvamQuoteOnly = false;
  let sarvamQuoteMismatch = false;
  let waitForPeers = false;
  let arrivals = 0;
  const peers = Promise.withResolvers<void>();
  const transport = t.mock.method(globalThis, "fetch", async (url: string, options: RequestInit) => {
    assert.equal(options.redirect, "error");
    if (url.endsWith("/extract")) {
      assert.ok(options.body instanceof FormData);
      assert.ok(options.body.get("file") instanceof File);
      submissions.push("sarvam");
      return Response.json({job_id: "synthetic-job", status: "completed"}, {status: sarvamStatus});
    }
    if (url.endsWith("/results")) {
      const reading = sarvamQuoteMismatch
        ? { value: "777", quote: "Engine capacity: 777 cc" }
        : { value: "998", quote: transcript };
      return Response.json({result: {transcript: sarvamQuoteOnly ? null : transcript, fuel: "unreadable",
        engine_cc: [null, {value: null, quote: null}, reading]}});
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
      if (waitForPeers) {
        if (++arrivals === 3) peers.resolve();
        await peers.promise;
      }
    } else {
      assert.equal(payload.model, "mistralai/mistral-large-4-1t-a52b");
      assert.equal(payload.reasoning_effort, undefined);
      submissions.push("nvidia-mistral");
    }
    return Response.json({model: payload.model, choices: [{finish_reason: "stop", message: {content: JSON.stringify(response)}}]});
  });

  const pdf = syntheticPdf(transcript);
  for (const scenario of [
    { name: "Sarvam works", sarvamStatus: 200, geminiStatus: 200, geminiAvailable: false,
      secondary: "sarvam", requests: ["sarvam"] },
    { name: "Sarvam returned a quote without a transcript", sarvamStatus: 200, quoteOnly: true, geminiStatus: 200, geminiAvailable: false,
      secondary: "sarvam", requests: ["sarvam"] },
    { name: "Sarvam returned an uncorroborated quote", sarvamStatus: 200, quoteOnly: true, quoteMismatch: true, geminiStatus: 200, geminiAvailable: true,
      secondary: "gemini-flash", requests: ["sarvam", "gemini-flash"] },
    { name: "Sarvam credits exhausted", sarvamStatus: 402, geminiStatus: 200, geminiAvailable: true,
      secondary: "gemini-flash", requests: ["sarvam", "gemini-flash"] },
    { name: "Gemini daily cap reached", sarvamStatus: 402, geminiStatus: 200, geminiAvailable: false,
      secondary: "nvidia-mistral", requests: ["sarvam", "nvidia-mistral"] },
    { name: "Gemini rate limited", sarvamStatus: 402, geminiStatus: 429, geminiAvailable: true,
      secondary: "nvidia-mistral", requests: ["sarvam", "gemini-flash", "nvidia-mistral"] },
  ]) {
    submissions.length = 0;
    sarvamStatus = scenario.sarvamStatus;
    geminiStatus = scenario.geminiStatus;
    sarvamQuoteOnly = scenario.quoteOnly ?? false;
    sarvamQuoteMismatch = scenario.quoteMismatch ?? false;
    const reservations: number[] = [];
    const result = await extract(pdf, "unseen.pdf", true, async page => {
      reservations.push(page);
      return scenario.geminiAvailable;
    });
    assert.deepEqual(reservations, scenario.secondary === "sarvam" ? [] : [1], scenario.name);
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

  sarvamStatus = 200;
  const recovered = await extract(pdf, "unseen.pdf", true);
  assert.deepEqual(recovered.fields.engine_cc.evidence.map(item => item.reader).sort(), ["nvidia-super-vl", "sarvam"]);

  process.env.ARGUS_WRITE_OCR_CACHE = "0";
  const checked: number[] = [];
  const active: (number | undefined)[] = [];
  waitForPeers = true;
  const timer = setTimeout(() => peers.reject(new Error("Expected three concurrent page reads")), 5000);
  const multi = await extract(syntheticPdf("First", "Second", "Third", "Fourth"), "multi.pdf", true, undefined,
    async (completed, _total, event) => {
      checked.push(completed);
      active.push(event.page);
      assert.equal(new Set(event.completedPages).size, completed);
      assert.ok(!event.page || !event.completedPages.includes(event.page));
    }).finally(() => clearTimeout(timer));
  assert.deepEqual([...new Set(checked)], [0, 1, 2, 3, 4]);
  assert.equal(active[0], 1);
  assert.equal(active.at(-1), undefined);
  assert.deepEqual(multi.reader_failures, {});
  assert.equal(arrivals, 4);
});

test("Super VL preserves grounded fields when a response includes missing or malformed candidates", async t => {
  const oldKey = process.env.NVIDIA_API_KEY;
  const oldCache = process.env.ARGUS_WRITE_OCR_CACHE;
  process.env.NVIDIA_API_KEY = "test";
  process.env.ARGUS_WRITE_OCR_CACHE = "0";
  t.after(() => {
    if (oldKey === undefined) delete process.env.NVIDIA_API_KEY;
    else process.env.NVIDIA_API_KEY = oldKey;
    if (oldCache === undefined) delete process.env.ARGUS_WRITE_OCR_CACHE;
    else process.env.ARGUS_WRITE_OCR_CACHE = oldCache;
  });
  const transcript = "Engine capacity: 998 cc";
  const valid = { field: "engine_cc", value: "998", quote: transcript };
  const bad = { field: "fuel", value: null, quote: null };
  let fields: unknown[] = [bad, valid, { field: "engine_cc", value: 999, quote: "Engine capacity: 999 cc" }];
  t.mock.method(globalThis, "fetch", async (_url: string, init: RequestInit) => {
    const payload = JSON.parse(String(init.body));
    assert.equal(payload.stream, false);
    assert.equal(payload.response_format.type, "json_schema");
    return Response.json({
      model: "private/nvidia/nemotron-3.5-super-120b-a12b",
      choices: [{ finish_reason: "stop", message: { content: JSON.stringify({ transcript, fields }) } }],
    });
  });
  const result = await readLive("nvidia-super-vl", 1, Buffer.from("image"), AbortSignal.timeout(5000));
  assert.deepEqual(result.candidates, [{...valid, box: null}]);
  fields = [{ field: "engine_cc", value: 999, quote: "Engine capacity: 999 cc" }];
  await assert.rejects(readLive("nvidia-super-vl", 1, Buffer.from("image"), AbortSignal.timeout(5000)), /invalid_provider_response/);
});

test("independent fuel labels can agree across different pages without promoting partial OCR", () => {
  const quote = "Fuel Type: CNG";
  const reads = [
    { reader: "sarvam" as const, page: 4, model: "test", transcript: quote,
      candidates: [{ field: "fuel" as const, quote, value: "CNG", box: null }] },
    { reader: "nvidia-super-vl" as const, page: 11, model: "test", transcript: quote,
      candidates: [{ field: "fuel" as const, quote, value: "CNG", box: null }] },
  ];
  assert.equal(decide("policy.pdf", reads).fuel.value, "cng");
  assert.equal(decide("policy.pdf", reads, false).fuel.value, null);
  assert.equal(decide("policy.pdf", [reads[0], { ...reads[1], reader: "sarvam" }]).fuel.value, null);
});

test("a previous-insurance section grounds its insurer while unrelated headings do not", () => {
  const value = "TATA AIG GENERAL INSURANCE CO. LTD.";
  const quote = `Name of the Insurer: ${value}`;
  const candidate = { field: "previous_insurer" as const, value, quote, box: null };
  assert.ok(grounded(candidate, `Previous Insurance Details:\n${quote}`));
  assert.ok(!grounded(candidate, `Proposed Insurance Details:\n${quote}`));
  assert.ok(!grounded(candidate, `Previous Insurance Details:\nNominee Details:\n${quote}`));
  assert.ok(!grounded({ ...candidate, field: "insurer" }, `Previous Insurance Details:\n${quote}`));
  const prior = `II. Previous Insurance Details:\nPolicy number: 12345\nPeriod of cover: 2025\n${quote}`;
  assert.ok(grounded(candidate, prior));
  assert.ok(!grounded({ ...candidate, field: "insurer" }, prior));
  assert.ok(!grounded({ ...candidate, field: "insurer", quote: value }, prior));
  const reads: PageRead[] = [
    { reader: "sarvam", model: "test", page: 1, transcript: prior, candidates: [{ ...candidate, field: "insurer", quote: value }] },
    { reader: "nvidia-super-vl", model: "test", page: 1, transcript: value, candidates: [{ ...candidate, field: "insurer", quote: value }] },
  ];
  assert.equal(decide("policy.pdf", reads).insurer.value, null);
  assert.ok(grounded({ ...candidate, field: "insurer", quote: value }, prior + `\nCurrent Policy Details:\n${value}`));
});

test("an inline previous policy reference does not start a section", () => {
  const quote = "Policy Start Date: 2026-03-25";
  const start = { field: "start_date" as const, value: "2026-03-25", quote, box: null };
  const transcript = `Current Policy Schedule\nPrevious Policy Number: XYZ\n${quote}`;
  const reads: PageRead[] = (["sarvam", "nvidia-super-vl"] as const).map(reader => ({
    reader, model: "test", page: 1, transcript, candidates: [start],
  }));
  assert.equal(decide("policy.pdf", reads).start_date.value, "2026-03-25");
  assert.equal(grounded(start, `Previous Policy Details:\n${quote}`), false);
});
