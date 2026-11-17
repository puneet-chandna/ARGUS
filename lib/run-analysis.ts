import { after } from "next/server";
import { setTimeout as delay } from "node:timers/promises";
import { extract, PdfError, type Extraction } from "./ingestion/index.ts";
import { EXTRACTION_VERSION, liveOcrStatus } from "./ingestion/providers.ts";
import { estimateSeconds, type CacheCheck, type RunProgress, type Stage } from "./progress.ts";
import { applyRating, type Report } from "./report.ts";
import type { runStore, StoredRun } from "./runs.ts";
import { checksum, requireConsent } from "./upload.ts";
import { rebindExtraction, reuseConfirmations } from "./verified-ocr.ts";

type Store = ReturnType<typeof runStore>;

export function fakeSlow() {
  // Simulations must never bypass OCR consent on a hosted production instance.
  if (process.env.NODE_ENV !== "development") return;
  const mode = process.env.ARGUS_FAKE_SLOW;
  if (mode === "1") return "miss";
  if (mode === "miss" || mode === "miss-fail" || mode === "partial" || mode === "cache-hit") return mode;
}

export async function lookupCache(store: Store, hash: string) {
  const fake = fakeSlow();
  if (fake) {
    const cache = fake === "cache-hit" ? "hit" : fake === "partial" ? "partial" : "miss";
    return { check: { cache, pagesTotal: 15, pagesCached: cache === "hit" ? 15 : cache === "partial" ? 9 : 0 },
      reusable: null, reviewed: null } satisfies CacheLookup;
  }
  const [cached, reviewed] = await Promise.all([store.cachedOcr(hash), store.reviewedOcr(hash)]);
  const reusable = cached ?? (reviewed?.extraction_version === EXTRACTION_VERSION &&
    !Object.keys(reviewed.reader_failures).length ? reviewed : null);
  const pagesTotal = reusable ? await store.cachedPages(hash) : null;
  return { check: { cache: reusable ? "hit" : "miss", pagesTotal, pagesCached: pagesTotal ?? 0 },
    reusable, reviewed } satisfies CacheLookup;
}

type CacheLookup = { check: CacheCheck; reusable: Extraction | null; reviewed: Extraction | null };

