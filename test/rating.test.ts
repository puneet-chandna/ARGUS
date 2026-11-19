import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { rate, type RatingResult } from "../lib/rating/index.ts";
import { applyRating } from "../lib/report.ts";

const digit = {
  insurer: "Go Digit General Insurance Ltd.",
  policy_type: "Private Car SATP",
  rto: "UP78",
  engine_cc: "1086",
  fuel: "petrol",
  start_date: "2026-03-25",
};
const hdfc = {
  insurer: "HDFC ERGO", policy_type: "Private Car Comprehensive Policy",
  start_date: "2025-02-01",
  rto: "HR26", eligible_private_car_gwp: "8053", net_od_premium: "8053", fuel: "diesel", current_ncb: "35",
};
const reliance = {
  insurer: "Reliance General Insurance Company Ltd",
  previous_insurer: "IndusInd General Insurance Company Limited",
  policy_type: "Private Car Package Policy",
  rto: "UP16", make: "Renault", model: "Kwid", engine_cc: "999", fuel: "petrol",
  start_date: "2026-01-15", standalone_zd: "no", tyre_rti_bundle: "no", extended_warranty: "no",
};

function assertSource(result: RatingResult, sheet: string, cells: string) {
  assert.ok(result.trace.some(({ sources }) => sources.some(source =>
    source.sheet === sheet && source.cells === cells && !!source.file)));
}

test("Digit follows the original RTO-to-cluster and SATP segment rows", () => {
  const result = rate(digit);
  assert.equal(result.status, "resolved");
  assert.equal(result.od.applicable, false);
  assert.equal(result.od.rate, null);
  assert.equal(result.tp.rate, "29.5");
  assertSource(result, "4W  RTO", "B1609:C1609");
  assertSource(result, "4W SATP", "B293:E293");
});

test("Digit asks for the next missing input only when its workbook branch needs it", () => {
  const missing = { ...digit, rto: "", fuel: "", engine_cc: "" };
  assert.deepEqual(rate(missing).review_fields, ["rto"]);
  assert.deepEqual(rate({ ...missing, rto: digit.rto }).review_fields, ["fuel"]);
  assert.deepEqual(rate({ ...missing, rto: digit.rto, fuel: "petrol" }).review_fields, ["engine_cc"]);
  const cng = rate({ ...missing, rto: digit.rto, fuel: "cng" });
  assert.equal(cng.tp.rate, "0");
  assert.equal(cng.review_fields, undefined);
  assert.equal(rate(digit).tp.rate, "29.5");
});

test("Digit applies the dated SATP workbook within its documented month", () => {
  for (const start_date of ["2024-03-25", "2026-02-28", "2026-04-01"]) {
    const result = rate({ ...digit, start_date });
    assert.deepEqual([result.tp.status, result.tp.rate], ["unsupported", null]);
    assertSource(result, "4W SATP", "B2:F2");
  }
  for (const start_date of ["", "2026-02-31"]) {
    const result = rate({ ...digit, start_date });
    assert.deepEqual([result.tp.status, result.tp.rate, result.review_fields], ["ambiguous", null, ["start_date"]]);
  }
  for (const start_date of ["2026-03-01", "2026-03-31"]) {
    const result = rate({ ...digit, start_date });
    assert.equal(result.tp.rate, "29.5");
    assert.ok(result.trace.some(step => step.policy_fields?.includes("start_date")));
  }
});

test("Digit handles explicit zero, literal edges, missing facts and declines", () => {
  const cases = [
    [{ engine_cc: "1000" }, "unsupported", null],
    [{ engine_cc: "0" }, "ambiguous", null],
    [{ fuel: "cng", engine_cc: "" }, "resolved", "0"],
    [{ rto: "CG05", engine_cc: "998" }, "unsupported", null],
    [{ rto: "TN01", fuel: "cng" }, "resolved", "5"],
    [{ rto: "AN01", fuel: "diesel", engine_cc: "1498", vehicle_age: "9" }, "resolved", "20"],
    [{ rto: "AN01", fuel: "diesel", engine_cc: "1498", vehicle_age: "10" }, "unsupported", null],
    [{ rto: "AN01", fuel: "diesel", engine_cc: "1498" }, "ambiguous", null],
    [{ rto: "HR04", engine_cc: "1197", vehicle_age: "8" }, "unsupported", null],
    [{ rto: "HR04", engine_cc: "1197", vehicle_age: "11" }, "resolved", "5"],
    [{ rto: "DL01", fuel: "diesel", engine_cc: "1498", vehicle_age: "11" }, "ambiguous", null],
    [{ fuel: "" }, "ambiguous", null],
  ] as const;
  for (const [change, status, percentage] of cases) {
    const result = rate({ ...digit, ...change });
    assert.equal(result.tp.status, status, JSON.stringify(change));
    assert.equal(result.tp.rate, percentage, JSON.stringify(change));
    assert.ok(result.trace.at(-1)?.sources.length);
    assert.ok(result.blockers.every(blocker => blocker.sources.length), JSON.stringify(change));
  }
});

