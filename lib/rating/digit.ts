import data from "./cards.json" with { type: "json" };
import { component, integer, rtoCode, validRto } from "./types.ts";
import type { Facts, Parts, Source, Status } from "./types.ts";

const RTO = "4W  RTO";
const TP = "4W SATP";
const PACKAGE = "4W New Business 1+3";
const file = data.files.godigit.split("/").at(-1)!;
const clusters: Record<string, string> = {
  delhi: "delhi/ncr", ncr: "delhi/ncr",
  "ap ts_good1": "ap ts_good1/good2", "ap ts_good2": "ap ts_good1/good2",
  jh_bad: "jh_bad/jh_good", jh_good: "jh_bad/jh_good",
};
type RtoRow = [number, string, string];
type RateRow = [number, string, string, string, string | null, string | null];
const rtos = data.digit.rtos as RtoRow[];
const rates = data.digit.tp as RateRow[];
const source = (sheet: string, cells: string): Source => ({ file, sheet, cells });

function inBand(raw: string, value: number | null): boolean | null {
  const label = raw.trim().toLowerCase();
  if (label === "" || label === "all") return true;
  const threshold = /^([<>])(\d+)$/.exec(label);
  if (threshold) return value === null ? null : threshold[1] === "<" ? value < Number(threshold[2]) : value > Number(threshold[2]);
  const range = /^(\d+)-(\d+)$/.exec(label);
  if (range) return value === null ? null : value >= Number(range[1]) && value <= Number(range[2]);
  throw new Error("Unexpected Go Digit CC or age band");
}

function restriction(note: string, cc: number | null, age: number | null): Status | null {
  const midCapacity = cc === null || (cc >= 1000 && cc <= 1500);
  if (note === "1000-1500CC and <10 age is declined") {
    if (!midCapacity || (age !== null && age >= 10)) return null;
    return cc === null || age === null ? "ambiguous" : "unsupported";
  }
  if (note.toLowerCase().includes("more than 1500cc and 10+age")) {
    if ((cc !== null && cc <= 1500) || (age !== null && age < 10)) return null;
    return note.startsWith("Few RTOs") || cc === null || age === null ? "ambiguous" : "unsupported";
  }
  if (note === "Few RTOs for 10+ age are declined" && age !== null && age < 10) return null;
  if (note === "Few RTOs for <10 age are declined" && age !== null && age >= 10) return null;
  if (note === "Few RTOs for 1000-1500CC segment are declined" && !midCapacity) return null;
  return "ambiguous";
}

