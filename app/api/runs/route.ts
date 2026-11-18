import { endpoint, HttpError, json } from "../../../lib/http.ts";
import { inspectPdf, PdfError } from "../../../lib/ingestion/index.ts";
import { liveOcrStatus } from "../../../lib/ingestion/providers.ts";
import { present, runStore, type StoredRun } from "../../../lib/runs.ts";
import { reviewer, serviceClient } from "../../../lib/supabase.ts";
import { fakeSlow, lookupCache, startAnalysis } from "../../../lib/run-analysis.ts";
import { parseUpload, requireConsent, uuid } from "../../../lib/upload.ts";

export const GET = endpoint(async request => {
  const { user } = await reviewer();
  const after = new URL(request.url).searchParams.get("after");
  const [pinned, createdAt, id, extra] = after?.split("|") ?? [];
  if (after !== null && (after.length > 100 || extra !== undefined || !["0", "1"].includes(pinned) ||
      !Number.isFinite(Date.parse(createdAt)) || !uuid(id))) throw new HttpError(400, "Invalid saved runs cursor.");
  const history = await runStore(serviceClient(), user.id).list(after === null ? undefined : { pinned: pinned === "1", createdAt, id });
  const ocr = { cache: Boolean(process.env.ARGUS_OCR_CACHE_DIR), live: fakeSlow() ? "ready" : liveOcrStatus() };
  return json({ ...history, ocr });
});

function uploaded(run: StoredRun) {
  const cache = run.cache_result ?? "miss";
  return json({ runId: run.id, mode: run.analysis_mode ?? "live", cache,
    pagesToOcr: cache === "hit" ? 0 : (run.pages_total ?? 0) - (run.progress?.cachedPages?.length ?? 0),
    run: present(run) }, 201);
}

export const POST = endpoint(async (request) => {
  const startedAt = new Date().toISOString();
  const { user } = await reviewer();
  const key = request.headers.get("Idempotency-Key") ?? crypto.randomUUID();
  if (!uuid(key)) throw new HttpError(400, "Invalid upload key.");
  const input = await parseUpload(request);
  const store = runStore(serviceClient(), user.id);
  const prior = await store.findUpload(input, key);
  if (prior && prior.status !== "uploading") {
    return uploaded(prior.status === "queued" ? await startAnalysis(store, prior, undefined, startedAt) : await store.refreshDecision(prior));
  }
  let pages: number;
  try {
    pages = prior?.pages_total ?? await inspectPdf(input.bytes);
  } catch (error) {
    if (!(error instanceof PdfError) || error.code === "pdf_renderer_unavailable") throw error;
    throw new HttpError(422, error.code === "invalid_page_count"
      ? "The PDF has no pages or exceeds the page limit."
      : "The PDF is encrypted, damaged, or could not be opened.");
  }
  if (prior) {
    const queued = await store.upload(input, key, pages, prior.cache_result ?? "miss");
    return uploaded(await startAnalysis(store, queued, undefined, startedAt));
  }
  const cached = await lookupCache(store, input.digest);
  requireConsent(cached.check.cache, input.allowCloud);
  const queued = await store.upload(input, key, cached.check.pagesTotal ?? pages, cached.check.cache);
  return uploaded(await startAnalysis(store, queued, cached, startedAt));
});
