import { policyCoverage } from "../rating/types.ts";

export const FIELDS = [
  "insurer", "previous_insurer", "business_type", "make", "model", "fuel", "rto", "engine_cc",
  "manufacture_year", "registration_year", "vehicle_age", "policy_type",
  "current_ncb", "previous_ncb", "basic_od_premium", "net_od_premium",
  "basic_tp_premium", "net_tp_premium", "net_premium", "gross_premium",
  "tax", "start_date", "end_date", "vehicle_class", "rto_location",
  "eligible_private_car_gwp", "standalone_zd", "tyre_rti_bundle", "extended_warranty",
] as const;

export type Field = typeof FIELDS[number];
export type Box = [number, number, number, number];
export type Reader = "sarvam" | "nvidia-super-vl" | "gemini-flash" | "nvidia-mistral";
export type Candidate = { field: Field; value: string; quote: string; box: Box | null };
export type PageRead = {
  reader: Reader; model: string; page: number; transcript: string; candidates: Candidate[]; protocol?: string;
  quoteOnly?: true;
};
export type Evidence = {
  file: string; page: number; reader: Reader; model: string; raw: string; quote: string; box: Box | null;
  protocol?: string;
};
export type Confirmation = {
  field: string; raw: string; value: string; page: number; file: string; type: "reviewer_confirmation";
};
export type FieldDecision = {
  value: string | null;
  status: "accepted" | "needs_review" | "rejected" | "confirmed_by_reviewer";
  reason: string;
  evidence: Evidence[];
  confirmation?: Confirmation;
};
export const CLARIFIABLE = new Set(["conflicting_readings", "ambiguous_date"]);

const MONTHS = [
  "january", "february", "march", "april", "may", "june", "july", "august",
  "september", "october", "november", "december",
];
const numericField = (field: string) => field.endsWith("_premium") || field.endsWith("_ncb")
  || field === "tax" || field === "eligible_private_car_gwp";

function digits(text: string) {
  return text.normalize("NFKC").replace(/\p{Nd}/gu, digit => {
    if (/^\d$/.test(digit)) return digit;
    let zero = digit.codePointAt(0)!;
    while (/\p{Nd}/u.test(String.fromCodePoint(zero - 1))) zero--;
    // Some digit sets are adjacent in Unicode. Each contains ten digits.
    return String((digit.codePointAt(0)! - zero) % 10);
  });
}

function dateValue(raw: string) {
  let year: number, month: number, day: number;
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
  const numeric = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/.exec(raw);
  const named = /^(\d{1,2})[\s-]([a-z]{3,9})[\s-](\d{4})$/i.exec(raw);
  if (iso) {
    [year, month, day] = iso.slice(1).map(Number);
  } else if (numeric) {
    const [first, second, inputYear] = numeric.slice(1).map(Number);
    if (first <= 12 && second <= 12 && first !== second) return null;
    [year, month, day] = second > 12 ? [inputYear, first, second] : [inputYear, second, first];
  } else if (named) {
    day = Number(named[1]);
    year = Number(named[3]);
    month = MONTHS.findIndex(name => name === named[2].toLowerCase() || name.slice(0, 3) === named[2].toLowerCase()) + 1;
  } else return null;
  if (year < 1 || month < 1 || month > 12 || day < 1) return null;
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  return date.getUTCMonth() === month - 1 && date.getUTCDate() === day ? date.toISOString().slice(0, 10) : null;
}

export function canonical(field: string, text: string): string | null {
  let raw = digits(text).trim();
  if (!raw || /^(?:n\/a|na|null|unknown|-)$/i.test(raw)) return null;
  if (field.endsWith("_date")) return dateValue(raw);
  if (numericField(field)) {
    raw = raw.replace(/^(?:₹|INR)\s*/i, "").replace(/%$/, "").trim();
    if (!/^(?:[0-9]+|[0-9]{1,3}(?:,[0-9]{3})+|[0-9]{1,2}(?:,[0-9]{2})*,[0-9]{3})(?:\.[0-9]+)?$/.test(raw)) return null;
    const [integer, decimal] = raw.replaceAll(",", "").split(".");
    const whole = integer.replace(/^0+(?=\d)/, "");
    const fraction = decimal?.replace(/0+$/, "");
    if (field.endsWith("_ncb") && (whole.length > 3 || Number(whole) > 100 || (whole === "100" && fraction))) return null;
    return whole + (fraction ? "." + fraction : "");
  }
  if (field === "rto") {
    raw = raw.replace(/[\s-]/g, "").toUpperCase();
    return /^[A-Z]{2}\d{1,2}[A-Z]?$/.test(raw) ? raw : null;
  }
  if (field === "rto_location") raw = raw.replace(/\s*,\s*/g, ", ");
  if (["engine_cc", "manufacture_year", "registration_year", "vehicle_age"].includes(field)) {
    if (field === "engine_cc") {
      raw = raw.replace(/\s*cc$/i, "");
      if (/^\d{1,2},\d{3}$/.test(raw)) raw = raw.replace(",", "");
    }
    if (!/^\d{1,5}$/.test(raw)) return null;
    const number = Number(raw);
    if ((field.endsWith("_year") && (number < 1886 || number > 2100)) || (field === "engine_cc" && number === 0)) return null;
    return String(number);
  }
  return raw.toLowerCase().replace(/\s+/g, " ");
}

