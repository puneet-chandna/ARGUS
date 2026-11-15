import assert from "node:assert/strict";
import test from "node:test";
import { EXTRACTION_VERSION } from "../lib/ingestion/providers.ts";
import type { Report } from "../lib/report.ts";
import { rebindExtraction, verifiedOcr } from "../lib/verified-ocr.ts";

test("durable OCR stores grounded quotes and rebases citations for identical renamed bytes", () => {
  const evidence = (reader: "sarvam" | "nvidia-super-vl") => ({
    reader, file: "old.pdf", page: 1, quote: "Fuel: Petrol", raw: "Petrol", model: "test", box: null,
  });
  const part = { applicable: true, rate: "1", status: "resolved", reason: "test" } as const;
  const clean: Report = {
    status: "resolved", od: part, tp: part, trace: [], rule_version: "test", business_type: null,
    confidence: { level: "high", reason: "test" },
    filename: "old.pdf", checksum: "a".repeat(64), extraction_version: EXTRACTION_VERSION,
    reader_failures: {}, clarifications: [],
    fields: {
      fuel: { value: "petrol", reason: "independent_agreement", status: "accepted", evidence: [evidence("sarvam"), evidence("nvidia-super-vl")] },
      make: { value: null, reason: "insufficient_agreement", status: "needs_review", evidence: [] },
    },
  };
  const cache = verifiedOcr(clean);
  assert.ok(cache);
  assert.deepEqual(cache.grounded_text, [{page: 1, text: "Fuel: Petrol"}]);
  assert.ok(!("od" in cache.extraction));
  assert.ok(rebindExtraction(cache.extraction, "renamed.pdf").fields.fuel.evidence.every(source => source.file === "renamed.pdf"));
  assert.equal(verifiedOcr({ ...clean, status: "ambiguous" }), null);
  assert.equal(verifiedOcr({ ...clean, reader_failures: { 2: { sarvam: "http_429" } } }), null);
  assert.equal(verifiedOcr({ ...clean, fields: {
    ...clean.fields, make: { ...clean.fields.make, reason: "conflicting_readings", evidence: [evidence("sarvam")] },
  } }), null);
});
