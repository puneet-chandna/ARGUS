import type { SupabaseClient } from "@supabase/supabase-js";
import { HttpError } from "./http.ts";
import { conflictFields, requiredReviewFields } from "./review-fields.ts";
import type { CacheCheck, RunProgress } from "./progress.ts";
import { applyRating, needsBrokerageGwp, type Report } from "./report.ts";
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
  ocr_retry_attempted_at?: string | null;
  reread_attempted_at?: string | null;
  error: string | null;
};

const TABLE = "argus_runs";
const BUCKET = "argus-policy-pdfs";
const summary = "id,filename,display_name,pinned,deleting_at,checksum,status,error,revision,created_at,lease_until,progress,analysis_mode,duration_ms,decision:result->>status";
type UploadIdentity = { filename: string; digest: string; allowCloud: boolean };
export type HistoryCursor = { pinned: boolean; createdAt: string; id: string };

export function canRetryOcr(run: StoredRun) {
  const result = run.result;
  return run.status === "complete" && run.allow_cloud && !run.ocr_retry_attempted_at && !run.deleting_at &&
    !run.pdf_deleted_at && !run.pdf_cleanup_pending && result?.status === "ambiguous" &&
    Object.keys(result.reader_failures ?? {}).length > 0 && Boolean(result.blockers?.some(blocker =>
      blocker.kind === "policy_fact" && blocker.fields.some(field =>
        !["accepted", "confirmed_by_reviewer"].includes(result.fields[field]?.status))));
}

export function present(run: StoredRun, includeResult = true) {
  const { id, filename, display_name, pinned, deleting_at, checksum, status, error, revision, created_at, result, lease_until, progress, analysis_mode, ocr_mode, cache_result, duration_ms, pdf_deleted_at, pdf_cleanup_pending } = run;
  return { id, filename, display_name, pinned, deleting_at, checksum, status, error, revision, created_at, lease_until, progress, analysis_mode, ocr_mode, cache_result, duration_ms, pdf_deleted_at, pdf_cleanup_pending, can_retry_ocr: canRetryOcr(run), decision: result?.status ?? null, ...(includeResult ? { result } : {}) };
}

const retryRestored = "The OCR retry was interrupted. Your previous analysis is still available.";

