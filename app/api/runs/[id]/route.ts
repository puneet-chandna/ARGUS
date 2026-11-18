import { after } from "next/server";
import { endpoint, HttpError, json, readJson } from "../../../../lib/http.ts";
import { storedPdfPages } from "../../../../lib/ingestion/index.ts";
import { applyRating, clarifyBatch } from "../../../../lib/report.ts";
import { requiredReviewFields } from "../../../../lib/review-fields.ts";
import { present, runStore } from "../../../../lib/runs.ts";
import { reviewer, serviceClient } from "../../../../lib/supabase.ts";
import { startAnalysis } from "../../../../lib/run-analysis.ts";

type Context = { params: Promise<{ id: string }> };

async function context({ params }: Context) {
  const { user } = await reviewer();
  return { store: runStore(serviceClient(), user.id), id: (await params).id };
}

export const GET = endpoint(async (request, route: Context) => {
  const { store, id } = await context(route);
  const run = await store.get(id);
  if (new URL(request.url).searchParams.get("progress") === "1") {
    const expired = run.status === "processing" && Date.parse(run.lease_until ?? "") <= Date.now();
    return json({
      stage: run.status === "complete" ? "complete" : run.status === "failed" || expired ? "failed" :
        run.status === "cancelled" ? "cancelled" : "uploading",
      pagesDone: 0, pagesTotal: run.pages_total, startedAt: run.created_at, stageStartedAt: run.created_at,
      ...run.progress, ...(expired && { stage: "failed" }), status: expired ? "failed" : run.status,
    });
  }
  const refreshed = await store.refreshDecision(run);
  const result = refreshed.result;
  if (result?.status === "ambiguous" && !result.review_fields) {
    return json({ run: present({ ...refreshed, result: { ...result, review_fields: applyRating(result).review_fields } }) });
  }
  return json({ run: present(refreshed) });
});

export const POST = endpoint(async (_request, route: Context) => {
  const { store, id } = await context(route);
  const previous = await store.get(id);
  const run = await startAnalysis(store, previous);
  return json({ run: present(run) }, run.status === "processing" && run.revision > previous.revision ? 202 : 200);
});

export const PATCH = endpoint(async (request, route: Context) => {
  const { store, id } = await context(route);
  const input = await readJson(request, 32 * 1024);
  const run = await store.get(id);
  if (Object.hasOwn(input, "displayName") || Object.hasOwn(input, "pinned")) {
    const { displayName, pinned } = input;
    if (run.revision !== input.revision) throw new HttpError(409, "The run changed. Reopen its settings and try again.");
    if (typeof displayName !== "string" || typeof pinned !== "boolean" ||
        /[\p{Cc}]/u.test(displayName) || [...displayName.trim()].length > 160) {
      throw new HttpError(422, "Enter a run name up to 160 characters.");
    }
    return json({ run: present(await store.manage(run, displayName.trim() || null, pinned)) });
  }
  if (run.status !== "complete" || !run.result || run.revision !== input.revision) {
    throw new HttpError(409, "The result changed. Reload it before confirming a value.");
  }
  const { pdf } = await store.pdf(id);
  const pages = await storedPdfPages(new Uint8Array(await pdf.arrayBuffer()));
  const reviewed = clarifyBatch(run.result, input.confirmations, pages);
  const remaining = requiredReviewFields(reviewed);
  if (input.preview === true) return json({ remaining });
  if (input.guided === true && remaining.length) {
    throw new HttpError(422, "Confirm the remaining policy details before recalculating.");
  }
  const revised = await store.revise(run, reviewed);
  if (revised.pdf_cleanup_pending) after(() => store.cleanupOriginal(id).catch(() => {
    console.warn("Argus could not remove an original PDF queued for deletion.");
  }));
  return json({ run: present(revised) });
});


export const DELETE = endpoint(async (request, route: Context) => {
  const { store, id } = await context(route);
  const input = await readJson(request);
  if (input.confirm !== true) throw new HttpError(400, "Confirm deletion of the run and original PDF.");
  await store.remove(id);
  return json({ deleted: true });
});