test("Digit derives and cites a conservative age range for age bands and restrictions", () => {
  const andaman = { ...digit, rto: "AN01", fuel: "diesel", engine_cc: "1498", start_date: "2026-03-25" };
  const young = rate({ ...andaman, manufacture_year: "2019" });
  assert.equal(young.tp.rate, "20");
  assert.ok(young.trace.some(step => /6–7/.test(step.step) &&
    step.policy_fields?.includes("manufacture_year") && step.policy_fields.includes("start_date")));
  assert.equal(rate({ ...andaman, registration_year: "2014" }).tp.rate, "46");
  const uncertainYears: Record<string, string>[] = [{ registration_year: "2015" }, { registration_year: "2016" },
    { registration_year: "2019" },
    { manufacture_year: "2014", registration_year: "2019" }];
  for (const years of uncertainYears) {
    const outcome = rate({ ...andaman, ...years });
    assert.deepEqual([outcome.tp.status, outcome.tp.rate, outcome.review_fields], ["ambiguous", null, ["vehicle_age"]]);
  }
  const contradictory = rate({ ...andaman, manufacture_year: "2019", registration_year: "2014" });
  assert.deepEqual([contradictory.tp.status, contradictory.tp.rate, contradictory.review_fields],
    ["ambiguous", null, ["start_date", "manufacture_year", "registration_year"]]);
  const consistent = { ...andaman, manufacture_year: "2019", registration_year: "2019" };
  assert.equal(rate({ ...consistent, vehicle_age: "7" }).tp.rate, "20");
  const wrongAge = rate({ ...consistent, vehicle_age: "12" });
  assert.equal(wrongAge.tp.status, "ambiguous");
  assert.equal(wrongAge.tp.rate, null);
  assert.ok(wrongAge.trace.some(step => step.policy_fields?.includes("vehicle_age") && step.policy_fields.includes("manufacture_year")));
  assert.equal(rate({ ...andaman, start_date: "2026-03-31", registration_year: "2014" }).tp.rate, "46");
  const haryana = { ...digit, rto: "HR04", engine_cc: "1197", start_date: andaman.start_date };
  assert.equal(rate({ ...haryana, manufacture_year: "2019" }).tp.status, "unsupported");
  assert.equal(rate({ ...haryana, registration_year: "2019" }).tp.status, "ambiguous");
  assert.equal(rate({ ...haryana, registration_year: "2016" }).tp.status, "ambiguous");
  assert.equal(rate({ ...haryana, registration_year: "2015" }).tp.rate, "5");
  assert.equal(rate({ ...andaman, start_date: "", registration_year: "2019" }).tp.status, "ambiguous");
});

test("HDFC applies the geographic, GWP and fuel/NCB rows without treating OD premium as GWP", () => {
  const result = rate(hdfc);
  assert.equal(result.status, "unsupported");
  assert.equal(result.tp.status, "unsupported");
  assert.equal(result.od.rate, "15");
  assert.ok(result.trace.some(({ sources }) => sources.some(s => s.page === 2 && s.row?.endsWith("Haryana (Zone-2)"))));
  assert.ok(result.trace.some(({ sources }) => sources.some(s => s.page === 1 && s.row === "Zone 2, <10k — Package, Non-Petrol, NCB")));
  const cases = [
    [{ eligible_private_car_gwp: "" }, "ambiguous", null],
    [{ eligible_private_car_gwp: "10000" }, "unsupported", null],
    [{ eligible_private_car_gwp: "10000.0000000000001" }, "resolved", "17.5"],
    [{ eligible_private_car_gwp: "50000" }, "resolved", "17.5"],
    [{ eligible_private_car_gwp: "INR 50,000.01" }, "resolved", "20"],
    [{ eligible_private_car_gwp: "100000.01", policy_type: "Private Car SAOD" }, "resolved", "14"],
    [{ eligible_private_car_gwp: "50000.01", policy_type: "Private Car SAOD", current_ncb: "0", business_type: "renewal" }, "resolved", "10"],
    [{ current_ncb: "0", business_type: "new business" }, "resolved", "15"],
    [{ current_ncb: "0" }, "ambiguous", null],
    [{ current_ncb: "", fuel: "electric" }, "resolved", "15"],
    [{ current_ncb: "" }, "ambiguous", null],
    [{ rto: "KA01" }, "ambiguous", null],
    [{ rto: "KA01", rto_location: "Bangalore" }, "resolved", "17.5"],
  ] as const;
  for (const [change, status, percentage] of cases) {
    const outcome = rate({ ...hdfc, ...change });
    assert.equal(outcome.od.status, status, JSON.stringify(change));
    assert.equal(outcome.od.rate, percentage, JSON.stringify(change));
  }
  assert.deepEqual(rate({ ...hdfc, fuel: "", eligible_private_car_gwp: "" }).review_fields, ["eligible_private_car_gwp"]);
  assert.equal(rate({ ...hdfc, fuel: "", eligible_private_car_gwp: "11869" }).od.rate, "17.5");
  assert.deepEqual(rate({ ...hdfc, fuel: "", current_ncb: "0" }).review_fields, ["fuel"]);
  assert.deepEqual(rate({ ...hdfc, fuel: "", policy_type: "Private Car SAOD" }).review_fields, ["fuel"]);
  assert.deepEqual(rate({ ...hdfc, rto: "", fuel: "" }).review_fields, ["rto"]);
});

