import assert from "node:assert/strict";
import test from "node:test";
import { EXTRACTION_VERSION } from "../lib/ingestion/providers.ts";
import { decide, type Extraction, type PageRead } from "../lib/ingestion/index.ts";
import { applyRating } from "../lib/report.ts";
import { mergeOcrRetry } from "../lib/retry-ocr.ts";
import { startAnalysis } from "../lib/run-analysis.ts";
import { present, type runStore, type StoredRun } from "../lib/runs.ts";
import { rebindExtraction, verifiedOcr } from "../lib/verified-ocr.ts";

test("a saved report offers OCR retry only with consent, reader failures and an available original", () => {
  const result = applyRating({ filename: "synthetic.pdf", checksum: "a".repeat(64), extraction_version: EXTRACTION_VERSION,
    reader_failures: { 1: { sarvam: "provider_timeout" } }, fields: {}, clarifications: [] });
  const run = { status: "complete", allow_cloud: true, result } as StoredRun;
  assert.equal(present(run).can_retry_ocr, true);
  for (const unavailable of [
    { allow_cloud: false }, { pdf_deleted_at: "2026-01-01" }, { pdf_cleanup_pending: true },
    { deleting_at: "2026-01-01" }, { ocr_retry_attempted_at: "2026-01-01" },
    { result: { ...result, reader_failures: {} } }, { status: "processing" as const },
    { result: { ...result, status: "resolved" as const } },
    { result: { ...result, status: "unsupported" as const } },
    { result: { ...result, blockers: [{ ...result.blockers[0], kind: "external_fact" as const,
      fields: ["eligible_private_car_gwp"] }] } },
    { result: { ...result, fields: { start_date: { reason: "confirmed_by_reviewer", status: "confirmed_by_reviewer" as const,
      value: "2026-01-01", evidence: [] } }, blockers: [{ ...result.blockers[0], fields: ["start_date"] }] } },
  ]) assert.equal(present({ ...run, ...unavailable }).can_retry_ocr, false);
});

test("an unavailable reader leaves the retry unclaimed", async () => {
  const key = process.env.NVIDIA_API_KEY;
  delete process.env.NVIDIA_API_KEY;
  try {
    const result = applyRating({ filename: "unavailable.pdf", checksum: "e".repeat(64), extraction_version: EXTRACTION_VERSION,
      reader_failures: { 1: { sarvam: "provider_timeout" } }, fields: {}, clarifications: [] });
    const run = { status: "complete", allow_cloud: true, result } as StoredRun;
    const store = { claimOcrRetry: () => assert.fail("An unavailable retry must not claim the run.") } as unknown as ReturnType<typeof runStore>;
    await assert.rejects(startAnalysis(store, run, undefined, undefined, true), {
      status: 503, message: "OCR readers are unavailable. Try the saved PDF again later.",
    });
  } finally {
    if (key !== undefined) process.env.NVIDIA_API_KEY = key;
  }
});

