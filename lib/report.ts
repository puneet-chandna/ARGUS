import { canonical, decide, type Extraction, type Confirmation, type Evidence, type FieldDecision } from "./ingestion/index.ts";
import { FIELDS, grounded, hasLegacyCurrentRole } from "./ingestion/facts.ts";
import { EXTRACTION_VERSION } from "./ingestion/providers.ts";
import { rate, type RatingResult } from "./rating/index.ts";
import { policyCoverage, vehicleBodyStyle } from "./rating/types.ts";
import { HttpError } from "./http.ts";
import { confirmationError, conflictFields, previousPolicySource, requiredReviewFields, reviewFields } from "./review-fields.ts";

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
  const manualEvidence = new Set(["manual_source_verification", "source_verified"]);
  for (const field of FIELDS.filter(name => !name.startsWith("previous_") && name !== "policy_type")) {
    const fact = fields[field];
    if (extraction.extraction_version === EXTRACTION_VERSION || !fact || fact.status === "confirmed_by_reviewer" ||
      manualEvidence.has(fact.reason)) continue;
    const ocr = fact.evidence.filter(source => source.reader);
    if (field.endsWith("_date") && fact.value === null && ocr.some(source => source.quote &&
      canonical(field, source.raw) === null && grounded({ field, value: source.raw, quote: source.quote, box: null }, source.quote))) {
      fields[field] = { ...fact, status: "needs_review", reason: "ambiguous_date" };
      continue;
    }
    if (fact.status !== "accepted" || fact.value === null) continue;
    const readers = new Set(ocr.filter(source => source.quote &&
      (field !== "insurer" || hasLegacyCurrentRole(field, fact.value!, source.quote)) &&
      grounded({ field, value: fact.value!, quote: source.quote, box: null }, source.quote)).map(source => source.reader));
    if (ocr.length && readers.size < 2) {
      fields[field] = { ...fact, value: null, status: "needs_review", reason: "insufficient_agreement" };
    }
  }
  const policy = fields.policy_type;
  if (extraction.extraction_version !== EXTRACTION_VERSION && policy?.status === "accepted" && policy.value !== null &&
    !manualEvidence.has(policy.reason) && policy.evidence.some(source => source.reader)) {
    const checked = decide(extraction.filename, policy.evidence.filter(source =>
      source.reader && source.quote && hasLegacyCurrentRole("policy_type", source.raw, source.quote)).map(source => ({
      reader: source.reader, model: source.model, page: source.page, transcript: source.quote,
      candidates: [{ field: "policy_type", value: source.raw, quote: source.quote, box: source.box }],
    }))).policy_type;
    fields.policy_type = checked.value !== null && policyCoverage(checked.value) === policyCoverage(policy.value)
      ? { ...policy, value: checked.value }
      : { ...policy, value: null, status: "needs_review", reason: checked.reason };
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

  const pendingDates = ["start_date", "end_date"].filter(name =>
    ["invalid_coverage_period", "ambiguous_date"].includes(fields[name]?.reason) && fields[name]?.status !== "confirmed_by_reviewer");
  const rated = rate(facts, pendingDates);
  const policySources = (name: string): (Evidence | Confirmation)[] => {
    const field = fields[name];
    if (!field?.confirmation) return field?.evidence ?? [];
    const prior = field.confirmation.basis === "previous_policy" ? [...field.evidence, ...(field.rejected_evidence ?? [])].filter(source => previousPolicySource(source) &&
      source.page === field.confirmation!.page && canonical(name, source.raw) === field.value) : [];
    return [...prior, field.confirmation];
  };
  const trace = Object.entries(facts).map(([name, value]) => {
    const field = fields[name];
    const confirmation = field.confirmation;
    return {
      step: `${name.replaceAll("_", " ")}: ${value}${confirmation?.basis === "previous_policy"
        ? " (reviewer confirmed previous-policy value for current policy)" : confirmation ? " (confirmed by reviewer)" : ""}`,
      sources: policySources(name),
    };
  });
  if (rated.business_type) {
    const sources = ["insurer", "previous_insurer", "business_type"].flatMap<Evidence | Confirmation>(policySources);
    trace.push({ step: `Business type: ${rated.business_type}`, sources });
  }
  const reused = Object.keys(facts).filter(name => fields[name].confirmation?.basis === "previous_policy");
  const confidence = reused.length
    ? { level: "low" as const, reason: `${rated.confidence.reason} Current-policy ${reused.map(name => name.replaceAll("_", " ")).join(", ")} relies on reviewer-confirmed reuse of previous-policy evidence.` }
    : Object.keys(facts).some(name => fields[name].status === "confirmed_by_reviewer")
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

export function clarifyBatch(report: Report, inputs: unknown, pages: number, preview = false, partial = false): Report {
  const allowed = new Set<string>(reviewFields(report));
  if (!Array.isArray(inputs) || !inputs.length || inputs.length > FIELDS.length) {
    throw new HttpError(422, "Select policy facts to confirm.");
  }
  const fields = { ...report.fields };
  const clarifications = [...report.clarifications];
  const selected = new Set<string>();
  for (const input of inputs) {
    const { field, value, page, source, basis } = input ?? {};
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
    if (basis !== undefined && basis !== "previous_policy") throw new HttpError(400, "Invalid confirmation basis.");
    if (basis && (external || field.startsWith("previous_") || ![...(fields[field]?.evidence ?? []), ...(fields[field]?.rejected_evidence ?? [])].some(evidence =>
      previousPolicySource(evidence) && evidence.page === page && canonical(field, evidence.raw) === canonical(field, value)))) {
      throw new HttpError(422, "Cite matching previous-policy evidence before confirming it applies to the current policy.");
    }

    selected.add(field);
    const normalized = canonical(field, value)!;
    const confirmation = {
      field, raw: value, value: normalized,
      ...(external ? { file: source.trim() } : { file: report.filename, page }),
      type: "reviewer_confirmation" as const,
      ...(basis && { basis: "previous_policy" as const }),
    };
    const decision = fields[field] ?? { reason: "insufficient_agreement", evidence: [] };
    fields[field] = { ...decision, value: normalized, status: "confirmed_by_reviewer", confirmation };
    clarifications.push(confirmation);
  }
  const required = new Set(requiredReviewFields(report));
  if (!preview && !partial && conflictFields(report).some(field => required.has(field) && !selected.has(field))) {
    throw new HttpError(422, "Confirm every OCR conflict before recalculating.");
  }
  return applyRating({ ...report, fields, clarifications });
}
