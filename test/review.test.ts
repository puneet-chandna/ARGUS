import assert from "node:assert/strict";
import test from "node:test";
import { canonical, decide, type PageRead } from "../lib/ingestion/index.ts";
import { applyRating, clarifyBatch, type Report } from "../lib/report.ts";
import { confirmationError, conflictFields, requiredReviewFields, reviewFields } from "../lib/review-fields.ts";

function clarify(report: Report, input: {field: string; value: string; page: number}, pages: number) {
  return clarifyBatch(report, [input], pages);
}

test("a source-cited review resolves an OCR conflict and retains both readings", () => {
  const filename = "digit.pdf";
  const read = (reader: PageRead["reader"], value: string): PageRead => {
    const quote = `Engine capacity: ${value} cc`;
    return { reader, page: 1, transcript: quote, model: reader, candidates: [{ field: "engine_cc", value, quote, box: null }] };
  };
  const report = applyRating({
    filename, checksum: "a".repeat(64), extraction_version: "test", reader_failures: {},
    fields: decide(filename, [read("sarvam", "998"), read("nvidia-super-vl", "1086")]), clarifications: [],
  });
  assert.equal(reviewFields(report)[0], "engine_cc");
  const basics = Object.entries({
    policy_type: "Liability Only Policy", insurer: "Go Digit", vehicle_class: "private car",
    fuel: "petrol", rto: "UP78",
  }).map(([field, value]) => ({field, value, page: 1}));
  assert.equal(report.status, "ambiguous");
  assert.throws(() => clarify(report, { field: "engine_cc", value: "1,086 cc", page: 2 }, 1));
  assert.equal(canonical("engine_cc", "1,086 cc"), "1086");
  const confirmed = clarifyBatch(report, [...basics, { field: "engine_cc", value: "1,086 cc", page: 1 }], 1);
  assert.equal(confirmed.status, "resolved");
  assert.equal(confirmed.tp.rate, "29.5");
  assert.equal(confirmed.od.applicable, false);
  assert.equal(confirmed.fields.engine_cc.confirmation?.page, 1);
  assert.equal(confirmed.fields.engine_cc.evidence.length, 2);
  assert.throws(() => clarify(confirmed, { field: "engine_cc", value: "998", page: 1 }, 1));
  assert.deepEqual(reviewFields(confirmed), []);
});

test("missing OCR can be reviewed from the Tata schedule without inventing a rate", () => {
  const filename = "tata.pdf";
  const result = applyRating({
    filename, checksum: "b".repeat(64), extraction_version: "test", reader_failures: { 1: { sarvam: "ocr_disabled" } },
    fields: decide(filename, [], false), clarifications: [],
  });
  assert.equal(reviewFields(result)[0], "policy_type");
  assert.deepEqual(result.review_fields, ["policy_type", "insurer"]);
  const legacy = { ...result, fields: { ...result.fields, policy_type: {
    value: "compulsory pa cover for owner-driver", status: "confirmed_by_reviewer" as const,
    reason: "invalid_or_ungrounded", evidence: [],
  } } };
  assert.ok(reviewFields(legacy).includes("policy_type"));
  assert.equal(clarify(legacy, { field: "policy_type", value: "Auto Secure - Liability Only Policy", page: 1 }, 12).od.applicable, false);
  assert.throws(() => clarify(result, { field: "policy_type", value: "Compulsory PA Cover for Owner-Driver", page: 1 }, 12),
    /Enter the full policy title/);
  assert.throws(() => clarify(result, { field: "policy_type", value: "Third-Party Cover", page: 1 }, 12),
    /Enter the full policy title/);
  assert.match(confirmationError("vehicle_class", "Liability Only Policy") ?? "", /Enter the vehicle class/);
  assert.equal(confirmationError("vehicle_class", "Private car"), undefined);
  const reviewed = clarifyBatch(result, [
    { field: "policy_type", value: "Auto Secure - Liability Only Policy", page: 1 },
    { field: "insurer", value: "Tata AIG General Insurance Company Limited", page: 1 },
  ], 12);
  assert.equal(reviewed.status, "ambiguous");
  assert.deepEqual(reviewed.review_fields, ["vehicle_class"]);
  assert.equal(reviewed.od.applicable, false);
  assert.equal(reviewed.tp.rate, null);
  assert.match(reviewed.tp.reason, /private car/);
  assert.equal(reviewed.fields.rto.value, null);

});

