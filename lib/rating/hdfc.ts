import data from "./cards.json" with { type: "json" };
import { component, policyStartDate, rtoCode, tidy, validRto } from "./types.ts";
import type { Facts, Parts, Status } from "./types.ts";

type Geography = [number, string, string, 1 | 2];
type LocalGeography = [string, string, string[], 1 | 2, 1 | 2];
const states = data.hdfc.states as unknown as Partial<Record<string, Geography>>;
const locals = data.hdfc.local as unknown as Partial<Record<string, LocalGeography>>;
const normalizeLocation = (value = "") =>
  tidy(value.normalize("NFKD").replace(/\p{M}/gu, "")).replace(/\band\b/g, "").replace(/\s+/g, " ").trim();
const namedPlaces = [
  ...Object.values(states).flatMap(state => state?.[2].split(" / ") ?? []),
  ...Object.values(locals).flatMap(local => local ? [local[1], ...local[2]] : []),
  "Kamrup",
].map(normalizeLocation);
const file = data.files["hdfc-ergo"].split("/").at(-1)!;
const { rates, slabs } = data.hdfc;
const effectiveDate = "2025-02-01";
const effectiveHeading = "Effective from 1st Feb’25 heading";
const newBusinessFootnote = "New Business will be considered as NCB footnote below Zone 2";
const karnatakaAudit = "Report-of-the-Comptroller-and-Auditor-General-of-India-on-State-Revenues-for-the-period-ended-March-2024--Report-No.-3-of-2026-069c60d8a133e16.82085064.pdf";
const karnatakaAuditUrl = `https://cag.gov.in/uploads/download_audit_report/2026/${karnatakaAudit}`;
const karnatakaCouncil = "usq732(21022024).pdf";
const karnatakaCouncilUrl = `https://kla.kar.nic.in/council/Replies/unstarred/21022024/${karnatakaCouncil}`;
const bengaluruUrbanOffices = new Set([41, 50, 51, 53, 59]);

function decimal(value = "", prefix = /^(?:₹|INR)\s*/i): string | null {
  const number = value.trim().replace(prefix, "");
  if (!/^(?:[0-9]+|[0-9]{1,3}(?:,[0-9]{3})+|[0-9]{1,2}(?:,[0-9]{2})*,[0-9]{3})(?:\.[0-9]+)?$/.test(number)) return null;
  return number.replaceAll(",", "");
}

function compareToWhole(amount: string, threshold: number): number {
  const [whole, fraction] = amount.split(".");
  const difference = BigInt(whole) - BigInt(threshold);
  return difference < 0n ? -1 : difference > 0n || /[1-9]/.test(fraction ?? "") ? 1 : 0;
}

function packagePremium(policy: Facts) {
  const net = decimal(policy.net_premium);
  if (net !== null) return { amount: net, fields: ["net_premium"] };
  const od = decimal(policy.net_od_premium), tp = decimal(policy.net_tp_premium);
  if (od === null || tp === null) return;
  const parts = [od, tp].map(amount => amount.split("."));
  const precision = Math.max(...parts.map(([, fraction]) => fraction?.length ?? 0));
  const [a, b] = parts.map(([whole, fraction]) => BigInt(whole + (fraction ?? "").padEnd(precision, "0")));
  const total = String(a + b).padStart(precision + 1, "0");
  const amount = precision ? total.slice(0, -precision) + "." + total.slice(-precision) : total;
  return { amount, fields: ["net_od_premium", "net_tp_premium"] };
}

