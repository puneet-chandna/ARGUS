import data from "./cards.json" with { type: "json" };
import { digit } from "./digit.ts";
import { hdfc } from "./hdfc.ts";
import { reliance } from "./reliance.ts";
import { tata } from "./tata.ts";
import { component, policyCoverage, tidy, vehicleBodyStyle } from "./types.ts";
import type { Facts, Parts, RatingResult } from "./types.ts";
export type { Facts, RatingResult, Source, TraceStep } from "./types.ts";

const engines = { godigit: digit, "hdfc-ergo": hdfc, "reliance-indusind": reliance, "tata-aig": tata };
const aliases: Record<keyof typeof engines, string[]> = {
  godigit: ["g digit", "go digit", "go digit general insurance", "digit general insurance"],
  "hdfc-ergo": ["hdfc ergo", "hdfc ergo general insurance"],
  "reliance-indusind": ["reliance", "reliance general insurance", "indusind general insurance", "reliance indusind",
    "indusind general insurance formerly reliance general insurance"],
  "tata-aig": ["tata aig", "tata aig general insurance"],
};

function insurerName(value = "") {
  const name = tidy(value).replace(/(?: (?:co|company|limited|ltd))+$/, "");
  return (Object.keys(aliases) as (keyof typeof aliases)[]).find(key => aliases[key].includes(name)) ?? name;
}

export function rate(facts: Facts): RatingResult {
  const insurer = insurerName(facts.insurer);
  const previous = insurerName(facts.previous_insurer);
  const kind = policyCoverage(facts.policy_type);
  const vehicle = vehicleBodyStyle(facts.vehicle_class) ? "" : tidy(facts.vehicle_class);
  const privateCar = ["private car", "private passenger car", "private motor car", "pvt car"].includes(vehicle)
    || !vehicle && /\b(?:private|pvt) car\b/.test(tidy(facts.policy_type));
  const printedBusiness = tidy(facts.business_type);
  const businessType = insurer && previous
    ? insurer === previous ? "renewal" : "rollover"
    : ["new", "brand new", "new business"].includes(printedBusiness) ? "new"
      : ["renewal", "rollover"].includes(printedBusiness) ? printedBusiness : "";
  const policy: Facts = { ...facts, policy_type: kind, vehicle_class: privateCar ? "private_car" : vehicle, business_type: businessType };
  for (const key of ["standalone_zd", "tyre_rti_bundle", "extended_warranty"]) {
    const value = tidy(policy[key]);
    if (["included", "yes", "applicable"].includes(value)) policy[key] = "yes";
    if (["excluded", "not included", "no", "not applicable"].includes(value)) policy[key] = "no";
  }

  let parts: Parts;
  if (!kind || !insurer) {
    const detail = kind ? "insurer" : insurer ? "policy type" : "policy type and insurer";
    const reason = `Confirm the ${detail} from the policy schedule.`;
    parts = {
      od: component("ambiguous", reason, null, kind ? kind !== "satp" : null),
      tp: component("ambiguous", reason, null, kind ? kind !== "saod" : null),
      trace: [{ step: reason, sources: [] }],
      review_fields: [...(!kind ? ["policy_type"] : []), ...(!insurer ? ["insurer"] : [])],
    };
  } else if (Object.hasOwn(engines, insurer)) {
    parts = engines[insurer as keyof typeof engines](policy);
  } else {
    const reason = "The supplied corpus has no grid for the identified insurer.";
    parts = {
      od: component("unsupported", reason),
      tp: component("unsupported", reason),
      trace: [{ step: reason, sources: [{ file: "MANIFEST.json" }] }],
    };
  }
  if (kind === "satp") parts.od = component("inapplicable", "Stand-alone TP policy.");
  if (kind === "saod") parts.tp = component("inapplicable", "Stand-alone OD policy.");
  const states = [parts.od.status, parts.tp.status];
  const status = states.includes("ambiguous") ? "ambiguous" : states.includes("unsupported") ? "unsupported" : "resolved";
  return {
    ...parts, status, rule_version: insurer === "tata-aig" ? `${data.version}-tata-rto-v2` : data.version,
    business_type: businessType || null,
    confidence: status === "ambiguous" ? { level: "low", reason: "At least one applicable rate is undetermined." } :
      { level: "high", reason: "The supplied source evidence establishes the rate or coverage decision." },
  };
}
