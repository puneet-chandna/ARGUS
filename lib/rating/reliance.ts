import data from "./cards.json" with { type: "json" };
import { component, integer, policyStartDate, rtoCode, tidy, validRto } from "./types.ts";
import type { Facts, Parts, Status } from "./types.ts";

const GRID = "PRIVATE CAR COMP, SAOD & STP";
const FEBRUARY_GRID = "FEB'26 - Grid";
const GRID_MONTH = "2026-01"; // PRIVATE CAR COMP, SAOD & STP!A1 says Jan-26.
const RTO = "RTO List";
const MODELS = "Make Model wise segment";
const file = data.files["reliance-indusind"].split("/").at(-1)!;
const rtos = data.reliance.rtos as [number, string, string, string][];
const models = data.reliance.models as [number, string, string, string][];
const grid = data.reliance.grid as [string | null, string, number, number, number, number][];
const regionAliases: Partial<Record<string, string>> = { banglore: "bangalore", gujrat: "gujarat", ne: "north east" };
// State groups use the original private-car sheet's region headings in B3:B17.
const stateGroups: Partial<Record<string, readonly string[]>> = {
  "rest of maharashtra": ["MH"],
  gujrat: ["GJ"],
  "rest of ka ts ap": ["KA", "TS", "TG", "AP"],
  kerala: ["KL"],
  tamilnadu: ["TN"],
  "punjab hp jk": ["PB", "HP", "JK"],
  "up haryana rajasthan": ["UP", "HR", "RJ"],
  "ne odisha chhattisgarh": ["OD", "OR", "CG"],
  "bihar jharkhand": ["BR", "JH"],
  "west bengal": ["WB"],
};