test("retry keeps accepted readings and confirmations, surfaces conflicts, and never combines weak observations into acceptance", () => {
  const filename = "synthetic.pdf";
  const prior: Extraction = { filename, checksum: "b".repeat(64), extraction_version: EXTRACTION_VERSION,
    reader_failures: { 1: { sarvam: "provider_timeout" } }, fields: {}, clarifications: [] };
  const makeRead = (reader: PageRead["reader"], engine: string, classEvidence = true): PageRead => {
    const candidates: PageRead["candidates"] = [
      { field: "engine_cc", value: engine, quote: `Engine capacity: ${engine} cc`, box: null },
      { field: "fuel", value: "Petrol", quote: "Fuel type: Petrol", box: null },
    ];
    if (classEvidence) candidates.push({ field: "vehicle_class", value: "Private car", quote: "Vehicle class: Private car", box: null });
    return { reader, page: 1, model: "test", transcript: candidates.map(x => x.quote).join("\n"), candidates };
  };
  const [sarvam, nvidia] = [makeRead("sarvam", "1086"), makeRead("nvidia-super-vl", "1086")];
  const first = decide(filename, [sarvam, { ...nvidia, candidates: nvidia.candidates.filter(c => c.field !== "fuel") }]);
  const next = decide(filename, [makeRead("nvidia-super-vl", "998", false)]);
  const confirmation = { field: "eligible_private_car_gwp", value: "3500000", raw: "3500000", file: "Brokerage ledger", type: "reviewer_confirmation" } as const;
  const previous = { ...prior, fields: { ...first, eligible_private_car_gwp: { ...first.eligible_private_car_gwp,
    status: "confirmed_by_reviewer" as const, confirmation, value: confirmation.value } }, clarifications: [confirmation] };
  const fresh = { ...prior, fields: next, reader_failures: { 1: { "nvidia-super-vl": "provider_timeout" } } };
  const merged = mergeOcrRetry(previous, fresh);
  assert.equal(merged.fields.vehicle_class.status, "accepted");
  assert.deepEqual(merged.fields.vehicle_class.evidence, previous.fields.vehicle_class.evidence);
  assert.equal(merged.fields.engine_cc.reason, "conflicting_readings");
  assert.equal(merged.fields.engine_cc.value, null);
  assert.deepEqual(new Set(merged.fields.engine_cc.evidence.map(source => source.raw)), new Set(["1086", "998"]));
  assert.equal(merged.fields.fuel.status, "needs_review");
  assert.equal(merged.fields.fuel.evidence.length, 2);
  assert.deepEqual(merged.reader_failures, fresh.reader_failures);
  assert.deepEqual(merged.clarifications, [confirmation]);
  assert.deepEqual(merged.fields.eligible_private_car_gwp.confirmation, confirmation);
  const stableConflict = mergeOcrRetry(merged, { ...fresh, fields: first, reader_failures: {} });
  assert.equal(stableConflict.fields.engine_cc.reason, "conflicting_readings");
  assert.equal(stableConflict.fields.engine_cc.evidence.length, 3);
  const recovered = mergeOcrRetry(previous, { ...fresh, fields: decide(filename, [sarvam, nvidia]), reader_failures: {} });
  assert.equal(recovered.fields.fuel.status, "accepted");
  assert.equal(recovered.fields.fuel.value, "petrol");
  assert.deepEqual(recovered.reader_failures, {});
});

test("a stale issue date stays in the audit evidence without disputing a corroborated coverage start", () => {
  const filename = "digit-coverage.pdf";
  const facts = { insurer: "Go Digit", policy_type: "Private Car SATP", rto: "UP78", fuel: "petrol", engine_cc: "1086" };
  const fields = Object.fromEntries(Object.entries(facts).map(([field, value]) =>
    [field, { value, status: "accepted" as const, reason: "source_verified", evidence: [] }]));
  const candidate = { field: "start_date", value: "2026-03-25", quote: "Coverage start date: 2026-03-25", box: null } as const;
  const reads: PageRead[] = (["sarvam", "nvidia-super-vl"] as const).map(reader =>
    ({ page: 1, reader, model: "test", transcript: candidate.quote, candidates: [candidate] }));
  const [first] = reads;
  const issue = { file: filename, page: 1, reader: first.reader, model: first.model, box: null,
    raw: "2026-03-20", quote: "Policy issue date: 2026-03-20" };
  const fresh = { filename, checksum: "d".repeat(64), extraction_version: EXTRACTION_VERSION,
    reader_failures: {}, clarifications: [], fields: { ...fields, start_date: decide(filename, reads).start_date } };
  const previous = applyRating({ ...fresh, extraction_version: "legacy", reader_failures: { 1: { sarvam: "provider_timeout" } },
    fields: { ...fields, start_date: { value: issue.raw, status: "accepted", reason: "independent_agreement", evidence: [issue] } } });
  assert.equal(previous.fields.start_date.status, "needs_review");
  assert.equal(applyRating(fresh).tp.rate, "29.5");
  const report = applyRating(mergeOcrRetry(previous, fresh));
  assert.equal(report.tp.rate, "29.5");
  assert.equal(report.fields.start_date.value, candidate.value);
  assert.deepEqual(report.fields.start_date.rejected_evidence, [issue]);
  assert.deepEqual(report.fields.start_date.evidence, fresh.fields.start_date.evidence);
  assert.ok(report.trace.every(step => !step.sources.some(source => "quote" in source && source.quote === issue.quote)));
  assert.equal(rebindExtraction(report, "reopened.pdf").fields.start_date.rejected_evidence?.[0].file, "reopened.pdf");
  const cache = verifiedOcr({ ...report, extraction_version: EXTRACTION_VERSION });
  assert.ok(cache);
  assert.ok(cache.grounded_text.every(source => source.text !== issue.quote));
  assert.equal(cache.extraction.fields.start_date.rejected_evidence, undefined);
});
