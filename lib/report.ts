import { canonical, type Extraction, type Confirmation, type Evidence } from "./ingestion/index.ts";
import { rate, type RatingResult } from "./rating/index.ts";
import { HttpError } from "./http.ts";
import { confirmationError, conflictFields, reviewFields } from "./review-fields.ts";

export type Report = Extraction & RatingResult;

export function applyRating(extraction: Extraction): Report {
  const facts: Record<string, string> = {};
  for (const [name, field] of Object.entries(extraction.fields)) {
    if ((field.status === "accepted" || field.status === "confirmed_by_reviewer") && field.value !== null) {
      facts[name] = field.value;
    }
  }
  for (const name of ["standalone_zd", "tyre_rti_bundle", "extended_warranty"]) {
    if (["included", "yes", "applicable"].includes(facts[name])) facts[name] = "yes";
    if (["excluded", "not included", "no", "not applicable"].includes(facts[name])) facts[name] = "no";
  }

  const rated = rate(facts);
  const trace: { step: string; sources: (Evidence | Confirmation)[] }[] = Object.entries(facts).map(([name, value]) => {
    const field = extraction.fields[name];
    const confirmation = field.confirmation;
    return {
      step: `${name.replaceAll("_", " ")}: ${value}${confirmation ? " (confirmed by reviewer)" : ""}`,
      sources: confirmation ? [confirmation] : field.evidence,
    };
  });
  if (rated.business_type) {
    const sources = ["insurer", "previous_insurer", "business_type"].flatMap<Evidence | Confirmation>((name) => {
      const field = extraction.fields[name];
      return field?.confirmation ? [field.confirmation] : field?.evidence ?? [];
    });
    trace.push({ step: `Business type: ${rated.business_type}`, sources });
  }
  const confidence = extraction.clarifications.length
    ? { ...rated.confidence, reason: `${rated.confidence.reason} Reviewer-confirmed evidence was used.` }
    : rated.confidence;
  return { ...extraction, ...rated, review_fields: rated.review_fields, confidence, trace: [...trace, ...rated.trace] };
}

export function clarifyBatch(report: Report, inputs: unknown, pages: number): Report {
  const allowed = reviewFields(report);
  if (!Array.isArray(inputs) || !inputs.length || inputs.length > allowed.length) {
    throw new HttpError(422, "Select policy facts to confirm.");
  }
  const fields = { ...report.fields };
  const clarifications = [...report.clarifications];
  const selected = new Set<string>();
  for (const input of inputs) {
    const { field, value, page } = input ?? {};
    if (typeof field !== "string" ||
        typeof value !== "string" || !value.trim() || [...value].length > 220 ||
        typeof page !== "number" || !Number.isInteger(page) || page < 1 || page > pages) {
      throw new HttpError(400, "Confirm a document value and cite its page.");
    }
    if (selected.has(field)) throw new HttpError(422, "Confirm each field only once.");
    if (!allowed.some(name => name === field)) throw new HttpError(422, "This field is not awaiting review.");
    const error = confirmationError(field, value);
    if (error) throw new HttpError(422, error);

    selected.add(field);
    const normalized = canonical(field, value)!;
    const confirmation = {
      field, raw: value, value: normalized, page, file: report.filename, type: "reviewer_confirmation" as const,
    };
    const decision = fields[field] ?? { reason: "insufficient_agreement", evidence: [] };
    fields[field] = { ...decision, value: normalized, status: "confirmed_by_reviewer", confirmation };
    clarifications.push(confirmation);
  }
  if (conflictFields(report).some(field => !selected.has(field))) {
    throw new HttpError(422, "Confirm every OCR conflict before recalculating.");
  }
  return applyRating({ ...report, fields, clarifications });
}