export function reliance(policy: Facts): Parts {
  const trace: Parts["trace"] = [];
  const cite = (step: string, sheet: string, cells: string, policy_fields?: string[]) =>
    trace.push({ step, sources: [{ file, sheet, cells }], ...(policy_fields && { policy_fields }) });
  const kind = policy.policy_type;
  const noTp = component("unsupported", "The old-business grid has an STP column and no package TP rate.");
  if (kind === "comprehensive") cite(noTp.reason, GRID, "A1:H2");
  const stop = (reason: string, sheet: string, cells: string, status: Status = "ambiguous", reviewFields?: string[],
    policyFields = reviewFields): Parts => {
    cite(reason, sheet, cells, policyFields);
    return {
      od: component(status, reason),
      tp: kind === "comprehensive" ? noTp : component(status, reason),
      trace, ...(reviewFields && { review_fields: reviewFields }),
    };
  };
  if (policy.vehicle_class !== "private_car") {
    return policy.vehicle_class ? stop("The grid only covers private cars.", GRID, "A1", "unsupported") :
      stop("A verified private-car classification is required.", GRID, "A1", "ambiguous", ["vehicle_class"]);
  }
  if (policy.business_type !== "renewal" && policy.business_type !== "rollover") {
    cite("This sheet is for old business.", GRID, "A1");
    return policy.business_type === "new" ? stop("The supplied old-business grid does not cover new business.", GRID, "A1", "unsupported") :
      stop("Verify renewal or rollover from the business type or previous insurer.", GRID, "A1", "ambiguous", ["previous_insurer", "business_type"]);
  }
  const rto = rtoCode(policy.rto);
  if (!validRto(rto)) return stop("A verified RTO code is required.", RTO, "A1:E2", "ambiguous", ["rto"]);
  const locations = rtos.filter(([, code]) => rtoCode(code) === rto);
  if (new Set(locations.map(([, , region, zone]) => `${region}\0${zone}`)).size !== 1) {
    return stop("The source does not uniquely map the registration code to a Reliance RTO zone.", RTO,
      locations.length ? locations.map(([i]) => `A${i}:E${i}`).join(", ") : `A1:E${data.reliance.rtoEnd}`,
      locations.length ? "ambiguous" : "unsupported");
  }
  const [rtoRow, , region, zone] = locations[0];
  cite(`The RTO maps to ${region}, ${zone}.`, RTO, `A${rtoRow}:E${rtoRow}`, ["rto"]);
  const make = tidy(policy.make);
  const printedModel = tidy(policy.model);
  const model = printedModel.startsWith(`${make} `) ? printedModel.slice(make.length + 1) : printedModel;
  if (!make || !model) return stop("Confirm the make and model as printed in the policy.", MODELS, "A1:C1", "ambiguous",
    [...(!make ? ["make"] : []), ...(!model ? ["model"] : [])]);
  const makeModels = models.filter(([, name]) => tidy(name) === make);
  const exact = makeModels.filter(([, , variant]) => tidy(variant) === model);
  const mapped = exact.length ? exact : makeModels.filter(([, , variant]) => model.startsWith(`${tidy(variant)} `));
  const modelRows = mapped.map(([i]) => `A${i}:C${i}`).join(", ");
  if (new Set(mapped.map(([, , variant, segment]) => `${tidy(variant)}\0${segment}`)).size !== 1) {
    return stop("The source does not uniquely map the printed make and model. Confirm both values from the policy.", MODELS,
      modelRows || `A1:C${data.reliance.modelEnd}`, "ambiguous", ["make", "model"]);
  }
  const [, gridMake, gridModel, segment] = mapped[0];
  cite(`The printed model ${policy.model} maps to ${gridMake} ${gridModel} (${segment}). The old-business rate row is selected by region.`,
    MODELS, modelRows, ["make", "model"]);
  let currentZone: string | null = null;
  const zoneRows = grid.flatMap((row, index) => {
    currentZone = row[0] ?? currentZone;
    return currentZone === zone ? [{ row, i: index + 3 }] : [];
  });
  const named = zoneRows.filter(({ row }) => row[1].split(",").map(tidy).some(name => (regionAliases[name] ?? name) === tidy(region)));
  const prefix = rto.slice(0, 2);
  const selected = named.length ? named : zoneRows.filter(({ row }) => stateGroups[tidy(row[1])]?.includes(prefix));
  if (selected.length !== 1) return stop("The grid does not uniquely match the mapped region.", GRID, "A3:F17");
  const { row, i } = selected[0];
  cite(named.length
    ? `The ${zone} payout row “${row[1]}” matches the RTO region ${region}.`
    : `The RTO region ${region} has no named ${zone} row. The ${prefix} RTO prefix selects the “${row[1]}” group.`,
  GRID, `A${i}:F${i}`, ["rto"]);
  const startDate = policyStartDate(policy.start_date);
  if (startDate?.slice(0, 7) !== GRID_MONTH) {
    cite("The private-car old-business sheet is dated January 2026.", GRID, "A1");
    if (startDate?.startsWith("2026-02-")) cite(kind === "satp"
      ? "The February sheet lists a separate PC STP Non-Diesel section."
      : "The February sheet’s segment headings provide no private-car package or stand-alone OD column.",
    FEBRUARY_GRID, "D2:AU4", ["policy_type"]);
    if (kind !== "satp" && integer(policy.engine_cc) && Number(policy.engine_cc) < 1000) {
      cite("For an eligible policy, the below-1,000 cc footnote reduces OD by five percentage points.", GRID, "H3", ["engine_cc"]);
    }
    return startDate ? stop("The January private-car old-business sheet does not establish a rate on the policy start date.",
      GRID, "A1", "ambiguous", undefined, ["start_date"]) :
      stop("Confirm the policy start date to check the dated Reliance workbook.", GRID, "A1", "ambiguous", ["start_date"]);
  }
  cite("The policy starts in January 2026, the month named in the private-car old-business sheet.", GRID, "A1", ["start_date"]);
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
    return fuel ? stop(`The supplied package grid has no OD column for ${policy.fuel}.`, GRID, "C2:D2", "unsupported", undefined, ["fuel"]) :
      stop("A verified fuel type is required to select the package OD column.", GRID, "C2:D2", "ambiguous", ["fuel"]);
  }
  const col = kind === "saod" ? 4 : petrol ? 2 : 3;
  let payout = row[col];
  cite(`The base OD rate is ${payout}%.`, GRID, `${"CDE"[col - 2]}${i}`);
  const cc = integer(policy.engine_cc);
  if (!cc) return stop("Engine capacity is required to evaluate the 1,000 cc adjustment.", GRID, "H3", "ambiguous", ["engine_cc"]);
  if (cc < 1000) {
    payout -= 5;
    cite("Capacity below 1,000 cc decreases the OD rate by five percentage points.", GRID, "H3");
  } else {
    cite("Capacity at or above 1,000 cc leaves the base rate unchanged.", GRID, "H3");
  }
  if (policy.extended_warranty !== "no") {
    cite("The card names a separate flat extended-warranty payout.", GRID, "H5");
    return policy.extended_warranty === "yes" ?
      stop("The workbook does not establish how to combine the extended-warranty and standard OD payouts.", GRID, "H5") :
      stop("Confirm whether extended warranty applies to this OD lookup.", GRID, "H5", "ambiguous", ["extended_warranty"]);
  }
  const adjustments = [
    ["standalone_zd", -2.5, "H4"],
    ["tyre_rti_bundle", 2.5, "H6"],
  ] as const;
  for (const [key, adjustment, cells] of adjustments) {
    const value = policy[key];
    const label = key.replaceAll("_", " ");
    if (value !== "yes" && value !== "no") return stop(`Confirm whether ${label} was included.`, GRID, cells, "ambiguous", [key]);
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
