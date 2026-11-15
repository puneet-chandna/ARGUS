import { canonical, CLARIFIABLE, FIELDS } from "./ingestion/facts.ts";
import type { Field } from "./ingestion/facts.ts";
import { policyCoverage } from "./rating/types.ts";

const MANUAL_FIELDS: readonly Field[] = [
  "policy_type", "insurer", "vehicle_class", "previous_insurer", "business_type",
  "rto", "rto_location", "make", "model", "fuel", "engine_cc", "vehicle_age",
  "start_date", "current_ncb", "eligible_private_car_gwp", "standalone_zd",
  "tyre_rti_bundle", "extended_warranty",
];
const CHECKS = new Set([...CLARIFIABLE, "invalid_coverage_period", "premium_totals_disagree"]);

type ReviewFact = { status: string; reason: string; value: string | number | null; evidence: { page?: number }[] };

export function conflictFields(report: { fields: Record<string, ReviewFact> }) {
  return FIELDS.filter(field => {
    const fact = report.fields[field];
    return fact?.status === "needs_review" && fact.reason === "conflicting_readings";
  });
}

export function confirmationError(field: string, value: string) {
  const normalized = canonical(field, value);
  if (!normalized) return "Enter a valid value from the selected policy page.";
  if (field === "policy_type" && !policyCoverage(normalized)) {
    return "Enter the full policy title, such as Liability Only Policy or Package Policy.";
  }
}

export function reviewFields(report: { status: string; fields: Record<string, ReviewFact> }) {
  const disputed = FIELDS.filter(field => {
    const fact = report.fields[field];
    return fact?.status === "needs_review" && CHECKS.has(fact.reason) && fact.evidence.some(source => source.page);
  });
  if (report.status !== "ambiguous") return disputed;
  return [...new Set([...disputed, ...MANUAL_FIELDS.filter(field => {
    const fact = report.fields[field];
    if (field === "policy_type" && !policyCoverage(String(fact?.value ?? ""))) return true;
    return !fact || (fact.value == null && fact.status !== "confirmed_by_reviewer");
  })])];
}
