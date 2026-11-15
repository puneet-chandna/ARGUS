import { after } from "next/server";
import { endpoint, HttpError, json, readJson } from "../../../../lib/http.ts";
import { extract, PdfError, storedPdfPages } from "../../../../lib/ingestion/index.ts";
import { applyRating, clarifyBatch, type Report } from "../../../../lib/report.ts";
import { present, runStore } from "../../../../lib/runs.ts";
import { reviewer, serviceClient } from "../../../../lib/supabase.ts";
import { checksum } from "../../../../lib/upload.ts";
import { EXTRACTION_VERSION } from "../../../../lib/ingestion/providers.ts";
import { rebindExtraction, reuseConfirmations } from "../../../../lib/verified-ocr.ts";

type Context = { params: Promise<{ id: string }> };

async function context({ params }: Context) {
  const { user } = await reviewer();
  return { store: runStore(serviceClient(), user.id), id: (await params).id };
}

export const GET = endpoint(async (_request, route: Context) => {
  const { store, id } = await context(route);
  return json({ run: present(await store.get(id)) });
});

export const POST = endpoint(async (_request, route: Context) => {
  const { store, id } = await context(route);
  const claim = await store.claim(id);
  if (!claim) return json({ run: present(await store.get(id)) });

  after(async () => {
    let report: Report;
    try {
      const { pdf } = await store.pdf(id);
      const bytes = new Uint8Array(await pdf.arrayBuffer());
      if (checksum(bytes) !== claim.checksum) throw new Error("pdf_checksum");
      const [cached, reviewed] = await Promise.all([store.cachedOcr(claim), store.reviewedOcr(claim)]);
      const reusable = cached ?? (reviewed?.extraction_version === EXTRACTION_VERSION &&
        (!claim.allow_cloud || !Object.keys(reviewed.reader_failures).length) ? reviewed : null);
      const extraction = reusable ? rebindExtraction(reusable, claim.filename)
        : await extract(bytes, claim.filename, claim.allow_cloud, () => store.reserveGemini(claim));
      report = applyRating(reviewed && reusable !== reviewed ? reuseConfirmations(extraction, reviewed) : extraction);
    } catch (error) {
      const message = error instanceof PdfError
        ? "The stored PDF could not be rendered."
        : "Analysis could not finish. Retry from your saved original.";
      await store.finish(claim, null, message);
      return;
    }
    const completed = await store.finish(claim, report, null);
    if (completed.revision === claim.revision + 1) await store.cacheOcr(completed);
  });
  return json({ run: present(claim) }, 202);
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
  return json({ run: present(await store.revise(run, clarifyBatch(run.result, input.confirmations, pages))) });
});


export const DELETE = endpoint(async (request, route: Context) => {
  const { store, id } = await context(route);
  const input = await readJson(request);
  if (input.confirm !== true) throw new HttpError(400, "Confirm deletion of the run and original PDF.");
  await store.remove(id);
  return json({ deleted: true });
});
