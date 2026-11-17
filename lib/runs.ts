import type { SupabaseClient } from "@supabase/supabase-js";
import { HttpError } from "./http.ts";
import { conflictFields, requiredReviewFields } from "./review-fields.ts";
import type { CacheCheck, RunProgress } from "./progress.ts";
import { applyRating, type Report } from "./report.ts";
import type { Extraction } from "./ingestion/index.ts";
import { verifiedOcr, verifiedOcrProfile } from "./verified-ocr.ts";
import { pdfObject, uuid } from "./upload.ts";

export type StoredRun = {
  id: string;
  owner_id: string;
  upload_key: string;
  filename: string;
  display_name: string | null;
  pinned: boolean;
  deleting_at: string | null;
  status: "uploading" | "queued" | "processing" | "failed" | "complete" | "cancelled";
  checksum: string;
  size_bytes: number;
  allow_cloud: boolean;
  ocr_mode?: "external" | "local" | null;
  pdf_deleted_at?: string | null;
  pdf_cleanup_pending?: boolean;
  created_at: string;
  revision: number;
  lease_until: string | null;
  progress: RunProgress | null;
  pages_total: number | null;
  analysis_mode: "instant" | "live" | null;
  cache_result: CacheCheck["cache"] | null;
  duration_ms: number | null;
  result: Report | null;
  error: string | null;
};

const TABLE = "argus_runs";
const BUCKET = "argus-policy-pdfs";
const summary = "id,filename,display_name,pinned,deleting_at,checksum,status,error,revision,created_at,lease_until,progress,analysis_mode,duration_ms,decision:result->>status";

export function present(run: StoredRun, includeResult = true) {
  const { id, filename, display_name, pinned, deleting_at, checksum, status, error, revision, created_at, result, lease_until, progress, analysis_mode, ocr_mode, cache_result, duration_ms, pdf_deleted_at, pdf_cleanup_pending } = run;
  return { id, filename, display_name, pinned, deleting_at, checksum, status, error, revision, created_at, lease_until, progress, analysis_mode, ocr_mode, cache_result, duration_ms, pdf_deleted_at, pdf_cleanup_pending, decision: result?.status ?? null, ...(includeResult ? { result } : {}) };
}