test("HDFC asks for business type only when the new-business NCB footnote changes the OD rate", () => {
  const facts = { ...hdfc, eligible_private_car_gwp: "9000", current_ncb: "0" };
  const unknown = rate(facts);
  assert.deepEqual([unknown.od.status, unknown.od.rate, unknown.review_fields],
    ["ambiguous", null, ["previous_insurer", "business_type"]]);
  assert.ok(unknown.blockers.some(blocker => blocker.component === "od" && blocker.sources.some(source =>
    source.page === 1 && source.row?.includes("New Business will be considered as NCB"))));
  assert.equal(rate({ ...facts, business_type: "new" }).od.rate, "15");
  for (const previous_insurer of ["HDFC ERGO", "Reliance"]) {
    assert.equal(rate({ ...facts, previous_insurer }).od.rate, "10");
  }
  assert.equal(rate({ ...facts, current_ncb: "35" }).od.rate, "15");
  assert.equal(rate({ ...facts, fuel: "petrol" }).od.rate, "15");
});

test("HDFC requires defensible local labels for the split state rows", () => {
  for (const location of ["Bengaluru", "Bengaluru, Karnataka", "Bangalore (Karnataka)"]) {
    assert.equal(rate({ ...hdfc, rto: "KA01", rto_location: location }).od.rate, "17.5", location);
  }
  for (const location of ["Karnataka", "Unknown, Karnataka", "Bengaluru, Gujarat", "Bengaluru / Mysuru, Karnataka",
    "Bengaluru Rural, Karnataka", "Ahmedabad, Karnataka", "Delhi, Karnataka", "Mysuru"]) {
    const unresolved = rate({ ...hdfc, rto: "KA01", rto_location: location });
    assert.deepEqual([unresolved.od.status, unresolved.od.rate, unresolved.review_fields],
      ["ambiguous", null, ["rto_location"]], location);
  }
  assert.equal(rate({ ...hdfc, rto: "KA09", rto_location: "Mysuru, Karnataka" }).od.rate, "15");
  assert.equal(rate({ ...hdfc, rto: "KA09", rto_location: "Rest of Karnataka" }).od.rate, "15");
  assert.equal(rate({ ...hdfc, rto: "AS01", rto_location: "Kamrup, Assam" }).od.rate, "17.5");
  assert.equal(rate({ ...hdfc, rto: "AS02", rto_location: "Nagaon, Assam" }).od.rate, "15");
});

test("HDFC withholds OD when a verified Karnataka RTO office contradicts the location's zone", () => {
  for (const [rto, rto_location] of [["KA01", "Mysuru, Karnataka"], ["KA01", "Rest of Karnataka"],
    ["KA02", "Mysuru, Karnataka"], ["KA09", "Bangalore"], ["KA65", "Bengaluru"]]) {
    const result = rate({ ...hdfc, rto, rto_location });
    assert.deepEqual([result.od.status, result.od.rate, result.review_fields], ["ambiguous", null, ["rto", "rto_location"]]);
    assert.ok(result.trace.some(step => step.policy_fields?.includes("rto") && step.policy_fields.includes("rto_location") &&
      step.sources.some(source => source.row?.includes(`Appendix 5.5, ${rto}`) && source.url?.startsWith("https://cag.gov.in/")) &&
      step.sources.some(source => source.page === 1 && source.row?.includes("Karnataka"))));
  }
});

