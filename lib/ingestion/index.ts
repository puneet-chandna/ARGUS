import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { decide, grounded, type FieldDecision, type Confirmation, type PageRead, type Reader } from "./facts.ts";
import { cached, EXTRACTION_VERSION, liveKey, readLive, ReaderError, READER_LANES } from "./providers.ts";

export { canonical, CLARIFIABLE, decide } from "./facts.ts";
export type { Confirmation, Evidence, FieldDecision, PageRead, Reader } from "./facts.ts";

export type Extraction = {
  filename: string;
  checksum: string;
  extraction_version: string;
  reader_failures: Record<number, Partial<Record<Reader, string>>>;
  fields: Record<string, FieldDecision>;
  clarifications: Confirmation[];
};

export const MAX_PDF_BYTES = 20 * 1024 * 1024;
type PdfErrorCode = "document_too_large" | "invalid_pdf" | "invalid_page_count" | "encrypted_pdf"
  | "pdf_render_failed" | "invalid_page_render" | "pdf_renderer_unavailable";
export class PdfError extends Error {
  code: PdfErrorCode;

  constructor(code: PdfErrorCode) {
    super(code);
    this.code = code;
  }
}

const exec = promisify(execFile);
async function poppler(command: "pdfinfo" | "pdftoppm", args: string[], signal?: AbortSignal) {
  try {
    const {stdout} = await exec(command, args, {
      timeout: 20_000, maxBuffer: 16 * 1024 * 1024, encoding: "buffer", signal,
      env: { PATH: process.env.PATH, LC_ALL: "C", HOME: process.env.HOME, NODE_ENV: process.env.NODE_ENV },
    });
    return stdout;
  } catch (error) {
    const failure = error as NodeJS.ErrnoException & {stderr?: Buffer};
    if (failure.code === "ENOENT") throw new PdfError("pdf_renderer_unavailable");
    if (command === "pdfinfo" && /incorrect password/i.test(failure.stderr?.toString() ?? "")) {
      throw new PdfError("encrypted_pdf");
    }
    throw new PdfError(command === "pdfinfo" ? "invalid_pdf" : "pdf_render_failed");
  }
}

