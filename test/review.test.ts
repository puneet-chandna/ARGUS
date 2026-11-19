import assert from "node:assert/strict";
import test from "node:test";
import { canonical, decide, type PageRead } from "../lib/ingestion/index.ts";
import { applyRating, clarifyBatch, type Report } from "../lib/report.ts";
import { confirmationError, conflictFields, requiredReviewFields, reviewFields } from "../lib/review-fields.ts";
import { rebindExtraction } from "../lib/verified-ocr.ts";

test("component blockers drive review for policy facts and brokerage evidence", () => {
  const report = applyRating({ filename: "reliance.pdf", checksum: "e".repeat(64), extraction_version: "test",
    reader_failures: {}, clarifications: [], fields: Object.fromEntries(Object.entries({
      insurer: "Reliance", previous_insurer: "Reliance", policy_type: "Private Car Package Policy",
      rto: "UP16", make: "Renault", model: "Kwid", fuel: "petrol", start_date: "2026-01-15",
    }).map(([field, value]) => [field, { status: "accepted", value, reason: "independent_agreement", evidence: [] }])) });
  assert.ok(report.blockers.some(blocker => blocker.component === "od" && blocker.kind === "policy_fact" && blocker.fields.includes("engine_cc")));
  assert.ok(report.blockers.some(blocker => blocker.component === "tp" && blocker.kind === "grid" && !blocker.fields.length));
  assert.ok(requiredReviewFields(report).includes("engine_cc"));
});

test("legacy OCR issue dates cannot survive rerating as a policy start", () => {
  const facts = { insurer: "Go Digit", policy_type: "Private Car SATP", rto: "UP78", fuel: "petrol", engine_cc: "1086", start_date: "2026-03-25" };
  const fields = Object.fromEntries(Object.entries(facts).map(([field, value]) =>
    [field, { value, status: "accepted" as const, reason: "independent_agreement", evidence: [] }]));
  const report = applyRating({ filename: "legacy.pdf", checksum: "a".repeat(64), extraction_version: "brokerage-fields-v4",
    reader_failures: {}, clarifications: [], fields: { ...fields, start_date: { ...fields.start_date,
      evidence: (["sarvam", "nvidia-super-vl"] as const).map(reader => ({ file: "legacy.pdf", page: 1, model: "old", reader,
        raw: "2026-03-25", quote: "Issue Date: 2026-03-25", box: null })),
    } } });
  assert.equal(report.tp.rate, null);
  assert.deepEqual(requiredReviewFields(report), ["start_date"]);
});

test("every rerating path withholds rates for an impossible coverage period", () => {
  const facts = { insurer: "Go Digit", policy_type: "Private Car SATP", rto: "UP78", fuel: "petrol",
    engine_cc: "1086", end_date: "2026-03-10" };
  const fields = Object.fromEntries(Object.entries(facts).map(([field, value]) =>
    [field, { value, status: "accepted" as const, reason: "source_verified", evidence: [] }]));
  const initial = applyRating({ filename: "period.pdf", checksum: "a".repeat(64), extraction_version: "test",
    fields, reader_failures: {}, clarifications: [] });
  const impossible = clarifyBatch(initial, [{ field: "start_date", value: "2026-03-18", page: 1 }], 1);
  assert.equal(impossible.tp.rate, null);
  assert.equal(impossible.status, "ambiguous");
  assert.equal(impossible.od.applicable, false);
  assert.deepEqual(requiredReviewFields(impossible), ["start_date", "end_date"]);
  assert.ok(impossible.trace.some(step => /before.*end|coverage period/i.test(step.step)));
  assert.equal(applyRating(rebindExtraction(impossible, "reopened.pdf")).tp.rate, null);
  const corrected = clarifyBatch(impossible, [{ field: "end_date", value: "2027-03-17", page: 1 }], 1);
  assert.equal(corrected.tp.rate, "29.5");
  assert.equal(corrected.fields.start_date.confirmation?.value, "2026-03-18");
  assert.equal(corrected.clarifications.length, 2);
});