test("HDFC checks the Bengaluru Urban RTO offices beyond the original city codes", () => {
  for (const rto of ["KA41", "KA50", "KA51", "KA53", "KA59"]) {
    const conflicting = rate({ ...hdfc, rto, rto_location: "Mysuru, Karnataka" });
    assert.deepEqual([conflicting.od.status, conflicting.od.rate, conflicting.review_fields],
      ["ambiguous", null, ["rto", "rto_location"]], rto);
    assert.ok(conflicting.blockers.some(blocker => blocker.sources.some(source =>
      source.url?.startsWith("https://kla.kar.nic.in/") && source.row?.includes(`Bengaluru Urban, ${rto}`))), rto);
    assert.equal(rate({ ...hdfc, rto, rto_location: "Bengaluru" }).od.rate, "17.5", rto);
  }
  const suffix = rate({ ...hdfc, rto: "KA01A", rto_location: "Mysuru, Karnataka" });
  assert.deepEqual([suffix.od.status, suffix.od.rate, suffix.review_fields], ["ambiguous", null, ["rto"]]);
});

test("HDFC cites the effective date and withholds OD without a verified start date", () => {
  const result = rate(hdfc);
  assert.ok(result.trace.some(({ sources, policy_fields }) =>
    sources.some(source => source.row?.includes("Effective from")) && policy_fields?.includes("start_date")));
  for (const start_date of ["", "not verified", "2025-02-31"]) {
    const missing = rate({ ...hdfc, start_date });
    assert.deepEqual([missing.od.status, missing.od.rate, missing.review_fields], ["ambiguous", null, ["start_date"]]);
    assert.equal(rate({ ...hdfc, start_date, eligible_private_car_gwp: "" }).gwp_preview, undefined);
  }
  assert.equal(rate({ ...hdfc, start_date: "2025-01-31" }).od.status, "unsupported");
  assert.equal(rate({ ...hdfc, start_date: "", eligible_private_car_gwp: "10000" }).od.status, "unsupported");
  assert.equal(rate({ ...hdfc, start_date: "", policy_type: "Private Car SATP" }).tp.status, "unsupported");
});

test("HDFC previews only a unique, cited OD rate without treating a policy premium as verified GWP", () => {
  const input = { ...hdfc, fuel: "", eligible_private_car_gwp: "", net_od_premium: "8053", net_tp_premium: "3816" };
  const result = rate(input);
  assert.deepEqual([result.od.rate, result.tp.status, result.status], [null, "unsupported", "ambiguous"]);
  assert.ok(result.blockers.some(blocker => blocker.kind === "external_fact" &&
    blocker.sources.some(source => source.row === "Slab footnote immediately below Zone 2")));
  assert.deepEqual([result.gwp_preview?.amount, result.gwp_preview?.rate, result.gwp_preview?.zone], ["11869", "17.5", 2]);
  assert.match(result.gwp_preview?.sources[0].row ?? "", /Zone 2, >10-50k/);
  const other = rate({ ...input, rto: "MH12", net_premium: "75,000" });
  assert.deepEqual([other.gwp_preview?.amount, other.gwp_preview?.rate, other.gwp_preview?.zone], ["75000", "21", 1]);
  const ambiguousInputs: Record<string, string>[] = [
    { net_tp_premium: "" }, { current_ncb: "" }, { net_premium: "10000" }, { eligible_private_car_gwp: "11869" },
  ];
  for (const changes of ambiguousInputs) {
    assert.equal(rate({ ...input, ...changes }).gwp_preview, undefined);
  }
});

test("Reliance requires dated applicability and checks the CC threshold and add-ons", () => {
  const result = rate(reliance);
  assert.equal(result.business_type, "renewal");
  assert.equal(result.od.rate, "17.5");
  assert.equal(result.tp.status, "unsupported");
  assertSource(result, "PRIVATE CAR COMP, SAOD & STP", "H3");
  assert.equal(rate({ ...reliance, engine_cc: "1000" }).od.rate, "22.5");
  assert.equal(rate({ ...reliance, standalone_zd: "included" }).od.rate, "15");
  assert.equal(rate({ ...reliance, tyre_rti_bundle: "yes" }).od.rate, "20");
  assert.equal(rate({ ...reliance, tyre_rti_bundle: "" }).od.status, "ambiguous");
  assert.equal(rate({ ...reliance, start_date: "2025-12-23" }).od.status, "ambiguous");
  assert.equal(rate({ ...reliance, policy_type: "Private Car SATP" }).tp.rate, "0");
  const lowBase = { ...reliance, rto: "MP01", fuel: "diesel" };
  assert.equal(rate(lowBase).od.rate, "0");
  assert.equal(rate({ ...lowBase, standalone_zd: "yes" }).od.status, "unsupported");
});