function comparable(text: string) {
  return digits(text).toLowerCase().match(/[\p{L}\p{N}\p{M}_]+|[^\s]/gu)?.join(" ") ?? "";
}

function contains(text: string, exact: string) {
  const normalized = comparable(exact);
  return normalized !== "" && text.split(/\r?\n/).some(line => ` ${comparable(line)} `.includes(` ${normalized} `));
}

function normalizedLines(transcript: string) {
  return transcript.split(/\r?\n/).map(line => ` ${comparable(line)} `);
}

const LABELS: Partial<Record<Field, RegExp>> = {
  business_type: /\b(business type|business category|transaction type)\b/,
  engine_cc: /\b(cc|cubic capacity|engine capacity|displacement)\b/,
  fuel: /\bfuel\b/,
  rto: /\b(rto|registration|registering authority)\b/,
  manufacture_year: /\b(manufacture|manufacturing|mfg)\b/,
  registration_year: /\b(registration|registered)\b/,
  eligible_private_car_gwp: /(?=.*\beligible\b)(?=.*\bprivate[- ]+car\b)(?=.*\bgwp\b)/,
  tax: /\b(tax|gst|igst|cgst|sgst)\b/,
};
const PREMIUM_BASIS = {
  basic: /\b(basic|base)\b/,
  net: /\bnet\b/,
  gross: /\b(gross|final|payable)\b/,
};

function legalInsurer(value: string) {
  return /\binsurance(?: (?:company|co))? (?:limited|ltd)\b/.test(comparable(value));
}

function documentHeading(candidate: Candidate) {
  const { field, value } = candidate;
  return field === "insurer" && legalInsurer(value)
    || field === "policy_type" && /\bpolicy\b/.test(comparable(value)) && Boolean(policyCoverage(value));
}

export function grounded(candidate: Candidate, transcript: string) {
  return groundedOnPage(candidate, normalizedLines(transcript));
}

function groundedOnPage(candidate: Candidate, lines: string[]) {
  const { field, quote, value } = candidate;
  const context = comparable(quote);
  const found = lines.filter(line => line.includes(` ${context} `));
  if (!context || !found.length) return false;
  if (comparable(value) === context) {
    return documentHeading(candidate) && found.some(line => !/\b(previous|prior|old|expiring)\b/.test(line));
  }
  const previous = /\b(previous|prior)\b/.test(context);
  if (field.startsWith("previous_") && !previous) return false;
  if (previous && (["insurer", "current_ncb", "policy_type", "start_date", "end_date", "business_type"].includes(field)
    || field.endsWith("_premium"))) return false;
  if (field.endsWith("_ncb") && !/\b(ncb|no claim bonus)\b/.test(context)) return false;
  const label = LABELS[field];
  if (label && !label.test(context)) return false;
  if (field.endsWith("_premium")) {
    const basis = field.split("_")[0] as keyof typeof PREMIUM_BASIS;
    if (!/\bpremium\b/.test(context) || !PREMIUM_BASIS[basis].test(context)) return false;
    const od = /\b(od|own damage)\b/.test(context);
    const tp = /\b(tp|third\s+(?:-\s+)?party|liability)\b/.test(context);
    if (od !== field.includes("_od_") || tp !== field.includes("_tp_")) return false;
  }
  if (numericField(field)) {
    const expected = canonical(field, value);
    const amounts = digits(quote).match(/(?<![\p{L}\p{N}_.,+\-−])\d+(?:[.,]\d+)*(?![\p{L}\p{N}_.,])/gu) ?? [];
    // One printed number per candidate prevents borrowing a value from the adjacent component.
    return expected !== null && amounts.length === 1 && canonical(field, amounts[0]) === expected;
  }
  if (field === "rto") {
    const normalized = canonical(field, value);
    if (normalized) {
      const prefix = normalized.split("").join("[\\s-]*");
      return new RegExp(`\\b${prefix}(?:[\\s-]*[A-Z]{1,3}[\\s-]*[0-9]{4}\\b|\\b(?![\\s-]*[A-Z]{1,3}[\\s-]*[0-9]{4}\\b))`, "i").test(quote);
    }
  }
  return contains(quote, value);
}

