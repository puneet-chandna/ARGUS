import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { checksum, parseUpload } from "../lib/upload.ts";

const pdfFile = new URL("../vaatun-starter-bundle/sample-policies/pvt-car-satp-go-digit.pdf", import.meta.url);

function form(bytes: BlobPart, filename = "upload.pdf", allowCloud = false) {
  const data = new FormData();
  data.set("pdf", new File([bytes], filename, { type: "application/pdf" }));
  if (allowCloud) data.set("allowCloud", "true");
  return data;
}

test("PDF upload parsing preserves bytes and rejects invalid headers", async () => {
  const pdf = await readFile(pdfFile);
  const request = (data: FormData) => new Request("http://localhost/api/runs", { method: "POST", body: data });
  assert.deepEqual(await parseUpload(request(form(pdf))), {
    bytes: pdf, filename: "upload.pdf", digest: checksum(pdf), allowCloud: false,
  });
  await assert.rejects(parseUpload(request(form("not a PDF"))), /Invalid PDF header/);
});
