import { endpoint, HttpError, json } from "../../../lib/http.ts";
import { inspectPdf, PdfError } from "../../../lib/ingestion/index.ts";
import { liveOcrStatus } from "../../../lib/ingestion/providers.ts";
import { present, runStore } from "../../../lib/runs.ts";
import { reviewer, serviceClient } from "../../../lib/supabase.ts";
import { fakeSlow, lookupCache, startAnalysis } from "../../../lib/run-analysis.ts";
import { parseUpload, requireConsent, uuid } from "../../../lib/upload.ts";

export const GET = endpoint(async () => {
  const { user } = await reviewer();
  const client = serviceClient();
  const runs = await runStore(client, user.id).list();
  const ocr = { cache: Boolean(process.env.ARGUS_OCR_CACHE_DIR), live: fakeSlow() ? "ready" : liveOcrStatus() };
  return json({ runs, ocr });
});

export const POST = endpoint(async (request) => {
  const startedAt = new Date().toISOString();
  const { user } = await reviewer();
  const key = request.headers.get("Idempotency-Key") ?? crypto.randomUUID();
  if (!uuid(key)) throw new HttpError(400, "Invalid upload key.");
  const input = await parseUpload(request);
  let pages: number;
  try {
    pages = await inspectPdf(input.bytes);
  } catch (error) {
    if (!(error instanceof PdfError) || error.code === "pdf_renderer_unavailable") throw error;
    throw new HttpError(422, error.code === "invalid_page_count"
      ? "The PDF has no pages or exceeds the page limit."
      : "The PDF is encrypted, damaged, or could not be opened.");
  }
  const store = runStore(serviceClient(), user.id);
  const cached = await lookupCache(store, input.digest);
  requireConsent(cached.check.cache, input.allowCloud);
  const queued = await store.upload(input, key, cached.check.pagesTotal ?? pages, cached.check.cache);
  const run = await startAnalysis(store, queued, cached, startedAt);
  const cache = run.cache_result ?? cached.check.cache;
  return json({ runId: run.id, mode: run.analysis_mode ?? "live", cache,
    pagesToOcr: cache === "hit" ? 0 : (cached.check.pagesTotal ?? pages) - cached.check.pagesCached,
    run: present(run) }, 201);
});
