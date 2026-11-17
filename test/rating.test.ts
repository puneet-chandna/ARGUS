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
};
const hdfc = {
  insurer: "HDFC ERGO", policy_type: "Private Car Comprehensive Policy",
  rto: "HR26", eligible_private_car_gwp: "8053", net_od_premium: "8053", fuel: "diesel", current_ncb: "35",
};
const reliance = {
  insurer: "Reliance General Insurance Company Ltd",
  previous_insurer: "IndusInd General Insurance Company Limited",
  policy_type: "Private Car Package Policy",
  rto: "UP16", make: "Renault", model: "Kwid", engine_cc: "999", fuel: "petrol",
  start_date: "2026-02-15", standalone_zd: "no", tyre_rti_bundle: "no", extended_warranty: "no",
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
  }
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
    [{ eligible_private_car_gwp: "50000.01", policy_type: "Private Car SAOD", current_ncb: "0" }, "resolved", "10"],
    [{ current_ncb: "0", business_type: "new business" }, "resolved", "15"],
    [{ current_ncb: "0" }, "resolved", "10"],
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

test("Tata AIG uses the unique policy RTO location and rates only unanimous TP rows", () => {
  const facts = {
    insurer: "Tata AIG", previous_insurer: "Tata AIG General Insurance", policy_type: "Private Car SATP",
    rto: "DL9C", rto_location: "Delhi", fuel: "CNG", make: "Maruti", model: "Zen Estilo",
  };
  const result = rate(facts);
  assert.equal(result.status, "resolved");
  assert.equal(result.od.applicable, false);
  assert.equal(result.tp.rate, "38");
  assertSource(result, "General Guidelines", "C10");
  assertSource(result, "Pvtcar", "V5");
  assertSource(result, "Pvtcar", "V511, V515, V519, V523, V527, V531, V535");
  assert.ok(result.trace.some(step => /policy’s RTO location matches the DELHI/.test(step.step)));
  for (const location of ["Bihar", "Noida", "Delhi NCR"]) {
    const unresolved = rate({ ...facts, rto_location: location });
    assert.equal(unresolved.status, "unsupported");
    assert.equal(unresolved.tp.rate, null);
  }
  assert.deepEqual(rate({ ...facts, rto_location: "" }).review_fields, ["rto_location"]);
  assert.deepEqual(rate({ ...facts, fuel: "" }).review_fields, ["fuel"]);
  assert.equal(rate({ ...facts, rto_location: "Haryana" }).tp.rate, "0");
  assert.equal(rate({ ...facts, fuel: "diesel" }).tp.rate, "19");
  assertSource(result, "Pvtcar", "G511:L511");
});

test("All four fixture traces replay known source-reviewed facts against the original corpus", () => {
  const expected = [
    ["pvt-car-comprehensive-hdfc-ergo", "ambiguous", null, null, "rollover"],
    ["pvt-car-comprehensive-reliance", "ambiguous", null, null, "renewal"],
    ["pvt-car-satp-go-digit", "resolved", null, "29.5", "renewal"],
    ["pvt-car-satp-tata-aig", "resolved", null, "38", "renewal"],
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
      if (key !== "trace") assert.deepEqual(fixture[key], value, `${name}: ${key}`);
    }
    assert.deepEqual(fixture.trace.slice(-result.trace.length).map((step: (typeof result.trace)[number]) => ({
      ...step, sources: step.sources.filter(source => source.file !== fixture.filename),
    })), result.trace, name);
    if (name === "pvt-car-satp-tata-aig") {
      const report = applyRating({
        ...fixture, clarifications: [],
        fields: Object.fromEntries(Object.entries(fixture.fields).map(([key, field]) => [
          key, { ...(field as object), status: Object.hasOwn(facts, key) ? "accepted" : "needs_review" },
        ])),
      });
      const citedRate = report.trace.at(-1)!;
      assert.match(citedRate.step, /38% base TP/);
      assert.deepEqual([...new Set(citedRate.sources.flatMap(source => source.page ? [source.page] : []))].sort(), [1, 11, 4].sort());
    }
  }
});