async function withPdf<T>(pdf: Uint8Array, work: (file: string, count: number) => Promise<T>, maxPages?: number): Promise<T> {
  if (pdf.byteLength > MAX_PDF_BYTES) throw new PdfError("document_too_large");
  if (!/^%PDF-\d\.\d$/.test(Buffer.from(pdf.subarray(0, 8)).toString("latin1"))) throw new PdfError("invalid_pdf");
  const limit = maxPages ?? Number(process.env.ARGUS_OCR_PAGES_PER_RUN || "20");
  if (!Number.isInteger(limit) || limit < 1 || limit > 60) throw new Error("ocr_invalid_page_budget");
  const directory = await mkdtemp(join(tmpdir(), "argus-"));
  try {
    const file = join(directory, "policy.pdf");
    await writeFile(file, pdf, {mode: 0o600, flag: "wx"});
    const info = (await poppler("pdfinfo", [file])).toString("utf8");
    if (/^Encrypted:\s+yes/m.test(info)) throw new PdfError("encrypted_pdf");
    const count = Number(/^Pages:\s+(\d+)/m.exec(info)?.[1]);
    if (!Number.isInteger(count) || count < 1 || count > limit) throw new PdfError("invalid_page_count");
    return await work(file, count);
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
}

export function inspectPdf(pdf: Uint8Array): Promise<number> {
  return withPdf(pdf, async (_file, count) => count);
}

export function storedPdfPages(pdf: Uint8Array): Promise<number> {
  return withPdf(pdf, async (_file, count) => count, 60);
}

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
async function renderPage(file: string, page: number, signal?: AbortSignal): Promise<Buffer> {
  const image = await poppler("pdftoppm", [
    "-f", String(page), "-l", String(page), "-r", "225",
    "-scale-to", "2048", "-png", "-singlefile", file,
  ], signal);
  if (!image.subarray(0, PNG.length).equals(PNG)) throw new PdfError("invalid_page_render");
  return image;
}

export function previewPage(pdf: Uint8Array, page: number): Promise<Buffer | null> {
  return withPdf(pdf, (file, count) =>
    Number.isInteger(page) && page >= 1 && page <= count ? renderPage(file, page) : Promise.resolve(null), 60);
}

const HALT = new Set(["http_400", "http_401", "http_402", "http_403", "http_404", "http_422", "http_429", "quota_budget_exhausted"]);
const errorCode = (error: unknown) => error instanceof ReaderError ? error.message : "reader_failed";

export function extract(
  pdf: Uint8Array,
  filename: string,
  allowCloud: boolean,
  reserveGemini?: (page: number) => Promise<boolean>,
  progress?: (completed: number, total: number, event: { page?: number; completedPages: number[]; partial?: { insurer?: string; vehicle?: string } }) => Promise<void>,
  onSendToCloud?: (page: number) => void,
  signal?: AbortSignal,
): Promise<Extraction> {
  return withPdf(pdf, async (file, count) => {
    const timeout = AbortSignal.timeout(12 * 60_000);
    const deadline = signal ? AbortSignal.any([timeout, signal]) : timeout;
    const reads: PageRead[] = [];
    const failures: Extraction["reader_failures"] = {};
    const failedAttempts: Record<string, Record<string, number>> = {};
    const halted = new Map<Reader, string>();
    let nextPage = 1;
    const completedPages: number[] = [];
    const active = new Set<number>();
    let reportedPage: number | undefined;
    let reporting = Promise.resolve();
    function reportPage(done = false) {
      if (!progress) return Promise.resolve();
      const page = active.values().next().value as number | undefined;
      if (!done && page === reportedPage) return Promise.resolve();
      reportedPage = page;
      const fields = done ? decide(filename, reads, false) : undefined;
      const value = (name: "insurer" | "make" | "model") => fields?.[name]?.status === "accepted" ? fields[name].value : null;
      const partial = fields ? { insurer: value("insurer") || undefined,
        vehicle: [value("make"), value("model")].filter(Boolean).join(" ") || undefined } : undefined;
      const event = { page, completedPages: [...completedPages], partial };
      reporting = reporting.then(() => progress(event.completedPages.length, count, event));
      return reporting;
    }

    async function read(
      lane: typeof READER_LANES[number], number: number, image: Buffer, peer?: Promise<PageRead | undefined>,
    ): Promise<PageRead | undefined> {
      async function usable(reading: PageRead) {
        if (!reading.quoteOnly) return true;
        const other = await peer;
        return other && !other.quoteOnly && reading.candidates.some(candidate => grounded(candidate, other.transcript));
      }

      let failure = "cloud_not_authorized";
      for (const reader of lane) {
        try {
          const hit = await cached(reader, number, image);
          if (hit) {
            if (await usable(hit)) return hit;
            failure = "ocr_quote_unconfirmed";
            continue;
          }
        } catch (error) {
          failure = errorCode(error);
        }
        if (!allowCloud) continue;
        if (deadline.aborted) {
          failure = "ocr_deadline";
          break;
        }
        if (!liveKey(reader)) {
          failure = "ocr_not_configured";
          continue;
        }
        const priorFailure = halted.get(reader);
        if (priorFailure) {
          failure = priorFailure;
          continue;
        }
        try {
          if (reader === "gemini-flash") {
            if (!reserveGemini) throw new ReaderError("quota_not_configured");
            const reserved = await reserveGemini(number).catch(() => {
              throw new ReaderError("quota_not_configured");
            });
            if (!reserved) throw new ReaderError("quota_budget_exhausted");
            if (deadline.aborted) throw new ReaderError("ocr_deadline");
          }
          onSendToCloud?.(number);
          const reading = await readLive(reader, number, image, deadline);
          if (!await usable(reading)) throw new ReaderError("ocr_quote_unconfirmed");
          return reading;
        } catch (error) {
          failure = errorCode(error);
          if (reader === "sarvam" && failure === "ocr_deadline" && !deadline.aborted) failure = "sarvam_job_timeout";
          const counts = failedAttempts[reader] ??= {};
          counts[failure] = (counts[failure] ?? 0) + 1;
          if (HALT.has(failure)) halted.set(reader, failure);
        }
      }
      (failures[number] ??= {})[lane[0]] = failure;
    }

    async function readPages() {
      // Limit raster memory and concurrent provider requests on small hosts.
      while (nextPage <= count && !deadline.aborted) {
        const number = nextPage++;
        active.add(number);
        await reportPage();
        signal?.throwIfAborted();
        const image = await renderPage(file, number, signal);
        const independent = read(READER_LANES[1], number, image);
        const pageReads = await Promise.all([read(READER_LANES[0], number, image, independent), independent]);
        for (const reading of pageReads) if (reading) reads.push(reading);
        active.delete(number);
        if (!deadline.aborted) {
          completedPages.push(number);
          await reportPage(true);
        }
      }
    }
    const workers = await Promise.allSettled(Array.from({ length: Math.min(count, 3) }, readPages));
    signal?.throwIfAborted();
    const failedWorker = workers.find(worker => worker.status === "rejected");
    if (failedWorker) throw failedWorker.reason;
    if (Object.keys(failedAttempts).length) console.warn("Argus OCR provider failures", failedAttempts);
    for (let page = nextPage; page <= count; page++) {
      failures[page] = {"sarvam": "ocr_deadline", "nvidia-super-vl": "ocr_deadline"};
    }
    return {
      filename,
      checksum: createHash("sha256").update(pdf).digest("hex"),
      extraction_version: EXTRACTION_VERSION,
      reader_failures: failures,
      fields: decide(filename, reads, Object.keys(failures).length === 0),
      clarifications: [],
    };
  });
}
