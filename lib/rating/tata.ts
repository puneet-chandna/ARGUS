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
  if (policy.vehicle_class !== "private_car") {
    const reason = policy.vehicle_class ? "The supplied grid covers private cars." : "Confirm whether the policy is for a private car.";
    cite(reason, source("Pvtcar", "F1"));
    return policy.vehicle_class ? finish("unsupported", reason) : finish("ambiguous", reason, ["vehicle_class"]);
  }
  const fuel = tidy(policy.fuel);
  const business = policy.business_type === "new" ? "brand new" : policy.business_type;
  if (standaloneTp) {
    const missing = [!policy.rto_location && "rto_location", !fuel && "fuel", !business && "previous_insurer"]
      .filter((field): field is string => Boolean(field));
    if (missing.length) {
      const reason = "Confirm the rating details from the policy schedule.";
      cite(reason, source("General Guidelines", "C10"), source("Pvtcar", "G5:BO5"));
      return finish("ambiguous", reason, missing);
    }

    const location = tidy(policy.rto_location);
    const clusters = data.tata.clusters.filter(([, label]) => tidy(label) === location);
    if (clusters.length !== 1) {
      const reason = "The policy’s RTO location does not match a unique payout cluster in the supplied grid.";
      cite(reason, source("General Guidelines", "C10"), source("Pvtcar", "M5:BO5"));
      return finish("unsupported", reason);
    }

    const cluster = clusters[0];
    const [column, label] = cluster;
    const index = data.tata.clusters.indexOf(cluster);
    const gridFuel = fuel === "petrol" ? "other than diesel" : fuel;
    const eligible = satp.filter(([, , b, f]) => tidy(b) === business && [fuel, gridFuel].includes(tidy(f)));
    const types = new Set(satp.map(([, type]) => type));
    const value = eligible[0]?.[7][index];
    const rowSources = eligible.map(([row]) => source("Pvtcar", `G${row}:L${row}`));
    if (value == null || new Set(eligible.map(([, type]) => type)).size !== types.size ||
        eligible.some(([, , , , , ncb, addOn, rates]) => ncb !== "All" || addOn !== "All" || rates[index] !== value)) {
      const reason = "The supplied rows do not establish one TP rate across vehicle Types.";
      cite(reason, source("Pvtcar", `${column}5`), ...rowSources);
      return finish("unsupported", reason);
    }

    trace.push({
      step: `The policy’s RTO location matches the ${label} payout column.`,
      sources: [source("General Guidelines", "C10"), source("Pvtcar", `${column}5`)],
      policy_fields: ["rto_location"],
    });
    cite("The standard grid applies to net premium. Policy-specific and other overrides take priority.",
      source("General Guidelines", "C7"), source("General Guidelines", "C11:C17"), source("Pvtcar", "F2:F3"));
    cite(`Every vehicle Type gives ${value}% base TP for ${eligible[0][3]} stand-alone TP ${eligible[0][2].toLowerCase()}.`, ...rowSources);
    trace.push({
      step: `The ${label} column gives ${value}% base TP across all vehicle Types.`,
      sources: [source("Pvtcar", eligible.map(([row]) => `${column}${row}`).join(", "))],
      policy_fields: ["fuel", "vehicle_class", "policy_type", "insurer", "previous_insurer", "business_type"],
    });
    const reason = `${label} standard-grid base on net premium. Policy-specific and other overrides take priority.`;
    return { od: component("inapplicable", "Stand-alone TP policy."),
      tp: component("resolved", reason, value), trace };
  }

  const missing = ["rto", "make", "model", "fuel"].filter(key => !policy[key]);
  if (!policy.business_type) missing.push("previous_insurer", "business_type");
  if (missing.length) {
    const reason = "Confirm the RTO, make/model, fuel and business type.";
    cite(reason, source("Pvtcar", "G5:BR5"));
    return finish("ambiguous", reason, missing);
  }
  const coverage = policy.policy_type === "comprehensive" ? "package" : policy.policy_type;
  const genericFuel = ["diesel", "cng", "electric"].includes(fuel) ? fuel : "other than diesel";
  const matches = rows.filter(([, b, f, c]) => tidy(b) === business && [fuel, genericFuel].includes(tidy(f)) && tidy(c) === coverage);
  const reason = "The supplied workbook lacks the vehicle Type and RTO cluster mappings needed to select a rate.";
  cite(reason, source("General Guidelines", "C10"), source("Pvtcar", "G5:BR5"),
    ...matches.map(([row]) => source("Pvtcar", `G${row}:L${row}`)));
  return finish("unsupported", reason);
}
