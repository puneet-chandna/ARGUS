import { canonical, type Evidence, type Extraction, type FieldDecision } from "./ingestion/index.ts";
import { FIELDS, grounded } from "./ingestion/facts.ts";
import { EXTRACTION_VERSION } from "./ingestion/providers.ts";
import { policyCoverage } from "./rating/types.ts";

function groundedValue(field: string, source: Evidence) {
  const name = FIELDS.find(known => known === field);
  const { raw, quote, box } = source;
  if (!name || typeof raw !== "string" || typeof quote !== "string" ||
      !grounded({ field: name, value: raw, quote, box }, quote)) return null;
  return canonical(field, raw);
}

function observed(field: string, decision: FieldDecision) {
  if (decision.status === "rejected") return [];
  return decision.evidence.flatMap(source => {
    const value = groundedValue(field, source);
    return value !== null && (decision.value === null || value === decision.value) ? [value] : [];
  });
}

function uniqueSources(sources: Evidence[]) {
  return [...new Map(sources.map(source => [JSON.stringify(source), source])).values()];
}

function equivalent(field: string, left: string, right: string) {
  if (left === right) return true;
  return field === "policy_type" && policyCoverage(left) && policyCoverage(left) === policyCoverage(right) &&
    (left.includes(right) || right.includes(left));
}

export function mergeOcrRetry(previous: Extraction, fresh: Extraction): Extraction {
  const fields = { ...fresh.fields };
  for (const [field, before] of Object.entries(previous.fields)) {
    const after = fields[field];
    if (!after) { fields[field] = before; continue; }
    const older = observed(field, before);
    const newer = observed(field, after);
    let decision: FieldDecision;
    if (before.status === "confirmed_by_reviewer") decision = before;
    else if (before.reason === "conflicting_readings" || after.reason === "conflicting_readings" ||
        (older.length && newer.length && !older.some(left => newer.some(right => equivalent(field, left, right))))) {
      decision = { status: "needs_review", reason: "conflicting_readings", value: null, evidence: [] };
    } else if (["ambiguous_date", "invalid_coverage_period", "premium_totals_disagree"].includes(after.reason)) decision = after;
    else if (after.status === "accepted") decision = after;
    else if (before.status === "accepted" || (!after.evidence.length && before.evidence.length) ||
        (before.status !== "rejected" && before.evidence.length > 0 && after.status === "rejected")) decision = before;
    else decision = after;

    const previousSources = before.status === "rejected" ? [] : before.evidence.filter(source =>
      previous.extraction_version === EXTRACTION_VERSION || before.status === "confirmed_by_reviewer" ||
      (before.status === "accepted" && before === decision) || groundedValue(field, source) !== null);
    const freshSources = after.status === "rejected" ? [] : after.evidence;
    const evidence = decision.status === "rejected" ? decision.evidence : uniqueSources([...previousSources, ...freshSources]);
    const rejected = uniqueSources([...(before.rejected_evidence ?? []), ...(after.rejected_evidence ?? []),
      ...before.evidence.filter(source => !previousSources.includes(source)),
      ...(after.status === "rejected" ? after.evidence : [])]).filter(source => !evidence.includes(source));
    // Two partial attempts never create independent agreement.
    fields[field] = { ...decision, evidence, ...(rejected.length && { rejected_evidence: rejected }) };
  }
  return { ...fresh, fields, clarifications: previous.clarifications,
    extraction_version: previous.extraction_version, reread: previous.reread ?? fresh.reread };
}
