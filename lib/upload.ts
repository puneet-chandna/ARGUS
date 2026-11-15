import { createHash } from "node:crypto";
import { HttpError } from "./http.ts";

export const MAX_PDF = 20 * 1024 * 1024;
const MAX_MULTIPART = MAX_PDF + 64 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function uuid(value: string | null) {
  return typeof value === "string" && UUID.test(value);
}

export function checksum(bytes: Uint8Array) {
  return createHash("sha256").update(bytes).digest("hex");
}

export function pdfObject(owner: string, id: string) {
  return `${owner}/${id}.pdf`;
}

export async function parseUpload(request: Request) {
  const contentType = request.headers.get("content-type");
  if (!contentType?.startsWith("multipart/form-data;")) throw new HttpError(415, "Choose a PDF file.");
  const reader = request.body?.getReader();
  if (!reader) throw new HttpError(400, "Choose a PDF file.");
  try {
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > MAX_MULTIPART) throw new HttpError(413, "PDFs must be at most 20 MiB.");
      chunks.push(value);
    }
    let form: FormData;
    try {
      form = await new Response(Buffer.concat(chunks), { headers: { "Content-Type": contentType } }).formData();
    } catch {
      throw new HttpError(400, "The upload could not be read.");
    }
    const pdf = form.get("pdf");
    if (!(pdf instanceof File) || !pdf.size) throw new HttpError(400, "Choose a PDF file.");
    if (pdf.size > MAX_PDF) throw new HttpError(413, "PDFs must be at most 20 MiB.");
    const filename = pdf.name.split(/[\\/]/).at(-1)?.replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 220).toWellFormed();
    if (!filename?.toLowerCase().endsWith(".pdf")) throw new HttpError(415, "Choose a PDF file.");
    const bytes = Buffer.from(await pdf.arrayBuffer());
    if (bytes.subarray(0, 5).toString("ascii") !== "%PDF-") throw new HttpError(400, "Invalid PDF header.");
    return { filename, bytes, allowCloud: form.get("allowCloud") === "true", digest: checksum(bytes) };
  } finally {
    await reader.cancel().catch(() => {});
  }
}