test("Reliance dates private-car rates from the applicable sheet heading", () => {
  for (const start_date of ["2026-01-01", "2026-01-31"]) {
    const january = rate({ ...reliance, start_date });
    assert.equal(january.od.rate, "17.5");
    assert.ok(january.trace.some(step => step.policy_fields?.includes("start_date") &&
      step.sources.some(source => source.sheet === "PRIVATE CAR COMP, SAOD & STP" && source.cells === "A1")));
  }
  const february = rate({ ...reliance, start_date: "2026-02-01" });
  assert.deepEqual([february.od.status, february.od.rate, february.review_fields], ["ambiguous", null, undefined]);
  assertSource(february, "FEB'26 - Grid", "D2:AU4");
  assert.equal(rate({ ...reliance, start_date: "2026-02-28", policy_type: "Private Car SATP" }).tp.rate, null);
});

test("Reliance prefers the named region and uses documented state groups for the remaining RTOs", () => {
  for (const [rto, rtoRow, payoutRow, odRate, label] of [
    ["KA01", 518, 7, "17.5", "Banglore"],
    ["AP09", 12, 7, "17.5", "Hyderabad"],
    ["AP02", 5, 8, "10", "rest of KA,TS,AP"],
    ["AP01", 4, 8, "10", "rest of KA,TS,AP"],
    ["KA09", 526, 8, "10", "rest of KA,TS,AP"],
    ["GJ01", 237, 5, "15", "Gujrat"],
    ["MH12", 697, 3, "20", "Pune"],
    ["MH31", 716, 4, "17.5", "Rest Of Maharashtra"],
    ["UP01", 1238, 13, "7.5", "UP"],
  ] as const) {
    const result = rate({ ...reliance, rto });
    assert.equal(result.od.rate, odRate, rto);
    assertSource(result, "RTO List", `A${rtoRow}:E${rtoRow}`);
    assertSource(result, "PRIVATE CAR COMP, SAOD & STP", `A${payoutRow}:F${payoutRow}`);
    assertSource(result, "PRIVATE CAR COMP, SAOD & STP", `C${payoutRow}`);
    assertSource(result, "PRIVATE CAR COMP, SAOD & STP", "H3");
    assert.ok(result.trace.some(step => step.step.includes(label) &&
      step.sources.some(source => source.cells === `A${payoutRow}:F${payoutRow}`)), rto);
  }
  const wrongZone = rate({ ...reliance, rto: "RJ14" });
  assert.deepEqual([wrongZone.od.status, wrongZone.od.rate], ["ambiguous", null]);
  assertSource(wrongZone, "RTO List", "A1017:E1017");
});

test("Reliance maps the full printed variant to a unique model on token boundaries", () => {
  const result = rate({ ...reliance, model: "RENAULT KWID 1.0 RXT O" });
  assert.equal(result.od.rate, "17.5");
  assertSource(result, "Make Model wise segment", "A397:C397");
  assert.ok(result.trace.some(step => step.step.includes("RENAULT KWID 1.0 RXT O") && step.policy_fields?.includes("model")));
  for (const model of ["RENAULT KWIDDER 1.0 RXT O", "NISSAN KWID 1.0 RXT O"]) {
    const unmatched = rate({ ...reliance, model });
    assert.deepEqual([unmatched.od.status, unmatched.od.rate, unmatched.review_fields], ["ambiguous", null, ["make", "model"]]);
  }
  const overlapping = rate({ ...reliance, make: "HYUNDAI", model: "Grand i10 Nios Asta" });
  assert.deepEqual([overlapping.od.status, overlapping.od.rate, overlapping.review_fields], ["ambiguous", null, ["make", "model"]]);
  assertSource(overlapping, "Make Model wise segment", "A157:C157, A158:C158");
});

test("Reliance identifies the missing policy fact needed to continue the OD lookup", () => {
  for (const key of ["rto", "make", "model", "start_date", "fuel", "engine_cc", "extended_warranty",
    "standalone_zd", "tyre_rti_bundle"]) {
    const result = rate({ ...reliance, [key]: "" });
    assert.deepEqual([result.od.status, result.od.rate, result.review_fields], ["ambiguous", null, [key]], key);
  }
  const outsidePeriod = rate({ ...reliance, start_date: "2025-12-23" });
  assert.equal(outsidePeriod.review_fields, undefined);
});

