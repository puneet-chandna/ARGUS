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

export function hdfc(policy: Facts): Parts {
  const trace: Parts["trace"] = [];
  const cite = (step: string, page: number, row: string) => trace.push({ step, sources: [{ file, page, row }] });
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
  const finish = (status: Status, reason: string, rate: string | null = null): Parts => ({ od: component(status, reason, rate), tp, trace });

  if (policy.vehicle_class !== "private_car") {
    const reason = "The supplied HDFC grid requires a private-car policy.";
    cite(reason, 1, "Slab footnote, PVT CAR eligibility");
    return finish(policy.vehicle_class ? "unsupported" : "ambiguous", reason);
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
    return finish("ambiguous", reason);
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
      return finish("ambiguous", reason);
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
  cite(`Mapped RTO ${rto} through ${name} to Zone ${zone}.`, page, `Geography, ${region} — ${name} (Zone-${zone})`);

  const gwp = decimal(policy.eligible_private_car_gwp);
  const fuel = policy.fuel?.toLowerCase().trim() ?? "";
  const petrol = ["petrol", "gasoline", "ev", "electric", "hybrid", "petrol hybrid", "electric vehicle"].includes(fuel);
  const nonPetrol = ["diesel", "cng", "lpg"].includes(fuel) || /^petrol\s*[+/]\s*(cng|lpg)$/.test(fuel);
  const newBusiness = policy.business_type === "new";
  const ncb = decimal(policy.current_ncb?.trim().replace(/%$/, ""));
  const blockers: string[] = [];
  let slab = 0;
  if (gwp === null) {
    blockers.push("A verified eligible private-car GWP is missing");
    cite("The source slab uses comprehensive plus SAOD private-car GWP, excluding SATP. The policy's net OD premium alone does not establish this input.",
      1, "Slab footnote immediately below Zone 2");
  } else {
    const edge = compareToWhole(gwp, 10000);
    if (edge === 0) {
      const reason = "Exactly ₹10,000 is between the source's strict <10k and >10-50k labels.";
      cite(reason, 1, `Zone ${zone}, <10k and >10-50k category rows`);
      return finish("unsupported", reason);
    }
    slab = [10000, 50000, 100000, 200000].filter(upper => compareToWhole(gwp, upper) > 0).length;
    cite(`Eligible private-car GWP ₹${gwp} selects ${slabs[slab]}.`, 1, `Zone ${zone}, ${slabs[slab]} category and slab footnote`);
  }
  const hasNcb = newBusiness || ncb !== null && compareToWhole(ncb, 0) > 0;
  if (nonPetrol) {
    cite(`${fuel.toUpperCase()} uses the Non-Petrol columns.`, 1, "Non Petrol fuel footnote");
    if (!newBusiness && (ncb === null || compareToWhole(ncb, 100) > 0)) {
      blockers.push("A verified current NCB is needed for Non-Petrol");
    } else {
      cite(newBusiness ? "New business uses NCB under the grid footnote." :
        `Current NCB ${ncb}% selects ${hasNcb ? "NCB" : "N-NCB"}.`,
      1, `Zone ${zone}, ${cover} Non-Petrol NCB headings and new-business footnote`);
    }
  } else if (petrol) {
    cite(`${fuel} uses the Petrol column, shared by both NCB bands.`, 1, `Zone ${zone}, ${cover} Petrol column and EV/Hybrid footnote`);
  } else {
    blockers.push("A verified fuel in the HDFC classification is missing");
    cite(`${blockers.at(-1)}.`, 1, "Non Petrol and EV/Hybrid footnotes");
  }
  if (blockers.length) {
    const reason = blockers.join(". ") + ".";
    cite(reason, 1, `Zone ${zone}, ${cover} category and fuel/NCB headers`);
    return finish("ambiguous", reason);
  }
  const column = (cover === "SAOD" ? 3 : 0) + (petrol ? 0 : hasNcb ? 1 : 2);
  const rate = rates[zone][slab][column];
  const label = petrol ? "Petrol, NCB & N-NCB" : `Non-Petrol, ${hasNcb ? "NCB" : "N-NCB"}`;
  const reason = `Zone ${zone}, ${cover}, ${slabs[slab]}, ${label} gives ${rate}% OD.`;
  cite(reason, 1, `Zone ${zone}, ${slabs[slab]} — ${cover}, ${label}`);
  return finish("resolved", reason, rate);
}