function isRestOfState(raw: string, state: string) {
  const compound = /^\s*([\p{L}]+(?:[ .'’-]+[\p{L}]+)*)\s*(?:,\s*([^,()]+)|\(([^,()]+)\))\s*$/u.exec(raw);
  if (!compound || normalizeLocation(compound[2] ?? compound[3]) !== state ||
      /\b(?:and|or|unknown|unspecified|other|not|unavailable|state|rto)\b/i.test(compound[1])) return false;
  const place = normalizeLocation(compound[1]);
  return place !== "" && !namedPlaces.some(name => ` ${place} `.includes(` ${name} `));
}

export function hdfc(policy: Facts): Parts {
  const trace: Parts["trace"] = [];
  const cite = (step: string, page: number, row: string, policy_fields?: string[]) =>
    trace.push({ step, sources: [{ file, page, row }], ...(policy_fields && { policy_fields }) });
  if (policy.policy_type === "satp") {
    const reason = "The private-car grid excludes SATP from slab eligibility and publishes no SATP rate.";
    cite(reason, 1, "Zone 1 and Zone 2 coverage headings; slab footnote");
    return {
      od: component("inapplicable", "Stand-alone TP policy."),
      tp: component("unsupported", reason),
      trace,
    };
  }
  const cover = policy.policy_type === "saod" ? "SAOD" : "Package";
  const tp = cover === "Package" ? component("unsupported", "The package grid publishes an OD rate only.") :
    component("inapplicable", "Stand-alone OD policy.");
  if (cover === "Package") cite(tp.reason, 1, "Zone 1 and Zone 2 Package rate columns");
  const finish = (status: Status, reason: string, rate: string | null = null, review_fields?: string[]): Parts =>
    ({ od: component(status, reason, rate), tp, trace, ...(review_fields && { review_fields }) });

  if (policy.vehicle_class !== "private_car") {
    const reason = "The supplied HDFC grid requires a private-car policy.";
    cite(reason, 1, "Slab footnote, PVT CAR eligibility");
    return policy.vehicle_class ? finish("unsupported", reason) : finish("ambiguous", reason, null, ["vehicle_class"]);
  }
  const startDate = policyStartDate(policy.start_date);
  if (startDate && startDate < effectiveDate) {
    const reason = "The policy starts before the effective date of the supplied HDFC grid.";
    cite(reason, 1, effectiveHeading, ["start_date"]);
    return finish("unsupported", reason);
  }
  const rto = rtoCode(policy.rto);
  if (!validRto(rto)) {
    const reason = "A verified RTO code is needed to select the HDFC zone.";
    cite(reason, 1, "Geography, state and zone headers");
    return finish("ambiguous", reason, null, ["rto"]);
  }
  const state = rto.slice(0, 2);
  if (state === "KA" && /[A-Z]$/.test(rto)) {
    const reason = "Confirm the numeric Karnataka RTO office code from the policy schedule.";
    trace.push({ step: reason, sources: [{ file: karnatakaAudit, url: karnatakaAuditUrl, page: 186,
      row: "Appendix 5.5, RTO Code column (printed page 161)" }], policy_fields: ["rto"] });
    return finish("ambiguous", reason, null, ["rto"]);
  }
  let geography = states[state];
  const local = locals[state];
  if (local) {
    const [region, name, cities, cityZone, restZone] = local;
    const stateName = normalizeLocation(name);
    const location = normalizeLocation(policy.rto_location);
    const matches = (label: string) => location === label || location === `${label} ${stateName}`;
    const matchesCity = cities.some(city => matches(normalizeLocation(city)));
    const matchesRest = matches(`rest of ${stateName}`) || (state === "AS" && matches("kamrup")) ||
      isRestOfState(policy.rto_location ?? "", stateName);
    if (!matchesCity && !matchesRest) {
      const reason = `The ${name} row distinguishes RTO locations. A verified city or district is required to choose a zone.`;
      cite(reason, 1, `Geography, ${region} — ${name} (Zone-1 and Zone-2)`);
      return finish("ambiguous", reason, null, ["rto_location"]);
    }
    if (state === "KA") {
      // shortcut: check the audited offices and listed Bengaluru Urban offices, extend when the grid defines its metro boundary.
      const code = Number(rto.slice(2));
      const urbanOffice = bengaluruUrbanOffices.has(code);
      const bengaluru = (code >= 1 && code <= 5) || urbanOffice;
      const outsideBengaluru = (code >= 6 && code <= 40) || code === 42 || (code >= 44 && code <= 49) ||
        (code >= 54 && code <= 56) || (code >= 63 && code <= 71);
      if ((bengaluru && matchesRest) || (outsideBengaluru && matchesCity)) {
        const place = bengaluru ? "in Bengaluru" : "outside Bengaluru";
        const reason = `The RTO code ${rto} identifies an office ${place}. The policy RTO location selects the other Karnataka zone. Confirm the RTO code and location.`;
        const office = `KA${String(code).padStart(2, "0")}`;
        const reviewFields = ["rto", "rto_location"];
        trace.push({ step: reason, sources: [
          { file, page: 1, row: `Geography, ${region} — ${name} (Zone-1 and Zone-2)` },
          { file: karnatakaAudit, url: karnatakaAuditUrl, page: code <= 41 ? 186 : 187,
            row: `Appendix 5.5, ${office} (printed page ${code <= 41 ? 161 : 162})` },
          ...(urbanOffice ? [{ file: karnatakaCouncil, url: karnatakaCouncilUrl,
            row: `LCQ-732, Annexure 1, Bengaluru Urban, ${office}` }] : []),
        ], policy_fields: reviewFields });
        return finish("ambiguous", reason, null, reviewFields);
      }
    }
    geography = [1, region, name, matchesCity ? cityZone : restZone];
  }
  if (!geography) {
    const reason = `The supplied geography table has no verified zone for RTO prefix ${state}.`;
    cite(reason, 1, "Geography, East, South and West rows");
    cite(reason, 2, "Geography, North and Central rows");
    return finish("unsupported", reason);
  }
  const [page, region, name, zone] = geography;
  const geographyLabel = local ? `${policy.rto_location} in the ${name} row` : name;
  cite(`Mapped RTO ${rto} through ${geographyLabel} to Zone ${zone}.`, page, `Geography, ${region} — ${name} (Zone-${zone})`,
    local ? ["rto", "rto_location"] : ["rto"]);

  const gwp = decimal(policy.eligible_private_car_gwp);
  const fuel = policy.fuel?.toLowerCase().trim() ?? "";
  const petrol = ["petrol", "gasoline", "ev", "electric", "hybrid", "petrol hybrid", "electric vehicle"].includes(fuel);
  const nonPetrol = ["diesel", "cng", "lpg"].includes(fuel) || /^petrol\s*[+/]\s*(cng|lpg)$/.test(fuel);
  const newBusiness = policy.business_type === "new";
  const ncb = decimal(policy.current_ncb?.trim().replace(/%$/, ""));
  const validNcb = ncb !== null && compareToWhole(ncb, 100) <= 0 ? ncb : null;
  const ncbColumns = newBusiness || (validNcb !== null && compareToWhole(validNcb, 0) > 0) ? [1] :
    validNcb !== null && policy.business_type ? [2] : [1, 2];
  const columns = petrol ? [0] : nonPetrol ? ncbColumns : [0, ...ncbColumns];
  const offset = cover === "SAOD" ? 3 : 0;
  let slab = 0;
  if (gwp !== null) {
    if (compareToWhole(gwp, 10000) === 0) {
      const reason = "Exactly ₹10,000 is between the source's strict <10k and >10-50k labels.";
      cite(reason, 1, `Zone ${zone}, <10k and >10-50k category rows`);
      return finish("unsupported", reason);
    }
    slab = [10000, 50000, 100000, 200000].filter(upper => compareToWhole(gwp, upper) > 0).length;
    cite(`Eligible private-car GWP ₹${gwp} selects ${slabs[slab]}.`, 1, `Zone ${zone}, ${slabs[slab]} category and slab footnote`,
      ["eligible_private_car_gwp"]);
  }
  if (!startDate) {
    const reason = "Confirm the policy start date to establish whether the HDFC grid effective 1 February 2025 applies.";
    cite(reason, 1, effectiveHeading);
    return finish("ambiguous", reason, null, ["start_date"]);
  }
  cite(`The policy starts ${startDate}, on or after the grid’s effective date.`, 1, effectiveHeading, ["start_date"]);

  if (validNcb !== null && !newBusiness) {
    cite(`Current NCB is ${validNcb}%.`, 1, `Zone ${zone}, ${cover} NCB column headings`, ["current_ncb"]);
  }
  if (newBusiness && (nonPetrol || !fuel)) {
    cite("The grid treats new business as NCB for OD lookup.", 1, newBusinessFootnote, ["business_type"]);
  }
  const rows = gwp === null ? rates[zone] : [rates[zone][slab]];
  const sameRate = rows.every(row => columns.every(column => row[offset + column] === row[offset + columns[0]]));
  if (!fuel && sameRate) {
    cite("The applicable fuel columns agree, so fuel does not change the OD rate.", 1,
      `Zone ${zone}, ${cover} Petrol and Non-Petrol NCB columns`);
  }

  if (gwp === null) {
    const reason = `Zone ${zone}. Confirm eligible private-car GWP to select the OD slab. The slab uses comprehensive plus stand-alone OD GWP and excludes stand-alone TP.`;
    cite(reason, 1, "Slab footnote immediately below Zone 2");
    const result = finish("ambiguous", reason, null, ["eligible_private_car_gwp"]);
    const premium = cover === "Package" ? packagePremium(policy) : undefined;
    if (premium) {
      const example = hdfc({ ...policy, eligible_private_car_gwp: premium.amount });
      if (example.od.rate !== null) {
        result.gwp_preview = {
          amount: premium.amount, rate: example.od.rate, zone,
          sources: example.trace.at(-1)?.sources ?? [],
          policy_fields: premium.fields,
        };
      }
    }
    return result;
  }
  if ((!petrol && !nonPetrol && Boolean(fuel)) || !sameRate) {
    if (nonPetrol && validNcb !== null && !policy.business_type) {
      const fields = ["previous_insurer", "business_type"];
      const reason = "The grid treats new business as NCB even when current NCB is 0%. Confirm the business type or previous insurer to select the OD column.";
      trace.push({ step: reason, sources: [
        { file, page: 1, row: newBusinessFootnote },
        { file, page: 1, row: `Zone ${zone}, ${slabs[slab]} — ${cover}, Non-Petrol NCB and N-NCB` },
      ], policy_fields: [...fields, "current_ncb"] });
      return finish("ambiguous", reason, null, fields);
    }
    const field = nonPetrol ? "current_ncb" : "fuel";
    const reason = nonPetrol ? "Confirm current NCB to select the Non-Petrol column." :
      "Confirm fuel type to select the applicable rate column.";
    cite(reason, 1, `Zone ${zone}, ${cover} fuel and NCB columns`);
    return finish("ambiguous", reason, null, [field]);
  }
  const rate = rates[zone][slab][offset + columns[0]];
  const label = petrol ? "Petrol, NCB & N-NCB" : nonPetrol && columns.length === 1 ?
    `Non-Petrol, ${columns[0] === 1 ? "NCB" : "N-NCB"}` : "Matching fuel and NCB columns";
  const reason = `Zone ${zone}, ${cover}, ${slabs[slab]}, ${label} gives ${rate}% OD.`;
  cite(reason, 1, `Zone ${zone}, ${slabs[slab]} — ${cover}, ${label}`);
  return finish("resolved", reason, rate);
}