export function digit(policy: Facts): Parts {
  const trace: Parts["trace"] = [];
  const cite = (step: string, ...sources: Source[]) => trace.push({ step, sources });
  const od = component("inapplicable", "Stand-alone TP policy.");
  const finish = (status: Status, reason: string, rate: string | null = null): Parts =>
    ({ od, tp: component(status, reason, rate), trace });

  if (policy.policy_type !== "satp") {
    const reason = "This Go Digit lookup covers private-car stand-alone TP. The 4W New Business 1+3 sheet requires a separate lookup.";
    cite(reason, source(TP, "B2:E2"), source(PACKAGE, "B2:I3"));
    return { ...finish("unsupported", reason), od: component("unsupported", reason) };
  }
  if (policy.vehicle_class !== "private_car") {
    const reason = "The 4W SATP lookup requires verified private-car classification.";
    cite(reason, source(TP, "B2:E2"), source(RTO, "B2:C2"));
    return finish(policy.vehicle_class ? "unsupported" : "ambiguous", reason);
  }
  const rto = rtoCode(policy.rto);
  if (!validRto(rto)) {
    const reason = "A verified RTO code is needed to select the 4WTP cluster.";
    cite(reason, source(RTO, "B2:C2"));
    return finish("ambiguous", reason);
  }
  const mappings = rtos.filter(([, code]) => rtoCode(code) === rto);
  if (!mappings.length) {
    const reason = `The 4WTP column contains no cluster for ${rto}.`;
    cite(reason, source(RTO, `B2:C${data.digit.rtoEnd}`));
    return finish("unsupported", reason);
  }
  const cluster = mappings[0][2];
  const clusterKey = cluster.toLowerCase();
  const mappingSources = mappings.map(([i]) => source(RTO, `B${i}:C${i}`));
  if (mappings.some(([, , name]) => name.toLowerCase() !== clusterKey)) {
    const reason = `The workbook maps ${rto} to conflicting 4WTP clusters.`;
    cite(reason, source(RTO, "B2:C2"), ...mappingSources);
    return finish("ambiguous", reason);
  }
  cite(`Mapped ${rto} to ${cluster} through the 4WTP column.`, source(RTO, "B2:C2"), ...mappingSources);
  if (clusterKey === "all_india_decline") {
    const reason = "The RTO belongs to the workbook’s All_India_Decline cluster.";
    cite(reason, source(TP, "B3:E8"));
    return finish("unsupported", reason);
  }

  const rawFuel = policy.fuel?.toLowerCase().trim().replace(/\s+/g, " ");
  const fuel = rawFuel === "gasoline" ? "petrol" : /^petrol\s*[+/]\s*cng$/.test(rawFuel ?? "") ? "cng" : rawFuel;
  if (!fuel) {
    const reason = "A verified fuel type is needed to select a SATP segment.";
    cite(reason, source(TP, "B2:F2"));
    return finish("ambiguous", reason);
  }
  const cc = integer(policy.engine_cc) || null;
  const age = integer(policy.vehicle_age);
  const clusterRates = rates.filter(([, label]) => [clusterKey, clusters[clusterKey]].includes(label.toLowerCase()));
  const matched: { row: RateRow; citation: Source; incomplete: boolean }[] = [];
  const fuelSources: Source[] = [];
  for (const row of clusterRates) {
    const [i, , segment, ageBand, , note] = row;
    const label = /^(CNG|Diesel|Petrol)\s*(.*)$/i.exec(segment);
    if (!label || label[1].toLowerCase() !== fuel) continue;
    const citation = source(TP, `B${i}:${note ? "F" : "E"}${i}`);
    fuelSources.push(citation);
    const ccMatch = inBand(label[2], cc);
    const ageMatch = inBand(ageBand, age);
    if (ccMatch === false || ageMatch === false) continue;
    matched.push({ row, citation, incomplete: ccMatch === null || ageMatch === null });
  }
  if (matched.some(({ incomplete }) => incomplete)) {
    const missing = [cc === null ? "engine CC" : "", age === null ? "vehicle age" : ""].filter(Boolean).join(" or ");
    const reason = `A verified ${missing} is needed to establish the applicable SATP band.`;
    cite(reason, source(TP, "B2:F2"), ...matched.map(({ citation }) => citation));
    return finish("ambiguous", reason);
  }
  if (!matched.length) {
    const reason = fuelSources.length ? `The ${cluster} rows have no matching ${fuel} CC and age band.` :
      `The ${cluster} rows have no documented ${fuel} segment.`;
    cite(reason, source(TP, "B2:F2"), ...(fuelSources.length ? fuelSources : clusterRates.map(([i]) => source(TP, `B${i}:C${i}`))));
    return finish("unsupported", reason);
  }
  const outcomes = new Set<string>();
  for (const { row, citation } of matched) {
    const [, label, segment, band, rate, note] = row;
    cite(`Selected ${label} / ${segment} / age ${band} by the SATP row labels.`, citation);
    if (note) {
      cite(`Checked the row’s restriction: ${note}.`, citation);
      const result = restriction(note, cc, age);
      if (result) return finish(result, result === "unsupported" ? `${note}.` : `The available facts do not clear the source restriction: ${note}.`);
    }
    if (rate === null) {
      const reason = "The matching SATP row has no numeric Max CD2 rate.";
      cite(reason, citation);
      return finish("unsupported", reason);
    }
    outcomes.add(rate);
  }
  const citations = matched.map(({ citation }) => citation);
  if (outcomes.size !== 1) {
    const reason = "The SATP source contains matching rows with different Max CD2 rates.";
    cite(reason, ...citations);
    return finish("ambiguous", reason);
  }
  const rate = [...outcomes][0];
  const reason = `The matching Max CD2 cell publishes ${rate}% TP.`;
  cite(reason, source(TP, "E2"), ...citations);
  return finish("resolved", reason, rate);
}
