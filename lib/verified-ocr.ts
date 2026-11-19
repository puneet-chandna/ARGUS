import { createHash } from "node:crypto";
import { cacheKey, EXTRACTION_VERSION } from "./ingestion/providers.ts";
import type { Extraction } from "./ingestion/index.ts";
import type { Report } from "./report.ts";

export function verifiedOcrProfile() {
  return createHash("sha256").update(JSON.stringify([
    EXTRACTION_VERSION, cacheKey("sarvam", Buffer.alloc(0)), cacheKey("nvidia-super-vl", Buffer.alloc(0)),
    process.env.ARGUS_OCR_PAGES_PER_RUN || "20",
  ])).digest("hex");
}

export function verifiedOcr(report: Report) {
  if (report.status === "ambiguous" || report.extraction_version !== EXTRACTION_VERSION ||
      Object.keys(report.reader_failures).length || report.clarifications.length) return null;

  const fields = Object.values(report.fields);
  if (!fields.some(field => field.status === "accepted") ||
      fields.some(field => field.status !== "accepted" && field.evidence.length > 0)) return null;

  const { filename, checksum, extraction_version, reader_failures, clarifications } = report;
  const fieldsForReuse = Object.fromEntries(Object.entries(report.fields).map(([field, { rejected_evidence, ...decision }]) => [field, decision]));
  const extraction: Extraction = { filename, checksum, extraction_version, reader_failures, clarifications, fields: fieldsForReuse,
    ...(report.reread && { reread: report.reread }) };
  const texts = new Map<string, { page: number; text: string }>();
  for (const field of fields) {
    for (const { page, quote } of field.evidence) texts.set(JSON.stringify([page, quote]), { page, text: quote });
  }
  const grounded_text = Array.from(texts.values()).sort((a, b) => a.page - b.page);
  return { extraction, grounded_text };
}

export function rebindExtraction(extraction: Extraction, filename: string): Extraction {
  return {
    ...extraction, filename,
    clarifications: extraction.clarifications.filter(confirmation => confirmation.page).map(confirmation => ({ ...confirmation, file: filename })),
    fields: Object.fromEntries(Object.entries(extraction.fields).filter(([, decision]) => !decision.confirmation || decision.confirmation.page).map(([field, decision]) => [
      field, {
        ...decision, evidence: decision.evidence.map(source => ({ ...source, file: filename })),
        ...(decision.rejected_evidence && { rejected_evidence: decision.rejected_evidence.map(source => ({ ...source, file: filename })) }),
        ...(decision.confirmation && { confirmation: { ...decision.confirmation, file: filename } }),
      },
    ])),
  };
}

export function reuseConfirmations(extraction: Extraction, reviewed: Extraction): Extraction {
  const prior = rebindExtraction(reviewed, extraction.filename);
  const fields = { ...extraction.fields };
  for (const [field, decision] of Object.entries(prior.fields)) {
    if (decision.status === "confirmed_by_reviewer" && decision.confirmation) fields[field] = decision;
  }
  return { ...extraction, fields, clarifications: prior.clarifications };
}