export function runStore(client: SupabaseClient, owner: string) {
  // Every service-role query carries the verified reviewer ID.
  const owned = (id: string) => {
    if (!uuid(id)) throw new HttpError(404, "Run not found.");
    return { id, owner_id: owner };
  };
  const bucket = client.storage.from(BUCKET);
  async function wantsOriginalDeleted(result: Report | null) {
    if (!result || requiredReviewFields(result).length) return false;
    const { data, error } = await client.from("argus_user_preferences")
      .select("delete_originals").eq("owner_id", owner).maybeSingle();
    if (error) throw error;
    return data?.delete_originals === true;
  }

  return {
    async list() {
      const { data, error } = await client.from(TABLE).select(summary).eq("owner_id", owner)
        .neq("status", "uploading")
        .or("analysis_mode.is.null,analysis_mode.neq.instant,status.in.(complete,failed,cancelled)")
        .order("pinned", { ascending: false }).order("created_at", { ascending: false }).limit(100);
      if (error) throw error;
      return data;
    },
    async get(id: string): Promise<StoredRun> {
      const { data, error } = await client.from(TABLE).select("*").match(owned(id))
        .neq("status", "uploading").maybeSingle<StoredRun>();
      if (error) throw error;
      if (!data) throw new HttpError(404, "Run not found.");
      return data;
    },
    async refreshTataDecision(run: StoredRun) {
      const result = run.result;
      if (run.deleting_at || run.status !== "complete" ||
          result?.tp.reason !== "The workbook does not confirm which payout cluster covers the policy’s RTO.") return run;
      const { data, error } = await client.from(TABLE).update({
        result: applyRating(result), revision: run.revision + 1,
      }).match({ ...owned(run.id), status: "complete", revision: run.revision })
        .is("deleting_at", null).select("*").maybeSingle<StoredRun>();
      if (error) throw error;
      return data ?? this.get(run.id);
    },
    async upload(input: { filename: string; bytes: Buffer; digest: string; allowCloud: boolean }, key: string, pages_total: number, cache_result: CacheCheck["cache"]) {
      const entry = {
        owner_id: owner, upload_key: key, filename: input.filename, size_bytes: input.bytes.length,
        checksum: input.digest, allow_cloud: input.allowCloud, pages_total, cache_result,
        analysis_mode: cache_result === "hit" ? "instant" : "live",
      };
      const insert = await client.from(TABLE).upsert(entry, {
        onConflict: "owner_id,upload_key", ignoreDuplicates: true,
      });
      if (insert.error) throw insert.error;

      const existing = await client.from(TABLE).select("*").match({
        owner_id: owner, upload_key: key,
      }).single<StoredRun>();
      if (existing.error) throw existing.error;
      const run = existing.data;
      if (run.checksum !== input.digest || run.allow_cloud !== input.allowCloud || run.filename !== input.filename) {
        throw new HttpError(409, "This upload key already belongs to a different request.");
      }
      if (run.deleting_at) throw new HttpError(409, "This run is being deleted.");
      if (run.status !== "uploading") return run;
      // Retried writes use the same owner, object key, and verified bytes.
      const stored = await bucket.upload(pdfObject(owner, run.id), input.bytes, {
        contentType: "application/pdf", upsert: true, cacheControl: "0",
      });
      if (stored.error) throw stored.error;
      const queued = await client.from(TABLE).update({ status: "queued" })
        .match({ ...owned(run.id), status: "uploading" }).select("*").maybeSingle<StoredRun>();
      if (queued.error) throw queued.error;
      return queued.data ?? this.get(run.id);
    },
    async pdf(id: string) {
      const run = await this.get(id);
      if (run.deleting_at) throw new HttpError(410, "This run is being deleted.");
      if (run.pdf_deleted_at || run.pdf_cleanup_pending) throw new HttpError(410, "The original PDF is unavailable after analysis.");
      const { data, error } = await bucket.download(pdfObject(owner, run.id));
      if (error) throw error;
      return { run, pdf: data };
    },
    async claim(id: string): Promise<StoredRun | null> {
      const { id: runId } = owned(id);
      const { data, error } = await client.rpc("argus_claim_run", { run_id: runId, reviewer_id: owner })
        .maybeSingle<StoredRun>();
      if (error) throw error;
      return data;
    },
    async cachedOcr(checksum: string) {
      const { data, error } = await client.from("argus_ocr_cache").select("extraction").match({
        owner_id: owner, checksum, profile: verifiedOcrProfile(),
      }).abortSignal(AbortSignal.timeout(5000)).maybeSingle<{ extraction: Extraction }>();
      if (error || data?.extraction.checksum !== checksum) return null;
      return data.extraction;
    },
    async reviewedOcr(checksum: string): Promise<Extraction | null> {
      const { data, error } = await client.from(TABLE).select("result")
        .match({ owner_id: owner, checksum, status: "complete" })
        .is("deleting_at", null).not("result->clarifications->0", "is", null)
        .order("created_at", { ascending: false }).limit(1).maybeSingle<{ result: Report }>();
      if (error) throw error;
      const report = data?.result;
      if (report?.checksum !== checksum || !report.clarifications.length || conflictFields(report).length) return null;
      const { filename, extraction_version, reader_failures, fields, clarifications } = report;
      return { filename, checksum, extraction_version, reader_failures, fields, clarifications };
    },
    async cacheOcr(completed: StoredRun) {
      if (completed.status !== "complete" || !completed.result) return;
      const verified = verifiedOcr(completed.result);
      if (!verified) return;
      const { error } = await client.rpc("argus_save_verified_ocr", {
        run_id: completed.id, reviewer_id: owner, cache_profile: verifiedOcrProfile(),
        verified_extraction: verified.extraction, verified_text: verified.grounded_text,
      }).abortSignal(AbortSignal.timeout(5000));
      if (error) console.warn("Argus could not save verified policy readings.");
    },
    async reserveGemini(claim: StoredRun): Promise<boolean> {
      const { data, error } = await client.rpc("argus_reserve_ocr", {
        run_id: claim.id, reviewer_id: owner, claim_revision: claim.revision, reader_name: "gemini-flash",
      }).abortSignal(AbortSignal.timeout(5000));
      if (error) throw error;
      return data === true;
    },
    async cachedPages(checksum: string) {
      const { data, error } = await client.from(TABLE).select("pages_total")
        .match({ owner_id: owner, checksum, status: "complete" }).is("deleting_at", null)
        .not("pages_total", "is", null).limit(1).maybeSingle();
      if (error) throw error;
      return data?.pages_total ?? null;
    },
    async samples() {
      const { data, error } = await client.from(TABLE).select("ocr_seconds_per_page")
        .match({ owner_id: owner, status: "complete", analysis_mode: "live" })
        .is("deleting_at", null).not("ocr_seconds_per_page", "is", null)
        .order("created_at", { ascending: false }).limit(50);
      return error ? [] : data.map(row => row.ocr_seconds_per_page);
    },
    async stillProcessing(claim: StoredRun) {
      const { data, error } = await client.from(TABLE).select("id")
        .match({ ...owned(claim.id), status: "processing", revision: claim.revision })
        .gt("lease_until", new Date().toISOString()).abortSignal(AbortSignal.timeout(3000)).maybeSingle();
      if (error) throw error;
      return Boolean(data);
    },
    async reportProgress(claim: StoredRun, progress: RunProgress) {
      const { error } = await client.from(TABLE).update({ progress })
        .match({ ...owned(claim.id), status: "processing", revision: claim.revision })
        .gt("lease_until", new Date().toISOString()).abortSignal(AbortSignal.timeout(3000));
      if (error) throw error;
    },
    async cancel(id: string) {
      const run = await this.get(id);
      if (run.status === "cancelled") return run;
      const now = new Date().toISOString();
      const progress: RunProgress = { pagesDone: 0, pagesTotal: run.pages_total, startedAt: run.created_at, ...run.progress,
        stage: "cancelled", status: "cancelled", stageStartedAt: now, updatedAt: now };
      const { data, error } = await client.from(TABLE).update({
        status: "cancelled", progress, lease_until: null, revision: run.revision + 1, error: "Analysis was cancelled.",
      }).match({ ...owned(id), revision: run.revision }).in("status", ["queued", "processing"])
        .select("*").maybeSingle<StoredRun>();
      if (error) throw error;
      if (!data) throw new HttpError(409, "This analysis has already finished or changed.");
      return data;
    },
    async finish(claim: StoredRun, result: Report | null, errorMessage: string | null, ocrMode: StoredRun["ocr_mode"],
      progress: RunProgress, stage_ms: Partial<Record<RunProgress["stage"], number>>, ocr_seconds_per_page: number | null,
      analysis_mode: StoredRun["analysis_mode"], cache_result: StoredRun["cache_result"]) {
      const deleteOriginal = await wantsOriginalDeleted(result);
      const { data, error } = await client.from(TABLE).update({
        status: result ? "complete" : "failed", result, error: errorMessage, lease_until: null,
        progress, stage_ms, ocr_seconds_per_page, analysis_mode, cache_result, duration_ms: Date.now() - Date.parse(progress.startedAt),
        revision: claim.revision + 1, ocr_mode: ocrMode, pdf_cleanup_pending: deleteOriginal,
      }).match({ ...owned(claim.id), status: "processing", revision: claim.revision })
        .gt("lease_until", new Date().toISOString()).select("*").maybeSingle<StoredRun>();
      if (error) throw error;
      return data ?? this.get(claim.id);
    },
    async cleanupOriginal(id: string) {
      const identity = owned(id);
      const pending = await client.from(TABLE).select("id").match({ ...identity, pdf_cleanup_pending: true, status: "complete" })
        .is("deleting_at", null).maybeSingle();
      if (pending.error) throw pending.error;
      if (!pending.data) return;
      const { error: storageError } = await bucket.remove([pdfObject(owner, id)]);
      if (storageError) throw storageError;
      const { error } = await client.from(TABLE).update({ pdf_deleted_at: new Date().toISOString(), pdf_cleanup_pending: false })
        .match(identity);
      if (error) throw error;
    },
    async removeAll() {
      const cutoff = new Date().toISOString();
      const active = await client.from(TABLE).select("id").eq("owner_id", owner)
        .or(`and(status.eq.processing,lease_until.gt.${cutoff}),and(status.eq.uploading,created_at.gt.${new Date(Date.now() - 900_000).toISOString()})`).limit(1);
      if (active.error) throw active.error;
      if (active.data.length) throw new HttpError(409, "Wait for active uploads and analyses to finish before deleting your runs.");
      for (;;) {
        const { data, error } = await client.from(TABLE).select("id").eq("owner_id", owner).lte("created_at", cutoff)
          .order("created_at").order("id").limit(50);
        if (error) throw error;
        if (!data.length) return;
        for (const run of data) await this.remove(run.id, true);
      }
    },
    async manage(current: StoredRun, displayName: string | null, pinned: boolean) {
      const { data, error } = await client.from(TABLE).update({
        display_name: displayName, pinned, revision: current.revision + 1,
      }).match({ ...owned(current.id), revision: current.revision }).is("deleting_at", null)
        .neq("status", "processing").select("*").maybeSingle<StoredRun>();
      if (error) throw error;
      if (!data) throw new HttpError(409, "The run changed. Reopen its settings and try again.");
      return data;
    },
    async remove(id: string, includeAbandonedUpload = false) {
      let query = client.from(TABLE).select("*").match(owned(id));
      if (!includeAbandonedUpload) query = query.neq("status", "uploading");
      const { data: run, error: readError } = await query.maybeSingle<StoredRun>();
      if (readError) throw readError;
      if (!run) return;
      if (run.status === "uploading" && Date.parse(run.created_at) > Date.now() - 900_000) {
        throw new HttpError(409, "An upload is still active. Try again later.");
      }
      if (!run.deleting_at) {
        const now = new Date().toISOString();
        const { data, error } = await client.from(TABLE).update({
          deleting_at: now, revision: run.revision + 1,
        }).match({ ...owned(id), revision: run.revision }).is("deleting_at", null)
          .or(`status.neq.processing,lease_until.lte.${now}`).select("id").maybeSingle();
        if (error) throw error;
        if (!data) throw new HttpError(409, "The run changed or is still processing. Try again once it has finished.");
      }
      const { error: storageError } = await bucket.remove([pdfObject(owner, id)]);
      if (storageError) throw new HttpError(503, "The original PDF could not be removed. Retry deletion.");
      const { error } = await client.rpc("argus_finish_delete", { run_id: id, reviewer_id: owner });
      if (error) throw new HttpError(503, "The deletion could not finish. Retry deletion.");
    },
    async revise(current: StoredRun, result: Report) {
      const deleteOriginal = await wantsOriginalDeleted(result);
      const { data, error } = await client.from(TABLE).update({
        result, revision: current.revision + 1, pdf_cleanup_pending: deleteOriginal,
      }).match({ ...owned(current.id), status: "complete", revision: current.revision }).is("deleting_at", null).select("*").maybeSingle<StoredRun>();
      if (error) throw error;
      if (!data) throw new HttpError(409, "The result changed. Reload it before confirming a value.");
      return data;
    },
  };
}