export function decide(filename: string, reads: PageRead[], complete = true): Record<Field, FieldDecision> {
  const decisions = new Map<Field, FieldDecision>();
  const prepared = reads.map(read => ({
    ...read, lines: normalizedLines(read.transcript),
  }));
  const headingAnchors = prepared.flatMap(read => read.candidates
    .filter(candidate => documentHeading(candidate) && groundedOnPage(candidate, read.lines))
    .map(candidate => ({ field: candidate.field, page: read.page, reader: read.reader, value: comparable(candidate.value) })));
  for (const field of FIELDS) {
    const evidence = new Map<string, Evidence>();
    const rejected = new Map<string, Evidence>();
    const observed = new Map<string, Map<number, Set<Reader>>>();
    const headingReaders = new Set<Reader>();
    let invalidDate = false;
    for (const {page, reader, model, lines, candidates, protocol, quoteOnly} of prepared) {
      for (const candidate of candidates) {
        if (candidate.field !== field) continue;
        const source = {
          file: filename, page, reader, model, raw: candidate.value, quote: candidate.quote, box: candidate.box,
          ...(protocol ? { protocol } : {}),
        };
        const key = JSON.stringify(source);
        const heading = documentHeading(candidate) ? comparable(candidate.value) : "";
        // An exact heading can share the same-page citation from an independently transcribed match.
        const anchoredHeading = heading && heading === comparable(candidate.quote) &&
          headingAnchors.some(anchor => anchor.field === field && anchor.page === page && anchor.reader !== reader && anchor.value === heading) &&
          !lines.some(line => line.includes(` ${heading} `) && /\b(previous|prior|old|expiring)\b/.test(line));
        const anchoredQuote = quoteOnly && prepared.some(other =>
          other.page === page && other.reader !== reader && !other.quoteOnly && groundedOnPage(candidate, other.lines));
        if (!groundedOnPage(candidate, lines) && !anchoredHeading && !anchoredQuote) {
          rejected.set(key, source);
          continue;
        }
        const value = canonical(field, candidate.value);
        if (value === null) {
          invalidDate ||= field.endsWith("_date");
          (field.endsWith("_date") ? evidence : rejected).set(key, source);
          continue;
        }
        evidence.set(key, source);
        if (heading) headingReaders.add(reader);
        let pages = observed.get(value);
        if (!pages) observed.set(value, pages = new Map());
        let independent = pages.get(page);
        if (!independent) pages.set(page, independent = new Set());
        independent.add(reader);
      }
    }
    const citations = [...(evidence.size ? evidence : rejected).values()]
      .sort((a, b) => a.page - b.page || a.reader.localeCompare(b.reader) || a.raw.localeCompare(b.raw));
    // Matching document headings can be cited on different pages.
    const corroboratedHeading = observed.size === 1 && headingReaders.size >= 2;
    const match = corroboratedHeading ? [...observed.keys()][0] : [...observed].find(([, pages]) => [...pages.values()].some(readers => readers.size >= 2))?.[0];
    let reason = "insufficient_agreement";
    let status: FieldDecision["status"] = "needs_review";
    let value = null;
    if (invalidDate) reason = "ambiguous_date";
    else if (observed.size > 1) reason = "conflicting_readings";
    else if (match !== undefined) {
      reason = complete || corroboratedHeading ? "independent_agreement" : "incomplete_independent_page_coverage";
      if (complete || corroboratedHeading) {
        status = "accepted";
        value = match;
      }
    } else if (observed.size === 0 && rejected.size > 0) {
      reason = "invalid_or_ungrounded";
      status = "rejected";
    }
    decisions.set(field, { value, status, reason, evidence: citations });
  }

  const fields = Object.fromEntries(decisions) as Record<Field, FieldDecision>;
  const review = (names: Field[], reason: string) => {
    for (const name of names) fields[name] = { ...fields[name], value: null, status: "needs_review", reason };
  };
  const start = fields.start_date.value;
  const end = fields.end_date.value;
  if (start && end && start >= end) review(["start_date", "end_date"], "invalid_coverage_period");
  const amounts = [fields.net_premium.value, fields.tax.value, fields.gross_premium.value];
  if (amounts.every((amount): amount is string => amount !== null)) {
    const parts = amounts.map(amount => amount.split("."));
    const precision = Math.max(...parts.map(([, tail]) => tail?.length ?? 0));
    const [net, tax, gross] = parts.map(([whole, tail]) => BigInt(whole + (tail ?? "").padEnd(precision, "0")));
    if (net + tax !== gross) review(["net_premium", "tax", "gross_premium"], "premium_totals_disagree");
  }
  return fields;
}
