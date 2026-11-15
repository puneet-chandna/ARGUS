import { endpoint, HttpError, json } from "../../../lib/http.ts";
import { inspectPdf, PdfError } from "../../../lib/ingestion/index.ts";
import { assertLiveConfiguration, ReaderError, READERS } from "../../../lib/ingestion/providers.ts";
import type { OcrMode } from "../../../lib/ocr-status.ts";
import { present, runStore } from "../../../lib/runs.ts";
import { reviewer, serviceClient } from "../../../lib/supabase.ts";
import { parseUpload, uuid } from "../../../lib/upload.ts";

async function ocrMode(client: ReturnType<typeof serviceClient>): Promise<OcrMode> {
  const cache = Boolean(process.env.ARGUS_OCR_CACHE_DIR);
  try {
    assertLiveConfiguration();
  } catch (error) {
    const code = error instanceof ReaderError ? error.message : "ocr_not_configured";
    if (code === "ocr_disabled" || code === "zero_spend_access_unverified" || code === "ocr_invalid_endpoint") {
      return { cache, live: code };
    }
    return { cache, live: "ocr_not_configured" };
  }

  const { data, error } = await client.from("argus_ocr_budget").select("reader,used,request_limit")
    .abortSignal(AbortSignal.timeout(5000));
  if (error || !data || !READERS.every(reader => data.some(row => row.reader === reader))) {
    return { cache, live: "quota_not_configured" };
  }
  const ready = READERS.every(reader => data.some(row => row.reader === reader && row.used < row.request_limit));
  return { cache, live: ready ? "ready" : "quota_budget_exhausted" };
}

export const GET = endpoint(async () => {
  const { user } = await reviewer();
  const client = serviceClient();
  const [runs, ocr] = await Promise.all([runStore(client, user.id).list(), ocrMode(client)]);
  return json({ runs, ocr });
});

export const POST = endpoint(async (request) => {
  const { user } = await reviewer();
  const key = request.headers.get("Idempotency-Key") ?? crypto.randomUUID();
  if (!uuid(key)) throw new HttpError(400, "Invalid upload key.");
  const input = await parseUpload(request);
  try {
    await inspectPdf(input.bytes);
  } catch (error) {
    if (!(error instanceof PdfError) || error.code === "pdf_renderer_unavailable") throw error;
    throw new HttpError(422, error.code === "invalid_page_count"
      ? "The PDF has no pages or exceeds the page limit."
      : "The PDF is encrypted, damaged, or could not be opened.");
  }
  const run = await runStore(serviceClient(), user.id).upload(input, key);
  return json({ run: present(run) }, 201);
});
