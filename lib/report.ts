import { canonical, type Extraction, type Confirmation, type Evidence, type FieldDecision } from "./ingestion/index.ts";
import { FIELDS, grounded } from "./ingestion/facts.ts";
import { EXTRACTION_VERSION } from "./ingestion/providers.ts";
import { rate, type RatingResult } from "./rating/index.ts";
import { component, vehicleBodyStyle } from "./rating/types.ts";
import { HttpError } from "./http.ts";
import { confirmationError, conflictFields, requiredReviewFields, reviewFields } from "./review-fields.ts";

export type Report = Extraction & RatingResult & { rating_trace_start?: number };

export function needsBrokerageGwp(fact?: FieldDecision) {
  return fact?.value != null && (fact.status !== "confirmed_by_reviewer" ||
    !fact.confirmation?.file.trim() || fact.confirmation.page !== undefined);
}

export function applyRating(extraction: Extraction): Report {
  const fields = { ...extraction.fields };
  const classification = fields.vehicle_class;
  if (classification?.value != null && vehicleBodyStyle(classification.value)) {
    fields.vehicle_class = { ...classification, value: null, status: "rejected", reason: "vehicle_body_style_only" };
  }
  const gwp = fields.eligible_private_car_gwp;
  if (gwp && needsBrokerageGwp(gwp)) {
    fields.eligible_private_car_gwp = { value: null, status: "needs_review", reason: "insufficient_agreement", evidence: gwp.evidence };
  }
  for (const field of ["current_ncb", "start_date", "end_date"] as const) {
    const fact = fields[field];
    if (extraction.extraction_version === EXTRACTION_VERSION || fact?.status !== "accepted" || fact.value === null) continue;
    const ocr = fact.evidence.filter(source => source.reader);
    const readers = new Set(ocr.filter(source => source.quote && grounded({
      field, value: fact.value!, quote: source.quote, box: null,
    }, source.quote)).map(source => source.reader));
    if (ocr.length && readers.size < 2) {
      fields[field] = { ...fact, value: null, status: "needs_review", reason: "insufficient_agreement" };
    }
  }
  const facts: Record<string, string> = {};
  for (const [name, field] of Object.entries(fields)) {
    if ((field.status === "accepted" || field.status === "confirmed_by_reviewer") && field.value !== null) {
      facts[name] = field.value;
    }
  }
  for (const name of ["standalone_zd", "tyre_rti_bundle", "extended_warranty"]) {
    if (["included", "yes", "applicable"].includes(facts[name])) facts[name] = "yes";
    if (["excluded", "not included", "no", "not applicable"].includes(facts[name])) facts[name] = "no";
  }

  const rated = rate(facts);
  const pendingDates = ["start_date", "end_date"].filter(name =>
    fields[name]?.reason === "invalid_coverage_period" && fields[name].status !== "confirmed_by_reviewer");
  if (pendingDates.length) {
    const reason = "The extracted coverage period was invalid. Confirm both policy dates before selecting a rate.";
    for (const name of ["od", "tp"] as const) {
      if (rated[name].status === "inapplicable") continue;
      rated[name] = component("ambiguous", reason, null, rated[name].applicable);
      rated.blockers.push({ component: name, kind: "policy_fact", fields: pendingDates, reason, sources: [] });
    }
    rated.status = "ambiguous";
    rated.confidence = { level: "low", reason };
    rated.review_fields = [...new Set([...(rated.review_fields ?? []), ...pendingDates])];
    rated.trace.push({ step: reason, sources: [], policy_fields: pendingDates });
    delete rated.gwp_preview;
  }
  const policySources = (name: string): (Evidence | Confirmation)[] => {
    const field = fields[name];
    return field?.confirmation ? [field.confirmation] : field?.evidence ?? [];
  };
  const trace = Object.entries(facts).map(([name, value]) => {
    const field = fields[name];
    const confirmation = field.confirmation;
    return {
      step: `${name.replaceAll("_", " ")}: ${value}${confirmation ? " (confirmed by reviewer)" : ""}`,
      sources: policySources(name),
    };
  });
  if (rated.business_type) {
    const sources = ["insurer", "previous_insurer", "business_type"].flatMap<Evidence | Confirmation>(policySources);
    trace.push({ step: `Business type: ${rated.business_type}`, sources });
  }
  const confidence = Object.keys(facts).some(name => fields[name].status === "confirmed_by_reviewer")
    ? { ...rated.confidence, reason: `${rated.confidence.reason} Reviewer-confirmed evidence was used.` }
    : rated.confidence;
  const decisions = rated.trace.map(step => ({
    ...step, sources: [...step.sources, ...(step.policy_fields ?? []).flatMap<Evidence | Confirmation>(policySources)],
  }));
  const blockers = rated.blockers.map(blocker => ({
    ...blocker, sources: [...blocker.sources, ...blocker.fields.flatMap<Evidence | Confirmation>(policySources)],
  }));
  const preview = rated.gwp_preview;
  const gwp_preview = preview && {
    ...preview, sources: [...preview.sources, ...preview.policy_fields.flatMap(policySources)],
  };
  return { ...extraction, ...rated, blockers, fields, review_fields: rated.review_fields, gwp_preview, confidence,
    rating_trace_start: trace.length, trace: [...trace, ...decisions] };
}

export function clarifyBatch(report: Report, inputs: unknown, pages: number, preview = false): Report {
  const allowed = new Set<string>(reviewFields(report));
  if (!Array.isArray(inputs) || !inputs.length || inputs.length > FIELDS.length) {
    throw new HttpError(422, "Select policy facts to confirm.");
  }
  const fields = { ...report.fields };
  const clarifications = [...report.clarifications];
  const selected = new Set<string>();
  for (const input of inputs) {
    const { field, value, page, source } = input ?? {};
    if (typeof field !== "string" ||
        typeof value !== "string" || !value.trim() || [...value].length > 220) {
      throw new HttpError(400, "Enter the value you verified.");
    }
    const external = field === "eligible_private_car_gwp";
    if (external ? page !== undefined ||
      typeof source !== "string" || !source.trim() || source.length > 220 || /\p{Cc}/u.test(source) :
      source !== undefined || typeof page !== "number" || !Number.isInteger(page) || page < 1 || page > pages) {
      throw new HttpError(400, "Cite the policy page or, for eligible GWP, identify the brokerage record.");
    }
    if (selected.has(field)) throw new HttpError(422, "Confirm each field only once.");
    if (!allowed.has(field)) {
      const discovered = selected.size && requiredReviewFields(applyRating({ ...report, fields, clarifications })).includes(field);
      if (!discovered) throw new HttpError(422, "This field is not awaiting review.");
    }
    const error = confirmationError(field, value);
    if (error) throw new HttpError(422, error);

    selected.add(field);
    const normalized = canonical(field, value)!;
    const confirmation = {
      field, raw: value, value: normalized,
      ...(external ? { file: source.trim() } : { file: report.filename, page }),
      type: "reviewer_confirmation" as const,
    };
    const decision = fields[field] ?? { reason: "insufficient_agreement", evidence: [] };
    fields[field] = { ...decision, value: normalized, status: "confirmed_by_reviewer", confirmation };
    clarifications.push(confirmation);
  }
  const required = new Set(requiredReviewFields(report));
  if (!preview && conflictFields(report).some(field => required.has(field) && !selected.has(field))) {
    throw new HttpError(422, "Confirm every OCR conflict before recalculating.");
  }
  return applyRating({ ...report, fields, clarifications });
}
