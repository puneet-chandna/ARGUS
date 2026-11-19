import { canonical, decide, FIELDS, grounded, type Field, type PageRead, type Reader } from "./ingestion/facts.ts";
import type { Extraction, RereadContext } from "./ingestion/index.ts";
import { liveKey, readLive, READER_LANES, TARGETED_PROTOCOL } from "./ingestion/providers.ts";
import { applyRating } from "./report.ts";

const labels: Partial<Record<Field, RegExp>> = {
  insurer: /\b(?:insurer|insurance)\b/i,
  previous_insurer: /\b(?:previous|prior|expiring)\s+(?:insurer|insurance|policy)\b/i,
  policy_type: /\b(?:policy|liability|package|comprehensive)\b/i,
  vehicle_class: /\b(?:vehicle\s+(?:class|type)|private\s+car)\b/i,
  business_type: /\b(?:business|transaction)\s+(?:type|category)\b/i,
  engine_cc: /\b(?:engine|cubic|capacity|cc)\b/i,
  rto: /\b(?:rto|regn|registration)\b/i,
  rto_location: /\b(?:rto|registering\s+authority|registration\s+office)\b/i,
  current_ncb: /\b(?:ncb|no\s+claim\s+bonus)\b/i,
  start_date: /\b(?:start|commencement|period\s+of\s+(?:insurance|cover)|valid\s+from)\b/i,
  fuel: /\bfuel\b/i, make: /\bmake\b/i, model: /\bmodel\b/i,
  manufacture_year: /\b(?:manufacture|manufacturing|mfg)\b/i,
  registration_year: /\b(?:registration|registered)\b/i,
  vehicle_age: /\b(?:vehicle\s+age|age\s+of\s+(?:the\s+)?vehicle)\b/i,
};

type Options = {
  allowCloud: boolean;
  reserve: () => Promise<boolean>;
  reserveGemini?: () => Promise<boolean>;
  onSend?: (page: number) => void;
  available?: (reader: Reader) => boolean;
  read?: (reader: Reader, page: number, image: Buffer, signal: AbortSignal, requested: readonly Field[]) => Promise<PageRead>;
};

export async function targetedReread(extraction: Extraction, context: RereadContext, options: Options): Promise<Extraction> {
  const cancellation = context.cancelledSignal ?? context.signal;
  cancellation.throwIfAborted();
  if (context.signal.aborted) return extraction;
  if (!options.allowCloud || extraction.reread) return extraction;
  const report = applyRating(extraction);
  const fields = [...new Set(report.blockers.filter(blocker => blocker.kind === "policy_fact").flatMap(blocker => blocker.fields))]
    .filter((field): field is Field => FIELDS.some(name => name === field))
    .filter(field => !["accepted", "confirmed_by_reviewer"].includes(extraction.fields[field]?.status));
  if (!fields.length) return extraction;

  const pages = Array.from({ length: context.pageCount }, (_, index) => {
    const page = index + 1;
    const reads = context.reads.filter(read => read.page === page);
    const requested = fields.filter(field => extraction.fields[field]?.evidence.some(source => source.page === page) ||
      reads.some(read => read.candidates.some(candidate => candidate.field === field) || labels[field]?.test(read.transcript)));
    const groundedFields = requested.filter(field => reads.some(read => read.candidates.some(candidate =>
      candidate.field === field && grounded(candidate, read.transcript)))).length;
    const candidateFields = requested.filter(field => reads.some(read => read.candidates.some(candidate => candidate.field === field))).length;
    return { page, reads, requested, groundedFields, candidateFields };
  }).filter(page => page.requested.length).sort((a, b) => b.groundedFields - a.groundedFields ||
    b.candidateFields - a.candidateFields || b.requested.length - a.requested.length || a.page - b.page);
  const target = pages[0];
  if (!target) return extraction;
  const available = options.available ?? (reader => Boolean(liveKey(reader)));
  const observed = decide(extraction.filename, target.reads, !Object.keys(extraction.reader_failures).length);
  // Quote-only observations can be grounded by an independent same-page transcript.
  const support = (reader: Reader) => target.requested.filter(field => observed[field].status !== "rejected" &&
    observed[field].evidence.some(source => source.reader === reader && canonical(field, source.raw) !== null)).length;
  const reader = READER_LANES.flat().filter(reader => available(reader) && !context.haltedReaders.has(reader))
    .sort((a, b) => support(a) - support(b) || Number(a === "gemini-flash") - Number(b === "gemini-flash"))[0];
  if (!reader) return extraction;
  const attempt: NonNullable<Extraction["reread"]> = {
    page: target.page, fields: target.requested, reader, protocol: TARGETED_PROTOCOL, outcome: "failed",
  };
  let reserved = false;
  try {
    const image = await context.render(target.page);
    context.signal.throwIfAborted();
    if (reader === "gemini-flash" && !await options.reserveGemini?.()) return extraction;
    context.signal.throwIfAborted();
    if (!await options.reserve()) return extraction;
    reserved = true;
    context.signal.throwIfAborted();
    options.onSend?.(target.page);
    const response = await (options.read ?? readLive)(reader, target.page, image, context.signal, target.requested);
    context.signal.throwIfAborted();
    if (response.reader !== reader || response.page !== target.page) return { ...extraction, reread: attempt };
    const reading = { ...response, protocol: TARGETED_PROTOCOL,
      candidates: response.candidates.filter(candidate => target.requested.includes(candidate.field)) };
    const decisions = decide(extraction.filename, [...context.reads, reading], !Object.keys(extraction.reader_failures).length);
    const updated = { ...extraction.fields };
    for (const field of target.requested) {
      const before = extraction.fields[field];
      const after = decisions[field];
      const evidence = [...new Map([...(before?.evidence ?? []), ...after.evidence].map(source => [JSON.stringify(source), source])).values()];
      updated[field] = before?.reason === "conflicting_readings"
        ? { ...before, evidence } : { ...after, evidence };
    }
    const accepted = target.requested.some(field => updated[field].status === "accepted");
    return { ...extraction, fields: updated, reread: { ...attempt, outcome: accepted ? "accepted" : "unresolved" } };
  } catch {
    cancellation.throwIfAborted();
    return reserved ? { ...extraction, reread: attempt } : extraction;
  }
}