test("Tata asks for vehicle classification and leaves unrelated OCR disputes out of the decision", () => {
  const filename = "tata.pdf";
  const facts = {
    insurer: "Tata AIG", previous_insurer: "Tata AIG", policy_type: "Liability Only Policy",
    vehicle_class: "Hatch Back", fuel: "CNG", rto_location: "Delhi",
  };
  const report = applyRating({
    filename, checksum: "d".repeat(64), extraction_version: "test", reader_failures: {}, clarifications: [],
    fields: { ...decide(filename, []), end_date: { status: "needs_review", value: null,
      reason: "conflicting_readings", evidence: [{ file: filename, page: 1, reader: "sarvam", model: "test",
        raw: "2027-03-31", quote: "Valid until 31/03/2027", box: null }] },
      ...Object.fromEntries(Object.entries(facts).map(([field, value]) =>
      [field, { value, status: "accepted", reason: "independent_agreement", evidence: [] }])) },
  });
  assert.equal(report.status, "ambiguous");
  assert.deepEqual(report.review_fields, ["vehicle_class"]);
  assert.deepEqual(requiredReviewFields(report), ["vehicle_class"]);
  assert.equal(report.fields.vehicle_class.reason, "vehicle_body_style_only");
  assert.match(confirmationError("vehicle_class", "HATCH BACK") ?? "", /vehicle class/);
  const reviewed = clarify(report, { field: "vehicle_class", value: "Private car", page: 4 }, 12);
  assert.equal(reviewed.status, "resolved");
  assert.equal(reviewed.tp.rate, "38");
  assert.deepEqual(requiredReviewFields(reviewed), []);
  assert.ok(reviewed.trace.some(step => step.sources.some(source => source.file === filename && source.page === 4)));
});

test("a batch confirms every conflict together and leaves missing fields alone", () => {
  const filename = "policy.pdf";
  const read = (reader: PageRead["reader"], value: string, fuel: string): PageRead => {
    const quote = `Engine capacity: ${value} cc`;
    const fuelQuote = `Fuel type: ${fuel}`;
    return { reader, page: 1, model: reader, transcript: `${quote}\n${fuelQuote}`, candidates: [
      { field: "engine_cc", value, quote, box: [0.1, 0.2, 0.4, 0.3] },
      { field: "fuel", value: fuel, quote: fuelQuote, box: null },
    ] };
  };
  const report = applyRating({
    filename, checksum: "c".repeat(64), extraction_version: "test", reader_failures: {},
    fields: decide(filename, [read("sarvam", "998", "petrol"), read("nvidia-super-vl", "1086", "diesel")]),
    clarifications: [],
  });
  assert.deepEqual(conflictFields(report), ["fuel", "engine_cc"]);
  const engine = { field: "engine_cc", value: "1086 cc", page: 1 };
  const fuel = { field: "fuel", value: "petrol", page: 1 };
  assert.throws(() => clarifyBatch(report, [engine], 1), /Confirm every OCR conflict/);
  assert.throws(() => clarifyBatch(report, [engine, engine], 1), /only once/);
  const confirmed = clarifyBatch(report, [engine, fuel], 1);
  assert.deepEqual(conflictFields(confirmed), []);
  assert.equal(confirmed.fields.insurer.value, null);
  assert.equal(confirmed.fields.engine_cc.evidence[0].box?.[0], 0.1);
  assert.equal(report.clarifications.length, 0);
});

test("independent legal insurer headings agree across pages even with partial OCR", () => {
  const filename = "policy.pdf";
  const read = (reader: PageRead["reader"], page: number, value: string, quote = value): PageRead => ({
    reader, page, model: reader, transcript: quote,
    candidates: [{ field: "insurer", value, quote, box: null }],
  });
  const name = "TATA AIG GENERAL INSURANCE COMPANY LIMITED";
  const first = read("sarvam", 1, name);
  const second = read("nvidia-super-vl", 5, name);
  assert.equal(decide(filename, [first, second], false).insurer.status, "accepted");
  assert.equal(decide(filename, [first], false).insurer.value, null);
  assert.equal(decide(filename, [first, read(second.reader, 5, name, `Previous insurer: ${name}`)], false).insurer.value, null);
  const structuredOnly = { ...first, page: second.page, transcript: "No insurer heading transcribed." };
  assert.equal(decide(filename, [structuredOnly, second], false).insurer.status, "accepted");
  assert.equal(decide(filename, [{ ...structuredOnly, page: 4 }, second], false).insurer.value, null);
  assert.equal(decide(filename, [structuredOnly, {
    ...second, transcript: `Previous insurer: ${name}`,
  }], false).insurer.value, null);
});

test("independent readers can corroborate a printed policy heading despite missing pages", () => {
  const title = "Auto Secure - Liability Only Policy";
  const first: PageRead = {
    reader: "sarvam", page: 1, model: "test", transcript: title,
    candidates: [{ field: "policy_type", value: title, quote: title, box: null }],
  };
  const second: PageRead = { ...first, reader: "gemini-flash", page: 4 };
  assert.equal(decide("policy.pdf", [first, second], false).policy_type.value, title.toLowerCase());
  const shortened = { ...second, candidates: [{ ...second.candidates[0], value: "Liability Only Policy" }] };
  assert.equal(decide("policy.pdf", [first, shortened], false).policy_type.value, title.toLowerCase());
  const different = { ...second, transcript: "Private Car Package Policy",
    candidates: [{ ...second.candidates[0], value: "Private Car Package Policy", quote: "Private Car Package Policy" }] };
  assert.equal(decide("policy.pdf", [first, different]).policy_type.reason, "conflicting_readings");
  assert.equal(decide("policy.pdf", [first, { ...second, reader: first.reader }], false).policy_type.value, null);
  assert.equal(decide("policy.pdf", [first, { ...second, transcript: `Previous: ${title}` }], false).policy_type.value, null);
});
