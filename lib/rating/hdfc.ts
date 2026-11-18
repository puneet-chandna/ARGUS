import data from "./cards.json" with { type: "json" };
import { component, rtoCode, tidy, validRto } from "./types.ts";
import type { Facts, Parts, Status } from "./types.ts";

type Geography = [number, string, string, 1 | 2];
type LocalGeography = [string, string, string[], 1 | 2, 1 | 2];
const states = data.hdfc.states as unknown as Partial<Record<string, Geography>>;
const locals = data.hdfc.local as unknown as Partial<Record<string, LocalGeography>>;
const normalizeLocation = (value = "") => tidy(value).replace(/\band\b/g, "").replace(/\s+/g, " ").trim();
const file = data.files["hdfc-ergo"].split("/").at(-1)!;
const { rates, slabs } = data.hdfc;

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

export function hdfc(policy: Facts): Parts {
  const trace: Parts["trace"] = [];
  const cite = (step: string, page: number, row: string, policy_fields?: string[]) =>
    trace.push({ step, sources: [{ file, page, row }], ...(policy_fields && { policy_fields }) });
  if (policy.policy_type === "satp") {
    cite("The private-car grid excludes SATP from slab eligibility and publishes no SATP payout.", 1,
      "Zone 1 and Zone 2 coverage headings; slab footnote");
    return {
      od: component("inapplicable", "Stand-alone TP policy."),
      tp: component("unsupported", "The supplied HDFC grid has no SATP rate."),
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
  if (policy.start_date && policy.start_date < "2025-02-01") {
    const reason = "The policy starts before the effective date of the supplied HDFC grid.";
    cite(reason, 1, "Effective from 1st Feb’25 heading");
    return finish("unsupported", reason);
  }
  const rto = rtoCode(policy.rto);
  if (!validRto(rto)) {
    const reason = "A verified RTO code is needed to select the HDFC zone.";
    cite(reason, 1, "Geography, state and zone headers");
    return finish("ambiguous", reason, null, ["rto"]);
  }
  const state = rto.slice(0, 2);
  let geography = states[state];
  const local = locals[state];
  if (local) {
    const [region, name, cities, cityZone, restZone] = local;
    const location = normalizeLocation(policy.rto_location);
    if (!location || location === tidy(name)) {
      const reason = `The ${name} row distinguishes RTO locations. A verified city or district is required to choose a zone.`;
      cite(reason, 1, `Geography, ${region} — ${name} (Zone-1 and Zone-2)`);
      return finish("ambiguous", reason, null, ["rto_location"]);
    }
    const matchesCity = cities.some(city => location === normalizeLocation(city));
    geography = [1, region, name, matchesCity ? cityZone : restZone];
  }
  if (!geography) {
    const reason = `The supplied geography table has no verified zone for RTO prefix ${state}.`;
    cite(reason, 1, "Geography, East, South and West rows");
    cite(reason, 2, "Geography, North and Central rows");
    return finish("unsupported", reason);
  }
  const [page, region, name, zone] = geography;
  cite(`Mapped RTO ${rto} through ${name} to Zone ${zone}.`, page, `Geography, ${region} — ${name} (Zone-${zone})`,
    local ? ["rto", "rto_location"] : ["rto"]);

  const gwp = decimal(policy.eligible_private_car_gwp);
  const fuel = policy.fuel?.toLowerCase().trim() ?? "";
  const petrol = ["petrol", "gasoline", "ev", "electric", "hybrid", "petrol hybrid", "electric vehicle"].includes(fuel);
  const nonPetrol = ["diesel", "cng", "lpg"].includes(fuel) || /^petrol\s*[+/]\s*(cng|lpg)$/.test(fuel);
  const newBusiness = policy.business_type === "new";
  const ncb = decimal(policy.current_ncb?.trim().replace(/%$/, ""));
  const validNcb = ncb !== null && compareToWhole(ncb, 100) <= 0 ? ncb : null;
  const ncbColumns = newBusiness || (validNcb !== null && compareToWhole(validNcb, 0) > 0) ? [1] :
    validNcb !== null ? [2] : [1, 2];
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

  if (validNcb !== null && !newBusiness) {
    cite(`Current NCB is ${validNcb}%.`, 1, `Zone ${zone}, ${cover} NCB column headings`, ["current_ncb"]);
  }
  const rows = gwp === null ? rates[zone] : [rates[zone][slab]];
  const sameRate = rows.every(row => columns.every(column => row[offset + column] === row[offset + columns[0]]));
  if (!fuel && sameRate) {
    cite("The applicable fuel columns agree, so fuel does not change the OD rate.", 1,
      `Zone ${zone}, ${cover} Petrol and Non-Petrol NCB columns`);
  }

  if (gwp === null) {
    const reason = `Zone ${zone}. Confirm eligible private-car GWP to select the OD slab.`;
    cite("The slab uses comprehensive plus stand-alone OD private-car GWP and excludes stand-alone TP. The policy’s net OD premium does not establish this input.",
      1, "Slab footnote immediately below Zone 2");
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