test("OCR-invalid coverage dates remain blocking until both boundaries are reviewed", () => {
  const filename = "invalid-period.pdf";
  const transcript = "Policy start date: 2026-03-25\nPolicy end date: 2026-03-20";
  const reads: PageRead[] = (["sarvam", "nvidia-super-vl"] as const).map(reader => ({ reader, model: "test", page: 1,
    transcript, candidates: [
      { field: "start_date", value: "2026-03-25", quote: "Policy start date: 2026-03-25", box: null },
      { field: "end_date", value: "2026-03-20", quote: "Policy end date: 2026-03-20", box: null },
    ] }));
  const dates = decide(filename, reads);
  assert.equal(dates.start_date.reason, "invalid_coverage_period");
  assert.equal(dates.end_date.value, null);
  const facts = { insurer: "Go Digit", policy_type: "Private Car SATP", rto: "UP78", fuel: "petrol", engine_cc: "1086" };
  const fields = Object.fromEntries(Object.entries(facts).map(([field, value]) =>
    [field, { value, status: "accepted" as const, reason: "source_verified", evidence: [] }]));
  const initial = applyRating({ filename, checksum: "a".repeat(64), extraction_version: "test",
    reader_failures: {}, clarifications: [], fields: { ...dates, ...fields } });
  assert.deepEqual(new Set(requiredReviewFields(initial)), new Set(["start_date", "end_date"]));
  const partial = clarifyBatch(initial, [{ field: "start_date", value: "2026-03-25", page: 1 }], 1);
  assert.equal(partial.tp.rate, null);
  assert.equal(partial.status, "ambiguous");
  assert.equal(partial.od.applicable, false);
  assert.deepEqual(requiredReviewFields(partial), ["end_date"]);
  assert.ok(partial.trace.some(step => step.policy_fields?.includes("end_date") && step.sources.length === 2));
  const invalid = clarifyBatch(partial, [{ field: "end_date", value: "2026-03-20", page: 1 }], 1);
  assert.equal(invalid.tp.rate, null);
  const valid = clarifyBatch(partial, [{ field: "end_date", value: "2027-03-24", page: 1 }], 1);
  assert.equal(valid.tp.rate, "29.5");
  const optionalEnd = applyRating({ ...initial, fields: { ...fields,
    start_date: { ...dates.start_date, value: "2026-03-25", status: "accepted", reason: "independent_agreement" },
    end_date: { value: null, status: "needs_review", reason: "insufficient_agreement", evidence: [] },
  } });
  assert.equal(optionalEnd.tp.rate, "29.5");
});

test("a read-only review preview can discover the next blocker before all conflicts are confirmed", () => {
  const fuel = { value: null, status: "needs_review" as const, reason: "conflicting_readings", evidence: [] };
  const fields = Object.fromEntries(Object.entries({ insurer: "Go Digit", policy_type: "Private Car SATP",
    rto: "UP78", start_date: "2026-03-25", engine_cc: "1086" }).map(([field, value]) =>
    [field, { value, status: "accepted" as const, reason: "independent_agreement", evidence: [] }]));
  const report = applyRating({ filename: "review.pdf", checksum: "a".repeat(64), extraction_version: "test",
    reader_failures: {}, clarifications: [], fields: { ...fields, fuel } });
  const answer = [{ field: "engine_cc", value: "1086", page: 1 }];
  report.fields.engine_cc = { ...report.fields.engine_cc, status: "needs_review", value: null, reason: "conflicting_readings" };
  assert.throws(() => clarifyBatch(report, answer, 1), /every OCR conflict/);
  const preview = clarifyBatch(report, answer, 1, true);
  assert.deepEqual(requiredReviewFields(preview), ["fuel"]);
  assert.equal(report.fields.engine_cc.value, null);
});

function clarify(report: Report, input: {field: string; value: string; page: number}, pages: number) {
  return clarifyBatch(report, [input], pages);
}

test("reviewing Reliance engine capacity resolves OD and retains the original reading", () => {
  const filename = "reliance.pdf";
  const quote = "Engine capacity: 999 cc";
  const engine = decide(filename, [{ reader: "sarvam", model: "test", page: 2, transcript: quote,
    candidates: [{ field: "engine_cc", value: "999", quote, box: null }] }]).engine_cc;
  assert.equal(engine.evidence.length, 1);
  const facts = { insurer: "Reliance", previous_insurer: "Reliance", policy_type: "Private Car Package Policy",
    rto: "UP16", make: "Renault", model: "Kwid", fuel: "petrol", start_date: "2026-01-15",
    extended_warranty: "no", standalone_zd: "no", tyre_rti_bundle: "no" };
  const report = applyRating({ filename, checksum: "f".repeat(64), extraction_version: "test",
    reader_failures: {}, clarifications: [], fields: { engine_cc: engine,
      ...Object.fromEntries(Object.entries(facts).map(([field, value]) =>
        [field, { status: "accepted", value, reason: "independent_agreement", evidence: [] }])) } });
  assert.deepEqual(requiredReviewFields(report), ["engine_cc"]);
  const confirmed = clarify(report, { field: "engine_cc", value: "999 cc", page: 2 }, 2);
  assert.deepEqual([confirmed.od.status, confirmed.od.rate, confirmed.tp.status], ["resolved", "17.5", "unsupported"]);
  assert.deepEqual(requiredReviewFields(confirmed), []);
  assert.equal(confirmed.fields.engine_cc.confirmation?.page, 2);
  assert.deepEqual(confirmed.fields.engine_cc.evidence, engine.evidence);
  assert.equal(report.fields.engine_cc.value, null);
});

