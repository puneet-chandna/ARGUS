import type { SupabaseClient } from "@supabase/supabase-js";
import { HttpError } from "./http.ts";
import { conflictFields } from "./review-fields.ts";
import type { Report } from "./report.ts";
import type { Extraction } from "./ingestion/index.ts";
import { verifiedOcr, verifiedOcrProfile } from "./verified-ocr.ts";
import { pdfObject, uuid } from "./upload.ts";

type Run = {
  id: string;
  owner_id: string;
  upload_key: string;
  filename: string;
  display_name: string | null;
  pinned: boolean;
  deleting_at: string | null;
  status: "uploading" | "queued" | "processing" | "failed" | "complete";
  checksum: string;
  size_bytes: number;
  allow_cloud: boolean;
  created_at: string;
  revision: number;
  lease_until: string | null;
  ocr_progress?: { completed: number; total: number } | null;
  result: Report | null;
  error: string | null;
};

const TABLE = "argus_runs";
const BUCKET = "argus-policy-pdfs";
const summary = "id,filename,display_name,pinned,deleting_at,checksum,status,error,revision,created_at,lease_until,decision:result->>status";

export function present(run: Run, includeResult = true) {
  const { id, filename, display_name, pinned, deleting_at, checksum, status, error, revision, created_at, result, lease_until, ocr_progress } = run;
  return { id, filename, display_name, pinned, deleting_at, checksum, status, error, revision, created_at, lease_until, ocr_progress, decision: result?.status ?? null, ...(includeResult ? { result } : {}) };
}

export function runStore(client: SupabaseClient, owner: string) {
  // Every service-role query carries the verified reviewer ID.
  const owned = (id: string) => {
    if (!uuid(id)) throw new HttpError(404, "Run not found.");
    return { id, owner_id: owner };
  };
  const bucket = client.storage.from(BUCKET);

  return {
    async list() {
      const { data, error } = await client.from(TABLE).select(summary).eq("owner_id", owner)
        .neq("status", "uploading").order("pinned", { ascending: false }).order("created_at", { ascending: false }).limit(100);
      if (error) throw error;
      return data;
    },
    async get(id: string): Promise<Run> {
      const { data, error } = await client.from(TABLE).select("*").match(owned(id))
        .neq("status", "uploading").maybeSingle<Run>();
      if (error) throw error;
      if (!data) throw new HttpError(404, "Run not found.");
      return data;
    },
    async upload(input: { filename: string; bytes: Buffer; digest: string; allowCloud: boolean }, key: string) {
      const entry = {
        owner_id: owner, upload_key: key, filename: input.filename, size_bytes: input.bytes.length,
        checksum: input.digest, allow_cloud: input.allowCloud,
      };
      const insert = await client.from(TABLE).upsert(entry, {
        onConflict: "owner_id,upload_key", ignoreDuplicates: true,
      });
      if (insert.error) throw insert.error;

      const existing = await client.from(TABLE).select("*").match({
        owner_id: owner, upload_key: key,
      }).single<Run>();
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
        .match({ ...owned(run.id), status: "uploading" }).select("*").maybeSingle<Run>();
      if (queued.error) throw queued.error;
      return queued.data ?? this.get(run.id);
    },
    async pdf(id: string) {
      const run = await this.get(id);
      if (run.deleting_at) throw new HttpError(410, "This run is being deleted.");
      const { data, error } = await bucket.download(pdfObject(owner, run.id));
      if (error) throw error;
      return { run, pdf: data };
    },
    async claim(id: string): Promise<Run | null> {
      const { id: runId } = owned(id);
      const { data, error } = await client.rpc("argus_claim_run", { run_id: runId, reviewer_id: owner })
        .maybeSingle<Run>();
      if (error) throw error;
      return data;
    },
    async cachedOcr(claim: Run) {
      const { data, error } = await client.from("argus_ocr_cache").select("extraction").match({
        owner_id: owner, checksum: claim.checksum, profile: verifiedOcrProfile(),
      }).abortSignal(AbortSignal.timeout(5000)).maybeSingle<{ extraction: Extraction }>();
      if (error || data?.extraction.checksum !== claim.checksum) return null;
      return data.extraction;
    },
    async reviewedOcr(claim: Run): Promise<Extraction | null> {
      const { data, error } = await client.from(TABLE).select("result")
        .match({ owner_id: owner, checksum: claim.checksum, status: "complete" })
        .is("deleting_at", null).not("result->clarifications->0", "is", null)
        .order("created_at", { ascending: false }).limit(1).maybeSingle<{ result: Report }>();
      if (error) throw error;
      const report = data?.result;
      if (!report?.clarifications.length || conflictFields(report).length) return null;
      const { filename, checksum, extraction_version, reader_failures, fields, clarifications } = report;
      return { filename, checksum, extraction_version, reader_failures, fields, clarifications };
    },
    async cacheOcr(completed: Run) {
      if (completed.status !== "complete" || !completed.result) return;
      const verified = verifiedOcr(completed.result);
      if (!verified) return;
      await client.rpc("argus_save_verified_ocr", {
        run_id: completed.id, reviewer_id: owner, cache_profile: verifiedOcrProfile(),
        verified_extraction: verified.extraction, verified_text: verified.grounded_text,
      }).abortSignal(AbortSignal.timeout(5000));
    },
    async reserveGemini(claim: Run): Promise<boolean> {
      const { data, error } = await client.rpc("argus_reserve_ocr", {
        run_id: claim.id, reviewer_id: owner, claim_revision: claim.revision, reader_name: "gemini-flash",
      }).abortSignal(AbortSignal.timeout(5000));
      if (error) throw error;
      return data === true;
    },
    async reportProgress(claim: Run, completed: number, total: number) {
      await client.from(TABLE).update({ ocr_progress: { completed, total } })
        .match({ ...owned(claim.id), status: "processing", revision: claim.revision })
        .gt("lease_until", new Date().toISOString()).abortSignal(AbortSignal.timeout(2000));
    },
    async finish(claim: Run, result: Report | null, errorMessage: string | null) {
      const { data, error } = await client.from(TABLE).update({
        status: result ? "complete" : "failed", result, error: errorMessage, lease_until: null,
        revision: claim.revision + 1,
      }).match({ ...owned(claim.id), status: "processing", revision: claim.revision })
        .gt("lease_until", new Date().toISOString()).select("*").maybeSingle<Run>();
      if (error) throw error;
      return data ?? this.get(claim.id);
    },
    async manage(current: Run, displayName: string | null, pinned: boolean) {
      const { data, error } = await client.from(TABLE).update({
        display_name: displayName, pinned, revision: current.revision + 1,
      }).match({ ...owned(current.id), revision: current.revision }).is("deleting_at", null)
        .neq("status", "processing").select("*").maybeSingle<Run>();
      if (error) throw error;
      if (!data) throw new HttpError(409, "The run changed. Reopen its settings and try again.");
      return data;
    },
    async remove(id: string) {
      let run: Run;
      try {
        run = await this.get(id);
      } catch (error) {
        if (error instanceof HttpError && error.status === 404) return;
        throw error;
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
    async revise(current: Run, result: Report) {
      const { data, error } = await client.from(TABLE).update({
        result, revision: current.revision + 1,
      }).match({ ...owned(current.id), status: "complete", revision: current.revision }).is("deleting_at", null).select("*").maybeSingle<Run>();
      if (error) throw error;
      if (!data) throw new HttpError(409, "The result changed. Reload it before confirming a value.");
      return data;
    },
  };
}
