import data from "./cards.json" with { type: "json" };
import { component, policyStartDate, rtoCode, tidy, validRto } from "./types.ts";
import type { Facts, Parts, Source } from "./types.ts";

const file = data.files["tata-aig"].split("/").at(-1)!;
const effectiveDate = "2025-11-01";
const editionMonth = "2026-03";
// Pvtcar M1:BO1 marks these payout columns as Updated in the March edition.
const updatedColumns = new Set("M O P S T U V W Z AA AC AD AH AL AM AP AQ AZ BF BL BM BN".split(" "));
const rows = data.tata.rows as [number, string, string, string][];
const satp = data.tata.satp as [number, string, string, string, string, string, string, (string | null)[]][];
const source = (sheet: string, cells: string): Source => ({ file, sheet, cells });
// shortcut: check explicit state and UT names, extend with official office mappings for city and composite cluster names.
const registrationStates: Partial<Record<string, [string, number]>> = {
  AP: ["Andhra Pradesh", 62], BR: ["Bihar", 62], CG: ["Chhattisgarh", 62], CH: ["Chandigarh", 62],
  DL: ["Delhi", 62], GA: ["Goa", 62], GJ: ["Gujarat", 62], HR: ["Haryana", 62],
  HP: ["Himachal Pradesh", 62], JK: ["Jammu and Kashmir", 62], JH: ["Jharkhand", 62], KA: ["Karnataka", 62],
  KL: ["Kerala", 62], MP: ["Madhya Pradesh", 62], MH: ["Maharashtra", 62], OR: ["Orissa", 62],
  PB: ["Punjab", 63], RJ: ["Rajasthan", 63], TN: ["Tamil Nadu", 63], UP: ["Uttar Pradesh", 63],
  UK: ["Uttarakhand", 63], WB: ["West Bengal", 63],
};
const registrationSource = (prefix: string, [name, page]: [string, number]): Source => ({
  file: "Appendices _1.pdf",
  url: "https://morth.gov.in/sites/default/files/Appendices%20_1.pdf",
  row: `Appendix XIII, ${name} (${prefix}), printed page ${page}`,
});

export function tata(policy: Facts): Parts {
  const trace: Parts["trace"] = [];
  const cite = (step: string, ...sources: Source[]) => trace.push({ step, sources });
  const finish = (status: "ambiguous" | "unsupported", reason: string, review_fields?: readonly string[]): Parts =>
    ({ od: component(status, reason), tp: component(status, reason), trace, ...(review_fields ? { review_fields } : {}) });
  const standaloneTp = policy.policy_type === "satp";
  if (policy.vehicle_class !== "private_car") {
    const reason = policy.vehicle_class ? "The supplied grid covers private cars." : "Confirm whether the policy is for a private car.";
    trace.push({ step: reason, sources: [source("Pvtcar", "F1")], policy_fields: ["vehicle_class"] });
    return policy.vehicle_class ? finish("unsupported", reason) : finish("ambiguous", reason, ["vehicle_class"]);
  }
  const startDate = policyStartDate(policy.start_date);
  const effectiveHeading = source("Pvtcar", "F1");
  if (!startDate) {
    const reason = "Confirm the policy start date to check the Tata AIG grid effective 1 November 2025.";
    cite(reason, effectiveHeading);
    return finish("ambiguous", reason, ["start_date"]);
  }
  if (startDate < effectiveDate) {
    const reason = "The policy starts before the Tata AIG private-car grid’s effective date of 1 November 2025.";
    trace.push({ step: reason, sources: [effectiveHeading], policy_fields: ["start_date"] });
    return finish("unsupported", reason);
  }
  trace.push({ step: `The policy starts ${startDate}, on or after the Tata AIG grid’s effective date.`,
    sources: [effectiveHeading], policy_fields: ["start_date"] });
  const fuel = tidy(policy.fuel);
  const business = policy.business_type === "new" ? "brand new" : policy.business_type;
  if (standaloneTp) {
    if (!policy.rto_location?.trim()) {
      const reason = "Confirm the RTO location to select the Tata AIG payout cluster.";
      cite(reason, source("General Guidelines", "C10"), source("Pvtcar", "G5:BO5"));
      return finish("ambiguous", reason, ["rto_location"]);
    }

    const location = tidy(policy.rto_location);
    const jurisdiction = location === "andra pradesh" ? "andhra pradesh" :
      location === "jammu kashmir" ? "jammu and kashmir" : location;
    const code = rtoCode(policy.rto);
    const prefix = code.slice(0, 2);
    const codeState = validRto(code) ? registrationStates[prefix] : undefined;
    const locationState = Object.entries(registrationStates).find(([, entry]) => tidy(entry?.[0]) === jurisdiction);
    if (codeState && locationState?.[1] && locationState[0] !== prefix) {
      const reason = `The RTO code ${policy.rto} belongs to ${codeState[0]}, and the policy lists ${policy.rto_location} as its RTO location. Confirm the code and location before selecting a payout column.`;
      const fields = ["rto", "rto_location"];
      trace.push({ step: reason, policy_fields: fields, sources: [
        registrationSource(prefix, codeState),
        registrationSource(locationState[0], locationState[1]),
        source("General Guidelines", "C10"),
      ] });
      return finish("ambiguous", reason, fields);
    }
    const clusters = data.tata.clusters.filter(([, label]) => tidy(label) === location);
    if (clusters.length !== 1) {
      const reason = "The policy’s RTO location does not match a unique payout cluster in the supplied grid.";
      cite(reason, source("General Guidelines", "C10"), source("Pvtcar", "M5:BO5"));
      return finish("unsupported", reason);
    }

    const cluster = clusters[0];
    const [column, label] = cluster;
    trace.push({
      step: `The policy’s RTO location matches the ${label} payout column.`,
      sources: [source("General Guidelines", "C10"), source("Pvtcar", `${column}5`),
        ...(codeState && locationState ? [registrationSource(prefix, codeState)] : [])],
      policy_fields: codeState && locationState ? ["rto", "rto_location"] : ["rto_location"],
    });
    if (updatedColumns.has(column)) {
      const edition = source("Pvtcar", `${column}1`);
      if (startDate.slice(0, 7) !== editionMonth) {
        const reason = `The March 2026 workbook marks the ${label} column as Updated. Its effective period for the policy’s start month is undocumented in the supplied corpus.`;
        trace.push({ step: reason, sources: [effectiveHeading, edition], policy_fields: ["start_date"] });
        return finish("ambiguous", reason);
      }
      trace.push({ step: `The ${label} column is marked Updated in the March 2026 edition, which matches the policy’s start month.`,
        sources: [effectiveHeading, edition], policy_fields: ["start_date"] });
    }
    const missing = [!fuel && "fuel", !business && "previous_insurer", !business && "business_type"]
      .filter((field): field is string => Boolean(field));
    if (missing.length) {
      const reason = "Confirm the fuel or business details required by the payout row.";
      cite(reason, source("Pvtcar", "G5:L5"));
      return finish("ambiguous", reason, missing);
    }

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