test("HDFC asks for and credits an eligible GWP source independently of policy fields", () => {
  const filename = "unseen-package.pdf";
  const facts = { insurer: "HDFC ERGO", policy_type: "Private Car Comprehensive Policy",
    rto: "MH12", start_date: "2025-02-01", current_ncb: "20", net_od_premium: "5200" };
  const fields = Object.fromEntries(Object.entries(facts).map(([field, value]) =>
    [field, { value, status: "accepted" as const, reason: "independent_agreement", evidence: [] }]));
  const report = applyRating({ filename, checksum: "a".repeat(64), extraction_version: "test",
    fields, reader_failures: {}, clarifications: [] });
  assert.deepEqual(requiredReviewFields(report), ["eligible_private_car_gwp"]);
  assert.equal(applyRating({ ...report, fields: { ...fields, eligible_private_car_gwp: {
    value: "5200", status: "accepted", reason: "independent_agreement", evidence: [],
  } } }).od.rate, null);
  assert.throws(() => clarifyBatch(report, [{ field: "eligible_private_car_gwp", value: "25000", source: "" }], 4), /brokerage record/);
  assert.throws(() => clarify(report, { field: "eligible_private_car_gwp", value: "5200", page: 1 }, 4), /brokerage record/);
  const confirmed = clarifyBatch(report, [{ field: "eligible_private_car_gwp", value: "25000", source: "Private-car GWP ledger, March" }], 4);
  assert.equal(confirmed.od.rate, "19.5");
  assert.equal(confirmed.tp.status, "unsupported");
  assert.equal(confirmed.fields.eligible_private_car_gwp.confirmation?.page, undefined);
  assert.ok(confirmed.trace.some(step => step.sources.some(source => source.file === "Private-car GWP ledger, March")));
  assert.equal(rebindExtraction(confirmed, "repeat.pdf").fields.eligible_private_car_gwp, undefined);

  const legacy = { ...confirmed, fields: { ...confirmed.fields, eligible_private_car_gwp: {
    ...confirmed.fields.eligible_private_car_gwp,
    confirmation: { ...confirmed.fields.eligible_private_car_gwp.confirmation!, file: filename, page: 1 },
  } } };
  for (const prior of [legacy, rebindExtraction(legacy, "repeat.pdf")]) {
    const rerated = applyRating(prior);
    assert.equal(rerated.od.rate, null);
    assert.deepEqual(requiredReviewFields(rerated), ["eligible_private_car_gwp"]);
  }
});

test("a rating blocker keeps an accepted OCR value open for correction", () => {
  const facts = { insurer: "HDFC ERGO", policy_type: "Private Car Comprehensive Policy",
    rto: "HR26", start_date: "2025-02-01", current_ncb: "0", fuel: "hydrogen", business_type: "renewal" };
  const fields = Object.fromEntries(Object.entries(facts).map(([field, value]) =>
    [field, { value, status: "accepted" as const, reason: "independent_agreement", evidence: [] }]));
  const missingGwp = applyRating({ filename: "unseen.pdf", checksum: "a".repeat(64), extraction_version: "test",
    fields, reader_failures: {}, clarifications: [] });
  const gwp = { field: "eligible_private_car_gwp", value: "11869", source: "Private-car GWP ledger" };
  const fuel = { field: "fuel", value: "diesel", page: 1 };
  assert.deepEqual(requiredReviewFields(missingGwp), ["eligible_private_car_gwp"]);
  assert.throws(() => clarifyBatch(missingGwp, [fuel], 4), /not awaiting review/);
  const report = clarifyBatch(missingGwp, [gwp], 4);
  assert.deepEqual(requiredReviewFields(report), ["fuel"]);
  const confirmed = clarify(report, fuel, 4);
  assert.equal(confirmed.od.rate, "10");
  assert.deepEqual(requiredReviewFields(confirmed), []);

  assert.equal(clarifyBatch(missingGwp, [gwp, fuel], 4).od.rate, "10");

  const legacyNcb = applyRating({ ...confirmed, fields: { ...confirmed.fields, current_ncb: {
    ...fields.current_ncb, value: "50", evidence: (["sarvam", "nvidia-super-vl"] as const).map(reader => ({
      file: confirmed.filename, page: 1, reader, model: "legacy", raw: "50", quote: "NCB discount: ₹50", box: null,
    })),
  } } });
  assert.equal(legacyNcb.od.rate, null);
  assert.deepEqual(requiredReviewFields(legacyNcb), ["current_ncb"]);
});

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
    fuel: "petrol", rto: "UP78", start_date: "2026-03-25",
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
    vehicle_class: "Hatch Back", fuel: "CNG", rto_location: "Delhi", start_date: "2026-03-25",
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

test("a batch can confirm optional OCR conflicts while required policy details remain", () => {
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
  assert.deepEqual(requiredReviewFields(report), ["policy_type", "insurer"]);
  const engine = { field: "engine_cc", value: "1086 cc", page: 1 };
  const fuel = { field: "fuel", value: "petrol", page: 1 };
  const partial = clarifyBatch(report, [engine], 1);
  assert.deepEqual(conflictFields(partial), ["fuel"]);
  assert.deepEqual(requiredReviewFields(partial), ["policy_type", "insurer"]);
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