export function runStore(client: SupabaseClient, owner: string) {
  // Every service-role query carries the verified reviewer ID.
  const owned = (id: string) => {
    if (!uuid(id)) throw new HttpError(404, "Run not found.");
    return { id, owner_id: owner };
  };
  const bucket = client.storage.from(BUCKET);
  async function wantsOriginalDeleted(result: Report | null) {
    if (!result || result.status === "ambiguous" || requiredReviewFields(result).length) return false;
    const { data, error } = await client.from("argus_user_preferences")
      .select("delete_originals").eq("owner_id", owner).maybeSingle();
    if (error) throw error;
    return data?.delete_originals === true;
  }

  return {
    async list(after?: HistoryCursor) {
      const { data, error } = await client.rpc("argus_run_history", {
        reviewer_id: owner, after_pinned: after?.pinned ?? null,
        after_created_at: after?.createdAt ?? null, after_id: after?.id ?? null,
      }).select(summary).order("pinned", { ascending: false })
        .order("created_at", { ascending: false }).order("id", { ascending: false });
      if (error) throw error;
      if (!Array.isArray(data)) throw new Error("Invalid saved runs response.");
      const runs = data.slice(0, 100);
      const last = runs.at(-1);
      const nextCursor = data.length > runs.length && last
        ? [last.pinned ? "1" : "0", last.created_at, last.id].join("|") : null;
      return { runs, nextCursor };
    },
    async get(id: string): Promise<StoredRun> {
      const { data, error } = await client.from(TABLE).select("*").match(owned(id))
        .neq("status", "uploading").maybeSingle<StoredRun>();
      if (error) throw error;
      if (!data) throw new HttpError(404, "Run not found.");
      const now = new Date().toISOString();
      if (data.status === "processing" && data.result && !data.deleting_at && Date.parse(data.lease_until ?? "") <= Date.parse(now)) {
        const restored = await client.from(TABLE).update({ status: "complete", progress: null, lease_until: null,
          revision: data.revision + 1, error: retryRestored })
          .match({ ...owned(id), status: "processing", revision: data.revision }).is("deleting_at", null)
          .lte("lease_until", now).select("*").maybeSingle<StoredRun>();
        if (restored.error) throw restored.error;
        return restored.data ?? this.get(id);
      }
      return data;
    },
    async refreshDecision(run: StoredRun) {
      const result = run.result;
      if (run.deleting_at || run.status !== "complete" || !result) return run;
      const legacyTata = result.tp.reason === "The workbook does not confirm which payout cluster covers the policy’s RTO.";
      const legacyGwp = needsBrokerageGwp(result.fields.eligible_private_car_gwp);
      const refreshed = applyRating(result);
      const changed = legacyTata || legacyGwp || !result.blockers || refreshed.rule_version !== result.rule_version;
      const cancelCleanup = run.pdf_cleanup_pending && (refreshed.status === "ambiguous" || requiredReviewFields(refreshed).length > 0);
      if (!changed && !cancelCleanup) return run;
      const { data, error } = await client.from(TABLE).update({
        ...(changed && { result: refreshed }), ...(cancelCleanup && { pdf_cleanup_pending: false }), revision: run.revision + 1,
      }).match({ ...owned(run.id), status: "complete", revision: run.revision })
        .is("deleting_at", null).select("*").maybeSingle<StoredRun>();
      if (error) throw error;
      return data ?? this.get(run.id);
    },
    async findUpload(input: UploadIdentity, key: string) {
      const { data: run, error } = await client.from(TABLE).select("*").match({
        owner_id: owner, upload_key: key,
      }).maybeSingle<StoredRun>();
      if (error) throw error;
      if (!run) return null;
      if (run.checksum !== input.digest || run.allow_cloud !== input.allowCloud || run.filename !== input.filename) {
        throw new HttpError(409, "This upload key already belongs to a different request.");
      }
      if (run.deleting_at) throw new HttpError(409, "This run is being deleted.");
      return run;
    },
    async upload(input: UploadIdentity & { bytes: Buffer }, key: string, pages_total: number, cache_result: CacheCheck["cache"]) {
      const entry = {
        owner_id: owner, upload_key: key, filename: input.filename, size_bytes: input.bytes.length,
        checksum: input.digest, allow_cloud: input.allowCloud, pages_total, cache_result,
        analysis_mode: cache_result === "hit" ? "instant" : "live",
      };
      const insert = await client.from(TABLE).upsert(entry, {
        onConflict: "owner_id,upload_key", ignoreDuplicates: true,
      });
      if (insert.error) throw insert.error;

      const run = await this.findUpload(input, key);
      if (!run) throw new HttpError(409, "This upload is no longer available. Choose the PDF again.");
      if (run.status !== "uploading") return run;
      // Retried writes use the same owner, object key, and verified bytes.
      const stored = await bucket.upload(pdfObject(owner, run.id), input.bytes, {
        contentType: "application/pdf", upsert: true, cacheControl: "0",
      });
      if (!stored.error) {
        const queued = await client.from(TABLE).update({ status: "queued" })
          .match({ ...owned(run.id), status: "uploading" }).is("deleting_at", null).select("*").maybeSingle<StoredRun>();
        if (queued.error) throw queued.error;
        if (queued.data) return queued.data;
      }
      // A concurrent retry or history recovery can queue the run and close the Storage write.
      const settled = await client.from(TABLE).select("*").match(owned(run.id))
        .neq("status", "uploading").is("deleting_at", null).maybeSingle<StoredRun>();
      if (settled.error) throw settled.error;
      if (settled.data) return settled.data;
      throw stored.error ?? new HttpError(409, "This upload is no longer available. Choose the PDF again.");
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
    async claimOcrRetry(run: StoredRun): Promise<StoredRun | null> {
      const { id: runId } = owned(run.id);
      const { data, error } = await client.rpc("argus_claim_ocr_retry", {
        run_id: runId, reviewer_id: owner, expected_revision: run.revision,
      }).maybeSingle<StoredRun>();
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
    async reserveReread(claim: StoredRun): Promise<boolean> {
      const { data, error } = await client.from(TABLE).update({ reread_attempted_at: new Date().toISOString() })
        .match({ ...owned(claim.id), status: "processing", revision: claim.revision, allow_cloud: true })
        .is("deleting_at", null).is("reread_attempted_at", null)
        .gt("lease_until", new Date().toISOString()).select("id").maybeSingle();
      if (error) throw error;
      return Boolean(data);
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
        status: run.result ? "complete" : "cancelled", progress: run.result ? null : progress,
        lease_until: null, revision: run.revision + 1,
        error: run.result ? "The OCR retry was cancelled. Your previous analysis is still available." : "Analysis was cancelled.",
      }).match({ ...owned(id), revision: run.revision }).in("status", ["queued", "processing"])
        .select("*").maybeSingle<StoredRun>();
      if (error) throw error;
      if (!data) throw new HttpError(409, "This analysis has already finished or changed.");
      return data;
    },
    async finish(claim: StoredRun, result: Report | null, errorMessage: string | null, ocrMode: StoredRun["ocr_mode"],
      progress: RunProgress, stage_ms: Partial<Record<RunProgress["stage"], number>>, ocr_seconds_per_page: number | null,
      analysis_mode: StoredRun["analysis_mode"], cache_result: StoredRun["cache_result"]) {
      const final = claim.result && !result ? { status: "complete", progress: null, error: retryRestored } : {
        pdf_cleanup_pending: await wantsOriginalDeleted(result),
        status: result ? "complete" : "failed", result, error: errorMessage,
        progress, stage_ms, ocr_seconds_per_page, analysis_mode, cache_result, duration_ms: Date.now() - Date.parse(progress.startedAt),
        ocr_mode: ocrMode,
      };
      const { data, error } = await client.from(TABLE).update({ ...final, lease_until: null, revision: claim.revision + 1 })
        .match({ ...owned(claim.id), status: "processing", revision: claim.revision })
        .gt("lease_until", new Date().toISOString()).select("*").maybeSingle<StoredRun>();
      if (error) throw error;
      return data ?? this.get(claim.id);
    },
    async cleanupOriginal(id: string) {
      const identity = owned(id);
      const pending = await client.from(TABLE).select("*").match({ ...identity, pdf_cleanup_pending: true, status: "complete" })
        .is("deleting_at", null).maybeSingle();
      if (pending.error) throw pending.error;
      if (!pending.data) return;
      const current = await this.refreshDecision(pending.data);
      // A concurrent update can leave the legacy decision in place after the refresh attempt.
      if (!current.pdf_cleanup_pending || current.deleting_at || !current.result || current.result.status === "ambiguous" ||
          requiredReviewFields(applyRating(current.result)).length) return;
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
    async removeExpired(id: string) {
      const { id: runId } = owned(id);
      const { data, error } = await client.rpc("argus_mark_retention_delete", { run_id: runId, reviewer_id: owner });
      if (error) throw error;
      if (!data) return false;
      await this.remove(id);
      return true;
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