test("Reliance distinguishes an unmapped fuel segment from an unread fuel field", () => {
  const cng = rate({ ...reliance, fuel: "CNG" });
  assert.deepEqual([cng.od.status, cng.od.rate, cng.review_fields], ["unsupported", null, undefined]);
  assert.ok(cng.blockers.some(blocker => blocker.component === "od" && blocker.kind === "grid" &&
    blocker.sources.some(source => source.sheet === "PRIVATE CAR COMP, SAOD & STP" && source.cells === "C2:D2")));
  assert.equal(rate({ ...reliance, fuel: "Petrol/CNG" }).od.rate, "17.5");
  assert.equal(rate({ ...reliance, fuel: "CNG", policy_type: "Private Car SATP" }).tp.rate, "0");
});

test("Tata AIG uses the unique policy RTO location and rates only unanimous TP rows", () => {
  const facts = {
    insurer: "Tata AIG", previous_insurer: "Tata AIG General Insurance", policy_type: "Private Car SATP",
    rto: "DL9C", rto_location: "Delhi", fuel: "CNG", make: "Maruti", model: "Zen Estilo", start_date: "2026-03-25",
  };
  const result = rate(facts);
  assert.equal(result.status, "resolved");
  assert.equal(result.od.applicable, false);
  assert.equal(result.tp.rate, "38");
  assertSource(result, "General Guidelines", "C10");
  assertSource(result, "Pvtcar", "V5");
  assertSource(result, "Pvtcar", "V1");
  assertSource(result, "Pvtcar", "V511, V515, V519, V523, V527, V531, V535");
  assert.ok(result.trace.some(step => /policy’s RTO location matches the DELHI/.test(step.step)));
  for (const location of ["Noida", "Delhi NCR"]) {
    const unresolved = rate({ ...facts, rto_location: location });
    assert.equal(unresolved.status, "unsupported");
    assert.equal(unresolved.tp.rate, null);
  }
  assert.deepEqual(rate({ ...facts, rto_location: "" }).review_fields, ["rto_location"]);
  assert.deepEqual(rate({ ...facts, fuel: "" }).review_fields, ["fuel"]);
  assert.equal(rate({ ...facts, fuel: "diesel" }).tp.rate, "19");
  assertSource(result, "Pvtcar", "G511:L511");

  for (const start_date of ["2024-01-01", "2025-10-31"]) {
    const historical = rate({ ...facts, start_date });
    assert.deepEqual([historical.tp.status, historical.tp.rate], ["unsupported", null]);
    assertSource(historical, "Pvtcar", "F1");
  }
  const missing = rate({ ...facts, start_date: "" });
  assert.deepEqual([missing.tp.status, missing.tp.rate, missing.review_fields], ["ambiguous", null, ["start_date"]]);
  for (const [start_date, rto_location, updateCell] of [["2025-11-01", "Delhi", "V1"], ["2026-02-28", "Delhi", "V1"],
    ["2026-04-01", "Delhi", "V1"], ["2026-02-28", "Bangalore", "O1"]]) {
    const historical = rate({ ...facts, start_date, rto_location, rto: rto_location === "Bangalore" ? "KA01" : facts.rto });
    assert.deepEqual([historical.tp.status, historical.tp.rate, historical.review_fields], ["ambiguous", null, undefined]);
    assert.ok(historical.blockers.some(blocker => blocker.kind === "grid" &&
      blocker.sources.some(source => source.cells === "F1") && blocker.sources.some(source => source.cells === updateCell)));
  }
  assert.equal(rate({ ...facts, start_date: "2025-11-01", rto_location: "Haryana", rto: "HR26" }).tp.rate, "0");
});

test("Tata AIG withholds TP when RTO jurisdiction contradicts the policy location", () => {
  const facts = {
    insurer: "Tata AIG", business_type: "renewal", policy_type: "Private Car SATP",
    fuel: "CNG", start_date: "2026-03-25",
  };
  for (const [rto, rto_location] of [["DL9C", "Haryana"], ["HR26", "Delhi"], ["DL-09C", "Bihar"]]) {
    const result = rate({ ...facts, rto, rto_location });
    assert.deepEqual([result.tp.status, result.tp.rate, result.review_fields], ["ambiguous", null, ["rto", "rto_location"]]);
    assert.ok(result.blockers.some(blocker => blocker.component === "tp" && blocker.sources.some(source =>
      source.url?.startsWith("https://morth.gov.in/") && source.row?.includes("Appendix XIII"))));
  }
  assert.equal(rate({ ...facts, rto: "DL9C", rto_location: "Delhi" }).tp.rate, "38");
  assert.equal(rate({ ...facts, rto: "HR26", rto_location: "Haryana" }).tp.rate, "0");
});

