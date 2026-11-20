import data from "./cards.json" with { type: "json" };
import { component, policyStartDate, rtoCode, tidy, validRto } from "./types.ts";
import type { Facts, Parts, Source, Status } from "./types.ts";

const file = data.files["tata-aig"].split("/").at(-1)!;
const effectiveDate = "2025-11-01";
const editionMonth = "2026-03";
// Pvtcar M1:BO1 marks these payout columns as Updated in the March edition.
const updatedColumns = new Set("M O P S T U V W Z AA AC AD AH AL AM AP AQ AZ BF BL BM BN".split(" "));
type PayoutRow = [row: number, vehicleType: string, business: string, fuel: string, coverage: string,
  ncb: string, addOn: string, rates: (string | null)[]];
const rows = data.tata.rows as PayoutRow[];
const types = new Set(rows.map(([, type]) => type));
const source = (sheet: string, cells: string): Source => ({ file, sheet, cells });
const registrationStates: Partial<Record<string, [string, number]>> = {
  AN: ["Andaman and Nicobar", 62], AP: ["Andhra Pradesh", 62], AR: ["Arunachal Pradesh", 62], AS: ["Assam", 62],
  BR: ["Bihar", 62], CG: ["Chhattisgarh", 62], CH: ["Chandigarh", 62], DD: ["Daman and Diu", 62],
  DN: ["Dadra and Nagar Haveli", 62],
  DL: ["Delhi", 62], GA: ["Goa", 62], GJ: ["Gujarat", 62], HR: ["Haryana", 62],
  HP: ["Himachal Pradesh", 62], JK: ["Jammu and Kashmir", 62], JH: ["Jharkhand", 62], KA: ["Karnataka", 62],
  KL: ["Kerala", 62], LD: ["Lakshadweep", 62], MP: ["Madhya Pradesh", 62], MH: ["Maharashtra", 62],
  ML: ["Meghalaya", 62], MN: ["Manipur", 62], MZ: ["Mizoram", 62], NL: ["Nagaland", 62], OR: ["Orissa", 62],
  PB: ["Punjab", 63], PY: ["Pondicherry", 63], RJ: ["Rajasthan", 63], SK: ["Sikkim", 63],
  TG: ["Telangana", 64], TN: ["Tamil Nadu", 63], TR: ["Tripura", 63], UP: ["Uttar Pradesh", 63],
  UK: ["Uttarakhand", 63], WB: ["West Bengal", 63],
};
const odishaRtos: Source = {
  file: "Rules_1611819449.pdf",
  url: "https://odishatransport.gov.in/Application/uploadDocuments/Notification/Rules_1611819449.pdf",
  page: 1, row: "Odisha Motor Vehicle Department RTO directory, OD codes",
};
const registrationSource = (prefix: string, [name, page]: [string, number]): Source => {
  if (prefix === "TG" || prefix === "TS") return {
    file: "AR-MoRTH_Annual Report_2023-24_English.pdf",
    url: "https://morth.gov.in/sites/default/files/AR-MoRTH_Annual%20Report_2023-24_English.pdf",
    row: "Section 6.5.15, Telangana (TG replacing TS), printed page 64",
  };
  if (prefix === "OD") return odishaRtos;
  return {
    file: "Appendices .pdf",
    url: "https://morth.gov.in/sites/default/files/Appendices%20.pdf",
    row: `Appendix XIII, ${name} (${prefix}), printed page ${page}`,
  };
};

