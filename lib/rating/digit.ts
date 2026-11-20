import data from "./cards.json" with { type: "json" };
import { component, integer, policyStartDate, rtoCode, validRto } from "./types.ts";
import type { Facts, Parts, Source, Status } from "./types.ts";

const RTO = "4W  RTO";
const TP = "4W SATP";
const PACKAGE = "4W New Business 1+3";
const file = data.files.godigit.split("/").at(-1)!;
const workbookMonth = "2026-03"; // The workbook filename dates this edition; the SATP sheet has no effective-date heading.
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

function inBand(raw: string, minimum: number | null, maximum = minimum): boolean | null {
  const label = raw.trim().toLowerCase();
  if (label === "" || label === "all") return true;
  if (minimum === null || maximum === null) return null;
  const threshold = /^([<>])(\d+)$/.exec(label);
  const range = /^(\d+)-(\d+)$/.exec(label);
  if (!threshold && !range) throw new Error("Unexpected Go Digit CC or age band");
  const [lower, upper] = range ? [Number(range[1]), Number(range[2])] :
    threshold![1] === "<" ? [-Infinity, Number(threshold![2]) - 1] : [Number(threshold![2]) + 1, Infinity];
  if (minimum > upper || maximum < lower) return false;
  return minimum >= lower && maximum <= upper ? true : null;
}

function vehicleAge(policy: Facts) {
  const exact = integer(policy.vehicle_age);
  const start = policyStartDate(policy.start_date);
  const years = ["manufacture_year", "registration_year"].flatMap(field => {
    const year = integer(policy[field]);
    return year !== null && year >= 1886 && year <= 2100 ? [{ field, year }] : [];
  });
  const ageFields = exact === null ? [] : ["vehicle_age"];
  if (!start || !years.length) return exact === null ? undefined :
    { min: exact, max: exact, fields: ageFields, step: `Verified vehicle age is ${exact} years.` };
  const startYear = Number(start.slice(0, 4));
  const fields = [...ageFields, "start_date", ...years.map(({ field }) => field)];
  if (years.some(({ year }) => year > startYear) || (years.length === 2 && years[0].year > years[1].year)) {
    return { min: null, max: null, fields, conflict: true, step: "The policy start date and vehicle years do not establish a consistent age." };
  }
  const manufacture = years.find(({ field }) => field === "manufacture_year")?.year;
  const oldest = manufacture === undefined ? Infinity : startYear - manufacture;
  const youngest = startYear - years.at(-1)!.year;
  const min = Math.max(0, youngest - (start.endsWith("-12-31") ? 0 : 1));
  if (exact !== null) return exact < min || exact > oldest
    ? { min: null, max: null, fields, conflict: true, step: `The stated vehicle age of ${exact} years conflicts with the policy start date and vehicle years.` }
    : { min: exact, max: exact, fields, step: `The stated vehicle age of ${exact} years agrees with the policy start date and vehicle years.` };
  const ageText = oldest === Infinity ? `at least ${min}` : min === oldest ? String(oldest) : `${min}–${oldest}`;
  const step = `The verified vehicle year${years.length === 1 ? "" : "s"} and policy start date imply ${ageText} completed years of age.`;
  return { min, max: oldest, fields, step };
}

function restriction(note: string, cc: number | null, belowTen: boolean | null): Status | null {
  const midCapacity = cc === null || (cc >= 1000 && cc <= 1500);
  if (note === "1000-1500CC and <10 age is declined") {
    if (!midCapacity || belowTen === false) return null;
    return cc === null || belowTen === null ? "ambiguous" : "unsupported";
  }
  if (note.toLowerCase().includes("more than 1500cc and 10+age")) {
    if ((cc !== null && cc <= 1500) || belowTen === true) return null;
    return note.startsWith("Few RTOs") || cc === null || belowTen === null ? "ambiguous" : "unsupported";
  }
  if (note === "Few RTOs for 10+ age are declined" && belowTen === true) return null;
  if (note === "Few RTOs for <10 age are declined" && belowTen === false) return null;
  if (note === "Few RTOs for 1000-1500CC segment are declined" && !midCapacity) return null;
  return "ambiguous";
}

