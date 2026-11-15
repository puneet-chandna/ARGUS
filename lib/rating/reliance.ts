import data from "./cards.json" with { type: "json" };
import { component, integer, rtoCode, tidy, validRto } from "./types.ts";
import type { Facts, Parts, Status } from "./types.ts";

const GRID = "PRIVATE CAR COMP, SAOD & STP";
const RTO = "RTO List";
const MODELS = "Make Model wise segment";
const file = data.files["reliance-indusind"].split("/").at(-1)!;
const rtos = data.reliance.rtos as [number, string, string, string][];
const models = data.reliance.models as [number, string, string, string][];
const grid = data.reliance.grid as [string | null, string, number, number, number, number][];

export function reliance(policy: Facts): Parts {
  const trace: Parts["trace"] = [];
  const cite = (step: string, sheet: string, cells: string) => trace.push({ step, sources: [{ file, sheet, cells }] });
  const kind = policy.policy_type;
  const noTp = component("unsupported", "The old-business grid has an STP column and no package TP rate.");
  if (kind === "comprehensive") cite(noTp.reason, GRID, "A1:H2");
  const stop = (reason: string, sheet: string, cells: string, status: Status = "ambiguous"): Parts => {
    cite(reason, sheet, cells);
    return {
      od: component(status, reason),
      tp: kind === "comprehensive" ? noTp : component(status, reason),
      trace,
    };
  };
  if (policy.vehicle_class !== "private_car") {
    return stop("A private-car classification is required.", GRID, "A1", policy.vehicle_class ? "unsupported" : "ambiguous");
  }
  if (policy.business_type !== "renewal" && policy.business_type !== "rollover") {
    cite("This sheet is for old business.", GRID, "A1");
    return stop("Verified renewal or rollover is required for this rate card.", GRID, "A1",
      policy.business_type === "new" ? "unsupported" : "ambiguous");
  }
  const rto = rtoCode(policy.rto);
  if (!validRto(rto)) return stop("A verified RTO code is required.", RTO, "A1:E2");
  const locations = rtos.filter(([, code]) => rtoCode(code) === rto);
  if (new Set(locations.map(([, , region, zone]) => `${region}\0${zone}`)).size !== 1) {
    return stop("The source does not uniquely map the registration code to a Reliance RTO zone.", RTO,
      locations.length ? locations.map(([i]) => `A${i}:E${i}`).join(", ") : `A1:E${data.reliance.rtoEnd}`,
      locations.length ? "ambiguous" : "unsupported");
  }
  const [rtoRow, , region, zone] = locations[0];
  cite(`The RTO maps to ${region}, ${zone}.`, RTO, `A${rtoRow}:E${rtoRow}`);
  const make = tidy(policy.make);
  const model = tidy(policy.model);
  if (!make || !model) return stop("Confirm the make and model as printed in the policy.", MODELS, "A1:C1");
  const mapped = models.filter(([, name, variant]) => tidy(name) === make && tidy(variant) === model);
  if (new Set(mapped.map(([, , , segment]) => segment)).size !== 1) {
    return stop("The source does not uniquely map the make and model.", MODELS,
      mapped.length ? mapped.map(([i]) => `A${i}:C${i}`).join(", ") : `A1:C${data.reliance.modelEnd}`,
      mapped.length ? "ambiguous" : "unsupported");
  }
  const [modelRow, , , segment] = mapped[0];
  cite(`The vehicle is mapped to ${segment}. The old-business rate row is selected by region.`, MODELS, `A${modelRow}:C${modelRow}`);
  let currentZone: string | null = null;
  const selected = grid.flatMap((row, index) => {
    currentZone = row[0] ?? currentZone;
    if (currentZone === zone && row[1].split(",").some(name => tidy(name) === tidy(region))) return [{ row, i: index + 3 }];
    return [];
  });
  if (selected.length !== 1) return stop("The grid does not uniquely match the mapped region.", GRID, "A3:F17");
  const { row, i } = selected[0];
  cite(`The mapped zone and region select payout row ${i}.`, GRID, `A${i}:F${i}`);
  if (!/^2026-02-(?:0[1-9]|1[0-9]|2[0-8])$/.test(policy.start_date ?? "")) {
    cite("The workbook is dated February 2026. The private-car sheet title says Jan-26.", GRID, "A1");
    if (kind !== "satp" && integer(policy.engine_cc) && Number(policy.engine_cc) < 1000) {
      cite("For an eligible policy, the below-1,000 cc footnote reduces OD by five percentage points.", GRID, "H3");
    }
    return stop("The workbook does not establish that the supplied rate applied on the policy start date.", GRID, "A1");
  }
  if (kind === "satp") {
    cite("The stand-alone TP column publishes the applicable value.", GRID, `F${i}`);
    return {
      od: component("inapplicable", "Stand-alone TP policy."),
      tp: component("resolved", "Stand-alone TP grid.", String(row[5])),
      trace,
    };
  }
  const fuel = tidy(policy.fuel);
  const petrol = ["petrol", "bifuel", "bi fuel", "petrol cng", "petrol lpg"].includes(fuel);
  const diesel = ["diesel", "electric", "ev"].includes(fuel);
  if (kind !== "saod" && !petrol && !diesel) {
    return stop("A fuel value matching the rate-card column is required.", GRID, "C2:D2");
  }
  const col = kind === "saod" ? 4 : petrol ? 2 : 3;
  let payout = row[col];
  cite(`The base OD rate is ${payout}%.`, GRID, `${"CDE"[col - 2]}${i}`);
  const cc = integer(policy.engine_cc);
  if (!cc) return stop("Engine capacity is required to evaluate the 1,000 cc adjustment.", GRID, "H3");
  if (cc < 1000) {
    payout -= 5;
    cite("Capacity below 1,000 cc decreases the OD rate by five percentage points.", GRID, "H3");
  } else {
    cite("Capacity at or above 1,000 cc leaves the base rate unchanged.", GRID, "H3");
  }
  if (policy.extended_warranty !== "no") {
    cite("The card names a separate flat extended-warranty payout.", GRID, "H5");
    return stop("Confirm that extended warranty does not apply to this OD lookup.", GRID, "H5");
  }
  const adjustments = [
    ["standalone_zd", -2.5, "H4"],
    ["tyre_rti_bundle", 2.5, "H6"],
  ] as const;
  for (const [key, adjustment, cells] of adjustments) {
    const value = policy[key];
    const label = key.replaceAll("_", " ");
    if (value !== "yes" && value !== "no") return stop(`Confirm whether ${label} was included.`, GRID, cells);
    if (value === "yes") {
      payout += adjustment;
      cite(`The ${label} adjustment changes OD by ${adjustment > 0 ? "+" : ""}${adjustment} percentage points.`, GRID, cells);
    } else {
      cite(`The ${label} adjustment does not apply.`, GRID, cells);
    }
  }
  if (payout < 0) {
    return stop("The adjustments produce a negative payout. The grid gives no OD rate for that outcome.", GRID, "H3:H6", "unsupported");
  }
  cite("The rate applies to OD premium.", GRID, "H2");
  return { od: component("resolved", "Old-business OD rate.", String(payout)), tp: noTp, trace };
}