// shortcut: city rates use only listed offices when a code is supplied, extend office coverage with official rows.
// City row numbers refer to PIB's DIPAM Annexure I. The Tata workbook alone determines the payout column.
const cityStates = new Map<string, [string, number | Source]>([
  ["vijaywada", ["AP", 1]], ["vishakapatnam", ["AP", 2]], ["ahmedabad", ["GJ", 14]], ["surat", ["GJ", 15]],
  ["rajkot", ["GJ", 16]], ["bangalore", ["KA", 24]], ["indore", ["MP", 30]], ["mumbai", ["MH", 34]],
  ["pune", ["MH", 35]], ["nagpur", ["MH", 36]], ["bhubaneshwar", ["OR", 42]], ["jaipur", ["RJ", 44]],
  ["chennai", ["TN", 48]], ["coimbatore", ["TN", 52]], ["hyderabad", ["TG", 53]], ["kolkata", ["WB", 65]],
  ["vadodara", ["GJ", {
    file: "District Vadodara, Government of Gujarat — About District", url: "https://vadodara.nic.in/about-district/",
  }]],
]);
const stateAliases = new Map([
  ["andra pradesh", "andhra pradesh"], ["jammu kashmir", "jammu and kashmir"],
  ["telengana", "telangana"], ["odisha", "orissa"],
]);
const payoutAliases = new Map([
  ["andhra pradesh", "andra pradesh"], ["bengaluru", "bangalore"], ["bhubaneswar", "bhubaneshwar"],
  ["bombay", "mumbai"], ["jammu and kashmir", "jammu kashmir"],
  ["telangana", "telengana"], ["vijayawada", "vijaywada"],
  ["visakhapatnam", "vishakapatnam"], ["vishakhapatnam", "vishakapatnam"],
]);
const citySpellingSources = new Map<string, Source>([
  ["bangalore", {
    file: "PIB — Renaming of Cities",
    url: "https://www.pib.gov.in/newsite/PrintRelease.aspx?lang=2&reg=48&relid=113433",
    row: "Bangalore → Bengaluru",
  }],
  ["bhubaneswar", { ...odishaRtos, row: "Bhubaneswar-I, row 2" }],
  ["bombay", { file: "Mumbai City — About District", url: "https://mumbaicity.gov.in/en/about-district/" }],
]);
const maharashtraOffices: Source = {
  file: "Maharashtra Motor Vehicle Department — Organization Structure",
  url: "https://transport.maharashtra.gov.in/1203/Organization-Structure",
  row: "Regional Transport Office and Office Code",
};
const karnatakaAudit = "Report-of-the-Comptroller-and-Auditor-General-of-India-on-State-Revenues-for-the-period-ended-March-2024--Report-No.-3-of-2026-069c60d8a133e16.82085064.pdf";
const karnatakaOffices: Source = {
  file: karnatakaAudit, url: `https://cag.gov.in/uploads/download_audit_report/2026/${karnatakaAudit}`,
  page: 186, row: "Appendix 5.5, RTO Code and Name Of RTO Office",
};
const tamilNaduOffices: Source = {
  file: "Tamil Nadu State Transport Authority — March 2023 Information Booklet",
  url: "https://tnsta.gov.in/pdfpage/pdfpage_tn_4QJezuj_2023_07_20.pdf",
  page: 7, row: "RTO / Unit Office code",
};
const namedOffices: [place: string, codes: string, evidence: Source][] = [
  ["Mumbai", "MH01 MH02 MH03", maharashtraOffices],
  ["Pune", "MH12", maharashtraOffices],
  ["Nagpur", "MH31 MH40 MH49", maharashtraOffices],
  ["Bengaluru", "KA01 KA02 KA03 KA04 KA05", karnatakaOffices],
  ["Mysuru", "KA09", karnatakaOffices],
  ["Mysuru", "KA55", { ...karnatakaOffices, page: 187 }],
  ["Chennai", "TN01 TN02 TN03 TN04 TN05 TN06 TN07 TN09 TN10", tamilNaduOffices],
  ["Coimbatore", "TN37 TN38 TN66 TN99", { ...tamilNaduOffices, page: 8 }],
];
// shortcut: split-state OD uses the listed offices outside named city columns, extend with sourced office evidence.
const andhraStateOffices = new Map([
  ["AP02", ["Anantapur", "A6:C6"]],
  ["AP03", ["Tirupathi", "A7:C7"]],
  ["AP04", ["Kadapa", "A8:C8"]],
]);