export function digit(policy: Facts): Parts {
  const trace: Parts["trace"] = [];
  const cite = (step: string, ...sources: Source[]) => trace.push({ step, sources });
  const od = component("inapplicable", "Stand-alone TP policy.");
  const finish = (status: Status, reason: string, rate: string | null = null, review_fields?: readonly string[]): Parts =>
    ({ od, tp: component(status, reason, rate), trace, ...(review_fields ? { review_fields } : {}) });

  if (policy.policy_type !== "satp") {
    const reason = "The 4W New Business 1+3 sheet publishes CD2 payouts without establishing the OD/TP component premium basis. The supplied evidence cannot establish a component rate for this policy.";
    cite(reason, source(TP, "B2:E2"), source(PACKAGE, "B2:I3"));
    return { ...finish("ambiguous", reason), od: component("ambiguous", reason) };
  }
  if (policy.vehicle_class !== "private_car") {
    const reason = "The 4W SATP lookup requires verified private-car classification.";
    cite(reason, source(TP, "B2:E2"), source(RTO, "B2:C2"));
    return policy.vehicle_class ? finish("unsupported", reason) : finish("ambiguous", reason, null, ["vehicle_class"]);
  }
  const startDate = policyStartDate(policy.start_date);
  const edition = source(TP, "B2:F2");
  if (!startDate) {
    const reason = "Confirm the policy start date to check the dated Go Digit SATP workbook.";
    cite(reason, edition);
    return finish("ambiguous", reason, null, ["start_date"]);
  }
  if (startDate.slice(0, 7) !== workbookMonth) {
    const reason = "The supplied Go Digit SATP workbook is dated March 2026. The corpus has no SATP grid for the policy’s start month.";
    trace.push({ step: reason, sources: [edition], policy_fields: ["start_date"] });
    return finish("unsupported", reason);
  }
  trace.push({ step: `The policy starts ${startDate}, within the workbook’s March 2026 edition.`,
    sources: [edition], policy_fields: ["start_date"] });
  const rto = rtoCode(policy.rto);
  if (!validRto(rto)) {
    const reason = "A verified RTO code is needed to select the 4WTP cluster.";
    cite(reason, source(RTO, "B2:C2"));
    return finish("ambiguous", reason, null, ["rto"]);
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
    return finish("ambiguous", reason, null, ["fuel"]);
  }
  const cc = integer(policy.engine_cc) || null;
  const age = vehicleAge(policy);
  const belowTen = inBand("<10", age?.min ?? null, age?.max ?? null);
  const clusterRates = rates.filter(([, label]) => [clusterKey, clusters[clusterKey]].includes(label.toLowerCase()));
  const matched: { row: RateRow; citation: Source; missing: string[]; ageAffectsNote: boolean }[] = [];
  const fuelSources: Source[] = [];
  const ageSources: Source[] = [];
  for (const row of clusterRates) {
    const [i, , segment, ageBand, , note] = row;
    const label = /^(CNG|Diesel|Petrol)\s*(.*)$/i.exec(segment);
    if (!label || label[1].toLowerCase() !== fuel) continue;
    const citation = source(TP, `B${i}:${note ? "F" : "E"}${i}`);
    fuelSources.push(citation);
    const ccMatch = inBand(label[2], cc);
    if (ccMatch === false) continue;
    const ageMatch = inBand(ageBand, age?.min ?? null, age?.max ?? null);
    const ageAffectsNote = !!note && restriction(note, cc, true) !== restriction(note, cc, false);
    if (ageBand !== "All" || ageAffectsNote) ageSources.push(citation);
    if (ageMatch === false) continue;
    matched.push({ row, citation, ageAffectsNote,
      missing: [...(ccMatch === null ? ["engine_cc"] : []), ...(ageMatch === null ? ["vehicle_age"] : [])] });
  }
  if (age && ageSources.length) trace.push({ step: age.step, sources: ageSources, policy_fields: age.fields });
  if (age?.conflict && ageSources.length) return finish("ambiguous", age.step, null, age.fields);
  const review = [...new Set(matched.flatMap(({ missing }) => missing))];
  if (review.length) {
    const missing = review.map(field => field === "engine_cc" ? "engine capacity (cc)" : "vehicle age").join(" and ");
    const reason = `A verified ${missing} is needed to establish the applicable SATP band.`;
    cite(reason, source(TP, "B2:F2"), ...matched.map(({ citation }) => citation));
    return finish("ambiguous", reason, null, review);
  }
  if (!matched.length) {
    const reason = fuelSources.length ? `The ${cluster} rows have no matching ${fuel} CC and age band.` :
      `The ${cluster} rows have no documented ${fuel} segment.`;
    cite(reason, source(TP, "B2:F2"), ...(fuelSources.length ? fuelSources : clusterRates.map(([i]) => source(TP, `B${i}:C${i}`))));
    return finish("unsupported", reason);
  }
  const outcomes = new Set<string>();
  for (const { row, citation, ageAffectsNote } of matched) {
    const [, label, segment, band, rate, note] = row;
    cite(`Selected ${label} / ${segment} / age ${band} by the SATP row labels.`, citation);
    if (note) {
      const result = restriction(note, cc, belowTen);
      if (result) {
        const reason = result === "unsupported" ? `${note}.` : `The available facts do not clear the source restriction: ${note}.`;
        cite(reason, citation);
        return finish(result, reason, null, result === "ambiguous" ? [...(cc === null && /cc/i.test(note) ? ["engine_cc"] : []),
          ...(belowTen === null && ageAffectsNote ? ["vehicle_age"] : [])] : undefined);
      }
      cite(`Checked the row’s restriction: ${note}.`, citation);
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