test("Tata AIG checks the state of each named city payout column against the RTO code", () => {
  const facts = {
    insurer: "Tata AIG", previous_insurer: "Tata AIG", policy_type: "Private Car SATP",
    fuel: "petrol", start_date: "2026-03-01",
  };
  for (const [rto_location, cell] of [
    ["Mumbai", "AL5"], ["Bengaluru", "O5"], ["Ahmedabad", "M5"], ["Bhubaneswar", "P5"], ["Chennai", "T5"],
    ["Coimbatore", "U5"], ["Hyderabad", "Z5"], ["Indore", "AA5"], ["Jaipur", "AC5"],
    ["Kolkata", "AH5"], ["Nagpur", "AM5"], ["Pune", "AP5"],
    ["Rajkot", "AQ5"], ["Surat", "BF5"], ["Vadodara", "BL5"], ["Vijayawada", "BM5"], ["Visakhapatnam", "BN5"],
  ]) {
    const result = rate({ ...facts, rto: rto_location === "Bengaluru" ? "MH01" : "KA01", rto_location });
    assert.deepEqual([result.od.applicable, result.tp.status, result.tp.rate, result.review_fields],
      [false, "ambiguous", null, ["rto", "rto_location"]], rto_location);
    const blocker = result.blockers[0];
    assert.ok(blocker.sources.some(item => item.url?.startsWith("https://morth.gov.in/")), rto_location);
    assert.ok(blocker.sources.some(item => item.url?.startsWith("https://static.pib.gov.in/") ||
      item.url === "https://vadodara.nic.in/about-district/"), rto_location);
    assertSource(result, "Pvtcar", cell);
  }
  for (const [rto, rto_location, percentage, cell] of [
    ["KA01", "Bangalore", "0", "O5"], ["KA01", "Bengaluru", "0", "O5"], ["MH01", "Mumbai", "38", "AL5"],
    ["MH01", "Bombay", "38", "AL5"],
  ]) {
    const result = rate({ ...facts, rto, rto_location });
    assert.equal(result.tp.rate, percentage, rto_location);
    assertSource(result, "Pvtcar", cell);
  }
  for (const [rto, rto_location] of [["OD02", "Mumbai"], ["TG09", "Mumbai"], ["TS09", "Mumbai"],
    ["KA01", "Telengana"], ["KA01", "Maharashtra"]]) {
    const result = rate({ ...facts, rto, rto_location });
    assert.deepEqual([result.tp.status, result.tp.rate, result.review_fields],
      ["ambiguous", null, ["rto", "rto_location"]], rto);
  }
  for (const rto_location of ["Karnataka", "Aurangabad", "Delhi NCR"]) {
    const result = rate({ ...facts, rto: "KA01", rto_location });
    assert.deepEqual([result.tp.status, result.tp.rate], ["unsupported", null], rto_location);
    assertSource(result, "Pvtcar", "M5:BO5");
  }
  assertSource(rate({ ...facts, rto: "KA01", rto_location: "KA1" }), "Pvtcar", "AE5");
});

test("Tata AIG withholds TP for contradictory named offices within the same state", () => {
  const facts = {
    insurer: "Tata AIG", previous_insurer: "Tata AIG", policy_type: "Private Car SATP",
    fuel: "petrol", start_date: "2026-03-01",
  };
  for (const [rto, rto_location, cell, domain] of [
    ["MH01", "Pune", "AP5", "transport.maharashtra.gov.in"],
    ["MH-12", "Mumbai", "AL5", "transport.maharashtra.gov.in"],
    ["MH31", "Mumbai", "AL5", "transport.maharashtra.gov.in"],
    ["KA09", "Bengaluru", "O5", "cag.gov.in"],
    ["KA55", "Bangalore", "O5", "cag.gov.in"],
    ["TN01", "Coimbatore", "U5", "tnsta.gov.in"],
    ["TN37", "Chennai", "T5", "tnsta.gov.in"],
  ]) {
    const result = rate({ ...facts, rto, rto_location });
    assert.deepEqual([result.tp.status, result.tp.rate, result.review_fields],
      ["ambiguous", null, ["rto", "rto_location"]], `${rto} / ${rto_location}`);
    assert.ok(result.blockers[0].sources.some(source => source.url?.startsWith(`https://${domain}/`) &&
      source.row?.includes(rto.replace("-", ""))));
    assertSource(result, "Pvtcar", cell);
  }
  for (const [rto, rto_location, cell] of [
    ["MH01", "Mumbai", "AL5"], ["MH12", "Pune", "AP5"], ["KA01", "Bangalore", "O5"], ["TN37", "Coimbatore", "U5"],
  ]) {
    const result = rate({ ...facts, rto, rto_location });
    assert.equal(result.tp.status, "resolved");
    assertSource(result, "Pvtcar", cell);
  }
});