export function tata(policy: Facts): Parts {
  const trace: Parts["trace"] = [];
  const cite = (step: string, ...sources: Source[]) => trace.push({ step, sources });
  const standaloneTp = policy.policy_type === "satp";
  const finish = (status: Status, reason: string, review_fields?: readonly string[], rate: string | null = null): Parts => {
    const packageTp = policy.vehicle_class === "private_car" && policy.policy_type === "comprehensive";
    const tpReason = "The standard grid publishes package payouts on OD premium only; it supplies no package TP rate.";
    if (packageTp) cite(tpReason, source("General Guidelines", "C7"), source("Pvtcar", "F2"));
    return {
      od: standaloneTp ? component("inapplicable", "Stand-alone TP policy.") : component(status, reason, rate),
      tp: policy.policy_type === "saod" ? component("inapplicable", "Stand-alone OD policy.") :
        packageTp ? component("unsupported", tpReason) : component(status, reason, standaloneTp ? rate : null),
      trace, ...(review_fields ? { review_fields } : {}),
    };
  };
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
  if (!policy.rto_location?.trim()) {
    const reason = "Confirm the RTO location to select the Tata AIG payout cluster.";
    cite(reason, source("General Guidelines", "C10"), source("Pvtcar", "G5:BO5"));
    return finish("ambiguous", reason, ["rto_location"]);
  }

  const location = tidy(policy.rto_location);
  const payoutLocation = payoutAliases.get(location) ?? location;
  const clusters = data.tata.clusters.filter(([, label]) => tidy(label) === payoutLocation);
  const cluster = clusters.length === 1 ? clusters[0] : undefined;
  const jurisdiction = stateAliases.get(location) ?? location;
  const code = rtoCode(policy.rto);
  const prefix = code.slice(0, 2);
  const statePrefix = prefix === "OD" ? "OR" : prefix === "TS" ? "TG" : prefix;
  const codeState = validRto(code) ? registrationStates[statePrefix] : undefined;
  const city = cityStates.get(payoutLocation);
  const locationPrefix = city?.[0] ?? Object.entries(registrationStates).find(([, entry]) => tidy(entry?.[0]) === jurisdiction)?.[0];
  const locationState = locationPrefix && registrationStates[locationPrefix];
  if (!standaloneTp && !codeState) {
    const reason = "Confirm the RTO code to verify the registration jurisdiction for the OD payout column.";
    cite(reason, source("General Guidelines", "C10"));
    return finish("ambiguous", reason, ["rto"]);
  }
  const locationSources: Source[] = [];
  if (city) {
    const citySource = city[1];
    locationSources.push(typeof citySource === "number" ? {
      file: "doc20226962901.pdf",
      url: "https://static.pib.gov.in/WriteReadData/specificdocs/documents/2022/jun/doc20226962901.pdf",
      page: citySource <= 36 ? 3 : 4, row: `DIPAM Annexure I, city row ${citySource}`,
    } : citySource);
  }
  const citySpelling = citySpellingSources.get(location) ?? citySpellingSources.get(payoutLocation);
  if (citySpelling) locationSources.push(citySpelling);
  const fields = ["rto", "rto_location"];
  const officeCode = prefix + code.slice(2).padStart(2, "0");
  const office = city && codeState && locationPrefix === statePrefix
    ? namedOffices.find(([, codes]) => codes.split(" ").includes(officeCode)) : undefined;
  if (codeState && locationPrefix && locationState) {
    const codeSource = registrationSource(prefix, codeState);
    const stateName = (state: string) => state === "Orissa" ? "Odisha" : state;
    const locationStateName = stateName(locationState[0]);
    const officeName = tidy(office?.[0]);
    const officeConflict = office && (payoutAliases.get(officeName) ?? officeName) !== payoutLocation;
    const officeSources = office ? [{ ...office[2], row: `${office[2].row}, ${officeCode}` }] : [];
    if (locationPrefix !== statePrefix || officeConflict) {
      const discrepancy = officeConflict
        ? `The RTO code ${policy.rto} identifies a registration office in ${office[0]}. The policy lists ${policy.rto_location} as its RTO location.`
        : `The RTO code ${policy.rto} uses the ${stateName(codeState[0])} registration prefix. The policy’s RTO location (${policy.rto_location}) points to ${locationStateName}.`;
      const reason = `${discrepancy} Confirm the code and location before selecting a payout column.`;
      trace.push({ step: reason, policy_fields: fields, sources: [
        codeSource, ...officeSources,
        ...(locationSources.length ? locationSources : [registrationSource(locationPrefix, locationState)]),
        source("General Guidelines", "C10"),
        ...(cluster ? [source("Pvtcar", `${cluster[0]}5`)] : []),
      ] });
      return finish("ambiguous", reason, fields);
    }
    trace.push({ step: `The RTO code and policy location are consistent with ${locationStateName}.`,
      policy_fields: fields, sources: [codeSource, ...locationSources, ...officeSources] });
  }
  if (!cluster || (!standaloneTp && !locationState)) {
    const reason = !cluster ? "The policy’s RTO location does not match a unique payout cluster in the supplied grid."
      : "The available office evidence does not map the policy’s RTO to this payout cluster.";
    cite(reason, source("General Guidelines", "C10"), source("Pvtcar", "M5:BO5"));
    return finish("ambiguous", reason);
  }

  const [column, label] = cluster;
  if (city && policy.rto?.trim() && !office) {
    const reason = `The available workbook and office evidence do not establish whether RTO code ${policy.rto} belongs to the ${label} payout cluster.`;
    trace.push({ step: reason, policy_fields: fields,
      sources: [source("General Guidelines", "C10"), source("Pvtcar", `${column}5`), ...locationSources] });
    return finish("ambiguous", reason);
  }
  const cityColumns = column === "N" ? "BM5:BN5" : column === "BG" ? "Z5" : null;
  if (!standaloneTp && cityColumns) {
    const stateOffice = column === "N" ? andhraStateOffices.get(officeCode) : undefined;
    const sources = [source("General Guidelines", "C10"), source("Pvtcar", `${column}5`), source("Pvtcar", cityColumns)];
    if (!stateOffice) {
      const reason = "The state has separate city payout columns. The available office evidence does not establish the applicable column.";
      trace.push({ step: reason, sources, policy_fields: fields });
      return finish("ambiguous", reason);
    }
    const [place, cells] = stateOffice;
    const directory = data.files.godigit.split("/").at(-1)!;
    trace.push({
      step: `The RTO directory places ${officeCode} in ${place}, outside the named city columns for ${label}.`,
      sources: [...sources, { file: directory, sheet: "CV RTO Mapping", cells: "A2:C2" },
        { file: directory, sheet: "CV RTO Mapping", cells }],
      policy_fields: fields,
    });
  }
  trace.push({
    step: `The policy’s RTO location matches the ${label} payout column.`,
    sources: [source("General Guidelines", "C10"), source("Pvtcar", `${column}5`),
      ...(payoutLocation !== location ? locationSources : [])],
    policy_fields: ["rto_location"],
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
  const coverage = policy.policy_type === "comprehensive" ? "package" : policy.policy_type;
  const gridFuel = fuel === "petrol" ? "other than diesel" : fuel;
  const matches = rows.filter(([, , b, f, c]) => tidy(b) === business && tidy(f) === gridFuel && tidy(c) === coverage);
  const usesNcbAndAddOn = !standaloneTp && business !== "brand new";
  const ncb = /^(\d{1,3})(?:\.(\d+))?%?$/.exec(policy.current_ncb?.trim() ?? "");
  const fraction = /[1-9]/.test(ncb?.[2] ?? "");
  const ncbCategory = ncb && (Number(ncb[1]) < 100 || (Number(ncb[1]) === 100 && !fraction))
    ? (Number(ncb[1]) > 0 || fraction ? "Yes" : "No") : null;
  const ncbBands = usesNcbAndAddOn ? ncbCategory ? [ncbCategory] : ["Yes", "No"] : ["All"];
  const addOnBands = usesNcbAndAddOn ? ["Yes", "No"] : ["All"];
  // The policy facts have no general add-on flag. Both printed add-on alternatives must agree.
  const agreedRate = (candidates: PayoutRow[], ncbBandCount: number) => {
    const value = candidates[0]?.[7][index];
    const combinations = new Set(candidates.map(([, type, , , , rowNcb, addOn]) => `${type}:${rowNcb}:${addOn}`));
    return value != null && combinations.size === types.size * ncbBandCount * addOnBands.length &&
      candidates.every(row => row[7][index] === value) ? value : null;
  };
  const eligible = matches.filter(([, , , , , rowNcb, addOn]) => ncbBands.includes(rowNcb) && addOnBands.includes(addOn));
  const rowSources = eligible.map(([row]) => source("Pvtcar", `G${row}:L${row}`));
  const ncbFields = usesNcbAndAddOn && ncbCategory ? ["current_ncb"] : [];
  const value = agreedRate(eligible, ncbBands.length);
  const part = standaloneTp ? "TP" : "OD";
  if (value === null) {
    const noRate = !matches.length || eligible.length > 0 && eligible.every(row => row[7][index] == null);
    const needsNcb = !noRate && ncbBands.length === 2 &&
      ncbBands.some(band => agreedRate(eligible.filter(row => row[5] === band), 1) !== null);
    const reason = noRate ? `The supplied ${coverage.toUpperCase()} rows publish no numeric ${part} rate for this fuel, business and cluster.` :
      needsNcb ? "Confirm the current NCB percentage to select the NCB row." :
      `The supplied rows do not establish one ${part} rate across vehicle Types${usesNcbAndAddOn ? " and applicable NCB and add-on categories" : ""}. The workbook does not map make and model to Type.`;
    trace.push({ step: reason, sources: [source("Pvtcar", `${column}5`), ...rowSources,
      ...(!eligible.length ? [source("Pvtcar", "G5:L565")] : []),
      ...eligible.map(([row]) => source("Pvtcar", `${column}${row}`))],
      ...(ncbFields.length ? { policy_fields: ncbFields } : {}) });
    return finish(noRate ? "unsupported" : "ambiguous", reason, needsNcb ? ["current_ncb"] : undefined);
  }

  const basis = standaloneTp ? "net premium" : "OD premium";
  const caveat = "GWP-based increments can apply. Policy-specific and other overrides take priority.";
  cite(`The standard grid applies to ${basis}. ${caveat}`,
    source("General Guidelines", "C5"), source("General Guidelines", "C7"),
    source("General Guidelines", "C11:C17"), source("Pvtcar", "F2:F3"));
  cite(`Every vehicle Type gives ${value}% base ${part} for ${eligible[0][3]} ${coverage.toUpperCase()} ${business}${usesNcbAndAddOn
    ? `, across both add-on categories and ${ncbCategory ? `NCB ${ncbCategory}` : "both NCB categories"}` : ""}.`, ...rowSources);
  trace.push({
    step: `The ${label} column gives ${value}% base ${part} across all vehicle Types.`,
    sources: [source("Pvtcar", eligible.map(([row]) => `${column}${row}`).join(", "))],
    policy_fields: ["fuel", "vehicle_class", "policy_type", "insurer", "previous_insurer", "business_type", ...ncbFields],
  });
  return finish("resolved", `${label} standard-grid base on ${basis}. ${caveat}`, undefined, value);
}