export async function startAnalysis(store: Store, run: StoredRun, cached?: CacheLookup, startedAt = new Date().toISOString()): Promise<StoredRun> {
  if (run.status === "complete" || (run.status === "processing" && Date.parse(run.lease_until ?? "") > Date.now())) return run;
  const lookup = cached ?? await lookupCache(store, run.checksum);
  requireConsent(lookup.check.cache, run.allow_cloud);
  const claim = await store.claim(run.id);
  if (!claim) return store.get(run.id);

  const fake = fakeSlow();
  const now = new Date().toISOString();
  const total = fake ? 15 : claim.pages_total;
  const cachedPages = fake === "partial" ? [1, 2, 3, 4, 5, 12, 13, 14, 15] : [];
  const mode: "instant" | "live" = lookup.check.cache === "hit" ? "instant" : "live";
  let progress: RunProgress = {
    stage: "uploading", status: "processing", pagesDone: cachedPages.length, pagesTotal: total,
    startedAt, stageStartedAt: startedAt, updatedAt: now, cachedPages,
  };
  const timings: Partial<Record<Stage, number>> = {};
  const externalPages = new Set<number>();
  const controller = new AbortController();
  let telemetry: number | null = null;
  function move(stage: Stage, patch: Partial<RunProgress> = {}) {
    const timestamp = new Date().toISOString();
    if (stage !== progress.stage) {
      timings[progress.stage] = Date.parse(timestamp) - Date.parse(progress.stageStartedAt);
    }
    progress = { ...progress, ...patch, stage, updatedAt: timestamp,
      stageStartedAt: stage === progress.stage ? progress.stageStartedAt : timestamp };
  }
  async function publish(stage: Stage, patch?: Partial<RunProgress>) {
    move(stage, patch);
    await store.reportProgress(claim!, progress).catch(() => {
      // A transient progress write must not discard an otherwise valid analysis.
      console.warn("Argus could not persist an analysis progress update.");
    });
  }

  async function analyze() {
    let watcher: ReturnType<typeof setTimeout> | undefined;
    const watch = async () => {
      try {
        if (!await store.stillProcessing(claim!)) controller.abort();
      } catch {
        // The revision fence still prevents cancelled workers committing results.
      }
      if (!controller.signal.aborted) watcher = setTimeout(watch, 1500);
    };
    const extractionStub: Extraction = {
      filename: claim!.filename, checksum: claim!.checksum, extraction_version: EXTRACTION_VERSION,
      fields: {}, reader_failures: { 1: { sarvam: "simulated" } }, clarifications: [],
    };
    let result: Report | null = null;
    let reason: string | null = null;
    try {
      let extraction: Extraction;
      if (lookup.reusable || fake === "cache-hit") {
        extraction = lookup.reusable ? rebindExtraction(lookup.reusable, claim!.filename) : extractionStub;
        move("resolving");
      } else {
        watcher = setTimeout(watch, 1500);
        await publish("reading", { page: cachedPages.length ? 6 : 1,
          ...(!fake && { estimatedSeconds: estimateSeconds(await store.samples(), total) }) });
        let readStarted = 0;
        if (fake) {
          const completedPages: number[] = [...cachedPages];
          for (let page = 1; page <= 15; page++) {
            if (cachedPages.includes(page)) continue;
            await publish("reading", { page });
            await delay(page === 6 ? 25_000 : 3000 + (page % 6) * 1000, undefined, { signal: controller.signal });
            if (fake === "miss-fail" && page === 3) throw new Error("simulated_failure");
            completedPages.push(page);
            await publish("reading", { pagesDone: completedPages.length, completedPages: [...completedPages] });
          }
          extraction = extractionStub;
        } else {
          const { pdf } = await store.pdf(claim!.id);
          const bytes = new Uint8Array(await pdf.arrayBuffer());
          if (checksum(bytes) !== claim!.checksum) throw new Error("pdf_checksum");
          readStarted = performance.now();
          extraction = await extract(bytes, claim!.filename, claim!.allow_cloud && liveOcrStatus() === "ready",
            () => store.reserveGemini(claim!),
            (checked, count, event) => publish("reading", {
              pagesDone: checked, pagesTotal: count, ...event, partial: event.partial ?? progress.partial,
            }), page => { externalPages.add(page); }, controller.signal);
        }
        if (externalPages.size && progress.pagesDone === progress.pagesTotal && !Object.keys(extraction.reader_failures).length) {
          telemetry = (performance.now() - readStarted) / 1000 / externalPages.size;
        }
        await publish("resolving");
      }
      controller.signal.throwIfAborted();
      result = applyRating(lookup.reviewed && lookup.reusable !== lookup.reviewed
        ? reuseConfirmations(extraction, lookup.reviewed) : extraction);
    } catch (error) {
      if (controller.signal.aborted) return store.get(claim!.id);
      reason = fake === "miss-fail" ? "The simulated reader could not read this page." : error instanceof PdfError
        ? "The stored PDF could not be rendered." : "Analysis could not finish. Retry from your saved original.";
    } finally {
      controller.abort();
      clearTimeout(watcher);
    }
    const stage = result ? "complete" : "failed";
    move(stage, { status: stage, ...(result && mode === "instant" && { pagesDone: total ?? 0 }) });
    const completed = await store.finish(claim!, result, reason, externalPages.size ? "external" : "local", progress, timings, telemetry, mode, lookup.check.cache);
    if (completed.status === "complete" && completed.revision === claim!.revision + 1) {
      if (mode === "instant") {
        after(async () => { await store.cleanupOriginal(completed.id).catch(() => {}); });
      } else await Promise.allSettled([store.cacheOcr(completed), store.cleanupOriginal(completed.id)]);
    }
    return completed;
  }

  if (mode === "instant") return analyze();
  await publish("uploading");
  after(async () => { await analyze(); });
  return { ...claim, progress, analysis_mode: mode, cache_result: lookup.check.cache };
}
