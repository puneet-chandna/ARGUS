import data from "./cards.json" with { type: "json" };
import { component, tidy } from "./types.ts";
import type { Facts, Parts, Source } from "./types.ts";

const file = data.files["tata-aig"].split("/").at(-1)!;
const rows = data.tata.rows as [number, string, string, string][];
const satp = data.tata.satp as [number, string, string, string, string, string, string, (string | null)[]][];
const source = (sheet: string, cells: string): Source => ({ file, sheet, cells });

export function tata(policy: Facts): Parts {
  const trace: Parts["trace"] = [];
  const cite = (step: string, ...sources: Source[]) => trace.push({ step, sources });
  const finish = (status: "ambiguous" | "unsupported", reason: string, review_fields?: readonly string[]): Parts =>
    ({ od: component(status, reason), tp: component(status, reason), trace, ...(review_fields ? { review_fields } : {}) });
  const standaloneTp = policy.policy_type === "satp";
  const hasConditionalInputs = Boolean(policy.rto_location && policy.fuel && policy.business_type);
  if (policy.vehicle_class !== "private_car" && (policy.vehicle_class || !standaloneTp || hasConditionalInputs)) {
    const reason = policy.vehicle_class ? "The supplied grid covers private cars." : "Confirm whether the policy is for a private car.";
    cite(reason, source("Pvtcar", "F1"));
    return policy.vehicle_class ? finish("unsupported", reason) : finish("ambiguous", reason, ["vehicle_class"]);
  }
  const missing = ["rto", "make", "model", "fuel"].filter(key => !policy[key]);
  if (!policy.business_type) missing.push("previous_insurer", "business_type");
  if (missing.length && !standaloneTp) {
    const reason = "Confirm the RTO, make/model, fuel and business type.";
    cite(reason, source("Pvtcar", "G5:BR5"));
    return finish("ambiguous", reason, missing);
  }
  const coverage = policy.policy_type === "comprehensive" ? "package" : policy.policy_type;
  const business = policy.business_type === "new" ? "brand new" : policy.business_type;
  const fuel = tidy(policy.fuel);
  const genericFuel = ["diesel", "cng", "electric"].includes(fuel) ? fuel : "other than diesel";
  const matches = rows.filter(([, b, f, c]) => tidy(b) === business && [fuel, genericFuel].includes(tidy(f)) && tidy(c) === coverage);
  cite(
    matches.length
      ? "The workbook has payout rows for this business, fuel and coverage, with separate columns by geographic cluster and rows by Type."
      : "The workbook requires a matching coverage row, geographic cluster and Type before a payout can be selected.",
    source("Pvtcar", "F2"),
    source("Pvtcar", "G5:BR5"),
    ...matches.map(([i]) => source("Pvtcar", `G${i}:L${i}`)),
  );
  if (standaloneTp) {
    cite("The workbook uses the policy’s RTO to identify the payout cluster. It gives no crosswalk for this registration.",
      source("General Guidelines", "C10"), source("Pvtcar", "M5:BO5"));
    const location = tidy(policy.rto_location);
    const clusters = data.tata.clusters.filter(([, label]) => tidy(label) === location);
    if (policy.vehicle_class === "private_car" && location && clusters.length === 1
        && ["petrol", "diesel", "cng", "electric", "other than diesel"].includes(fuel)) {
      const [column, label] = clusters[0];
      const index = data.tata.clusters.indexOf(clusters[0]);
      const eligible = satp.filter(([, , b, f]) => tidy(b) === business && [fuel, genericFuel].includes(tidy(f)));
      const types = new Set(satp.map(([, type]) => type));
      const value = eligible[0]?.[7][index];
      if (value != null && new Set(eligible.map(([, type]) => type)).size === types.size
          && eligible.every(([, , , , , ncb, addOn, rates]) => ncb === "All" && addOn === "All" && rates[index] === value)) {
        trace.push({
          step: `If the policy’s RTO belongs to the ${label} payout cluster, the standard-grid base rate is ${value}% across every vehicle Type for ${eligible[0][3]} stand-alone TP ${eligible[0][2].toLowerCase()}.`,
          sources: [source("Pvtcar", `${column}5`), source("Pvtcar", eligible.map(([row]) => `${column}${row}`).join(", "))],
          policy_fields: ["rto_location", "rto", "fuel", "vehicle_class", "policy_type", "insurer", "previous_insurer", "business_type"],
        });
      }
    }
    cite("The standard grid shows base commission on net premium. Policy-specific and other overrides take priority.",
      source("General Guidelines", "C7"), source("General Guidelines", "C11:C17"), source("Pvtcar", "F2:F3"));
  }
  const reason = standaloneTp
    ? "The workbook does not confirm which payout cluster covers the policy’s RTO."
    : "The supplied workbook lacks the vehicle Type and RTO cluster mappings needed to select a rate.";
  cite(reason, source("General Guidelines", "C10"), source("Pvtcar", "M5:BO5"));
  return finish("unsupported", reason);
}
