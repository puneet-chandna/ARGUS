import { endpoint, HttpError, json } from "../../../lib/http.ts";
import { inspectPdf, PdfError } from "../../../lib/ingestion/index.ts";
import { liveOcrStatus } from "../../../lib/ingestion/providers.ts";
import { present, runStore } from "../../../lib/runs.ts";
import { reviewer, serviceClient } from "../../../lib/supabase.ts";
import { parseUpload, uuid } from "../../../lib/upload.ts";

export const GET = endpoint(async () => {
  const { user } = await reviewer();
  const client = serviceClient();
  const runs = await runStore(client, user.id).list();
  const ocr = { cache: Boolean(process.env.ARGUS_OCR_CACHE_DIR), live: liveOcrStatus() };
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