test("Tata AIG withholds city TP when the supplied RTO code has no verified match", () => {
  const facts = {
    insurer: "Tata AIG", previous_insurer: "Tata AIG", policy_type: "Private Car SATP",
    fuel: "petrol", start_date: "2026-03-01",
  };
  for (const [rto, rto_location, cell] of [
    ["MH10", "Mumbai", "AL5"], ["MH15", "Pune", "AP5"], ["KA19", "Bangalore", "O5"],
    ["ZZ01", "Mumbai", "AL5"],
  ]) {
    const result = rate({ ...facts, rto, rto_location });
    assert.deepEqual([result.tp.status, result.tp.rate, result.review_fields],
      ["ambiguous", null, undefined], `${rto} / ${rto_location}`);
    assert.ok(result.blockers.some(blocker => blocker.component === "tp" && blocker.kind === "grid" &&
      !blocker.fields.length && blocker.sources.some(source => source.sheet === "Pvtcar" && source.cells === cell) &&
      blocker.sources.some(source => source.sheet === "General Guidelines" && source.cells === "C10")));
  }
  assert.equal(rate({ ...facts, rto: "MH01", rto_location: "Mumbai" }).tp.rate, "38");
  assert.equal(rate({ ...facts, rto: "DL9C", rto_location: "Delhi" }).tp.rate, "38");
});

test("All four fixture traces replay known source-reviewed facts against the original corpus", () => {
  const expected = [
    ["pvt-car-comprehensive-hdfc-ergo", "ambiguous", null, null, "rollover"],
    ["pvt-car-comprehensive-reliance", "ambiguous", null, null, "renewal"],
    ["pvt-car-satp-go-digit", "resolved", null, "29.5", "renewal"],
    ["pvt-car-satp-tata-aig", "ambiguous", null, null, "renewal"],
  ] as const;
  for (const [name, status, od, tp, businessType] of expected) {
    const fixture = JSON.parse(readFileSync(new URL(`../submission/${name}.json`, import.meta.url), "utf8"));
    const pdf = readFileSync(new URL(`../vaatun-starter-bundle/sample-policies/${name}.pdf`, import.meta.url));
    assert.equal(fixture.checksum, createHash("sha256").update(pdf).digest("hex"));
    const facts = Object.fromEntries(Object.entries(fixture.fields).flatMap(([key, field]) => {
      const fact = field as { value: string | null };
      return fact.value === null ? [] : [[key, fact.value]];
    }));
    const result = rate(facts);
    assert.deepEqual([result.status, result.od.rate, result.tp.rate, result.business_type], [status, od, tp, businessType], name);
    for (const [key, value] of Object.entries(result)) {
      if (key === "gwp_preview") {
        assert.deepEqual({ ...fixture[key], sources: fixture[key].sources.filter((source: { file: string }) => source.file !== fixture.filename) },
          value, `${name}: ${key}`);
      } else if (key === "blockers") {
        assert.deepEqual(fixture.blockers.map((blocker: RatingResult["blockers"][number]) => ({
          ...blocker, sources: blocker.sources.filter(source => source.file !== fixture.filename),
        })), value, `${name}: ${key}`);
      } else if (key !== "trace") assert.deepEqual(fixture[key], value, `${name}: ${key}`);
    }
    assert.deepEqual(fixture.trace.slice(-result.trace.length).map((step: (typeof result.trace)[number]) => ({
      ...step, sources: step.sources.filter(source => source.file !== fixture.filename),
    })), result.trace, name);
    if (name === "pvt-car-comprehensive-reliance") {
      assert.equal(fixture.fields.model.value, "RENAULT KWID 1.0 RXT O");
      assert.ok(fixture.trace.some((step: (typeof result.trace)[number]) => step.policy_fields?.includes("model") &&
        step.sources.some(source => source.page === 2 && source.file === fixture.filename)));
    }
    if (name === "pvt-car-satp-tata-aig") {
      const report = applyRating(fixture);
      assert.deepEqual(result.review_fields, ["vehicle_class"]);
      assert.equal(report.fields.vehicle_class?.value, null);
      assert.deepEqual(report.blockers[0].sources.filter(source => source.file === report.filename).map(source => source.page), [4, 7]);
    }
  }
});
