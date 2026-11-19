import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { createClient } from "@supabase/supabase-js";
import { applyRating } from "../../lib/report.ts";
import { EXTRACTION_VERSION } from "../../lib/ingestion/providers.ts";
import { checksum, pdfObject } from "../../lib/upload.ts";
import { runStore } from "../../lib/runs.ts";
import { syntheticPdf } from "../fixtures/pdf.ts";

function accountJson(bytes: Buffer) {
  for (let offset = 0; bytes.readUInt32LE(offset) === 0x04034b50;) {
    assert.equal(bytes.readUInt16LE(offset + 8), 0, "Export entries use the ZIP store method");
    const size = bytes.readUInt32LE(offset + 18), length = bytes.readUInt16LE(offset + 26);
    const start = offset + 30 + length + bytes.readUInt16LE(offset + 28);
    if (bytes.subarray(offset + 30, offset + 30 + length).toString() === "argus.json") {
      return JSON.parse(bytes.subarray(start, start + size).toString());
    }
    offset = start + size;
  }
  throw new Error("Account JSON missing from ZIP");
}

test("exports upgrade unopened decisions just like history and refuse an active retry", async () => {
  const origin = new URL(process.env.ARGUS_TEST_URL!);
  const url = new URL(process.env.ARGUS_TEST_SUPABASE_URL!);
  for (const endpoint of [origin, url]) assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(endpoint.hostname),
    "Use a disposable local stack");
  const db = createClient(url.href, process.env.ARGUS_TEST_SUPABASE_SECRET!, { auth: { persistSession: false } });
  const email = `argus-export-${randomUUID()}@example.test`, password = randomUUID();
  const account = await db.auth.admin.createUser({ email, password, email_confirm: true });
  assert.ifError(account.error);
  const owner = account.data.user!.id, store = runStore(db, owner);
  const originals: string[] = [];
  try {
    const login = await fetch(new URL("/api/session", origin), { method: "POST",
      headers: { Origin: origin.origin, "Content-Type": "application/json" }, body: JSON.stringify({ email, password }) });
    assert.equal(login.status, 200);
    const cookie = login.headers.getSetCookie().map(value => value.split(";")[0]).join("; ");
    const headers = { Cookie: cookie, Origin: origin.origin, "Content-Type": "application/json" };
    const bytes = syntheticPdf("Synthetic policy schedule");
    const facts = { insurer: "Go Digit", policy_type: "Private Car SATP", rto: "UP78", fuel: "petrol",
      engine_cc: "1086", start_date: "2026-03-25" };
    const current = applyRating({ filename: "export.pdf", checksum: checksum(bytes), extraction_version: EXTRACTION_VERSION,
      reader_failures: {}, clarifications: [], fields: Object.fromEntries(Object.entries(facts).map(([field, value]) =>
        [field, { value, status: "accepted", reason: "source_verified", evidence: [] }])) });
    assert.equal(current.tp.rate, "29.5");
    const obsolete = { ...current, rule_version: "obsolete-test-grid", tp: { ...current.tp, rate: "99" } };
    async function saved() {
      const run = await store.upload({ filename: current.filename, bytes, digest: current.checksum, allowCloud: false }, randomUUID(), 1, "miss");
      originals.push(pdfObject(owner, run.id));
      assert.ifError((await db.from("argus_runs").update({ status: "complete", result: obsolete }).eq("id", run.id)).error);
      return run.id;
    }
    const dataRun = await saved(), singleRun = await saved(), openedRun = await saved();
    const exported = await fetch(new URL("/api/profile/export", origin), { method: "POST", headers, body: JSON.stringify({ type: "data" }) });
    assert.equal(exported.status, 200);
    const archived = accountJson(Buffer.from(await exported.arrayBuffer())).runs;
    for (const row of archived) {
      assert.equal(row.result.tp.rate, "29.5", "An unopened run must not export its obsolete payout");
      assert.equal(row.result.rule_version, current.rule_version);
      assert.equal(Object.hasOwn(row, "owner_id"), false, "Keep the existing public export shape");
    }
    assert.ifError((await db.from("argus_runs").update({ result: obsolete }).eq("id", singleRun)).error);
    const single = await fetch(new URL("/api/profile/export", origin), { method: "POST", headers,
      body: JSON.stringify({ type: "run", runId: singleRun }) });
    assert.equal(single.status, 200);
    const exportedRun = (await single.json()).result;
    assert.equal(exportedRun.tp.rate, "29.5");
    const opened = await fetch(new URL(`/api/runs/${openedRun}`, origin), { headers }).then(response => response.json());
    assert.deepEqual(exportedRun, opened.run.result);
    const persisted = await store.get(dataRun);
    assert.equal(persisted.result?.tp.rate, "29.5");
    assert.ifError((await db.from("argus_runs").update({ status: "processing", ocr_retry_attempted_at: new Date().toISOString(),
      lease_until: new Date(Date.now() + 60_000).toISOString() }).eq("id", singleRun)).error);
    const busy = await fetch(new URL("/api/profile/export", origin), { method: "POST", headers,
      body: JSON.stringify({ type: "run", runId: singleRun }) });
    assert.equal(busy.status, 409, "An active retry is not a completed export");
  } finally {
    if (originals.length) assert.ifError((await db.storage.from("argus-policy-pdfs").remove(originals)).error);
    assert.ifError((await db.from("argus_runs").delete().eq("owner_id", owner)).error);
    assert.ifError((await db.auth.admin.deleteUser(owner)).error);
  }
});
