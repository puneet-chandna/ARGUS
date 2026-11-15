import data from "./cards.json" with { type: "json" };
import { component, tidy } from "./types.ts";
import type { Facts, Parts, Source } from "./types.ts";

const file = data.files["tata-aig"].split("/").at(-1)!;
const rows = data.tata.rows as [number, string, string, string][];
const source = (sheet: string, cells: string): Source => ({ file, sheet, cells });

export function tata(policy: Facts): Parts {
  const trace: Parts["trace"] = [];
  const cite = (step: string, ...sources: Source[]) => trace.push({ step, sources });
  const finish = (status: "ambiguous" | "unsupported", reason: string, review_fields?: readonly string[]): Parts =>
    ({ od: component(status, reason), tp: component(status, reason), trace, ...(review_fields ? { review_fields } : {}) });
  if (policy.vehicle_class !== "private_car") {
    const reason = "A private-car classification is required.";
    cite(reason, source("Pvtcar", "F1"));
    return policy.vehicle_class ? finish("unsupported", reason) : finish("ambiguous", reason, ["vehicle_class"]);
  }
  const missing = ["rto", "make", "model", "fuel"].filter(key => !policy[key]);
  if (!policy.business_type) missing.push("previous_insurer", "business_type");
  if (missing.length) {
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
  const reason = "The supplied grid has no usable mapping from this make/model to its Type or from the RTO to its cluster.";
  cite(reason, source("General Guidelines", "C7:C10"), source("Pvtcar", "A3:E5"), source("Pvtcar", "G5:BR5"));
  return finish("unsupported", reason);
}
