import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { createClient } from "@supabase/supabase-js";
import { EXTRACTION_VERSION } from "../../lib/ingestion/providers.ts";
import { applyRating } from "../../lib/report.ts";
import { runStore } from "../../lib/runs.ts";
import { checksum, pdfObject } from "../../lib/upload.ts";
import { syntheticPdf } from "../fixtures/pdf.ts";

test("targeted attempts remain reserved across resume and reject other owners, cancelled claims and absent consent", async () => {
  const url = new URL(process.env.ARGUS_TEST_SUPABASE_URL!);
  assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(url.hostname), "Use disposable local Supabase.");
  const client = createClient(url.toString(), process.env.ARGUS_TEST_SUPABASE_SECRET!, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const account = await client.auth.admin.createUser({ email: `reread-${randomUUID()}@example.test`,
    password: randomUUID(), email_confirm: true });
  assert.ifError(account.error);
  const owner = account.data.user!.id;
  try {
    const inserted = await client.from("argus_runs").insert({ owner_id: owner, upload_key: randomUUID(),
      filename: "synthetic.pdf", checksum: "a".repeat(64), size_bytes: 10, status: "queued", allow_cloud: true }).select("id").single();
    assert.ifError(inserted.error);
    const store = runStore(client, owner);
    const claim = await store.claim(inserted.data.id);
    assert.ok(claim);
    assert.equal(await runStore(client, randomUUID()).reserveReread(claim), false);
    const reservations = await Promise.all([store.reserveReread(claim), store.reserveReread(claim)]);
    assert.equal(reservations.filter(Boolean).length, 1);
    assert.ok((await store.get(claim.id)).reread_attempted_at);
    assert.ifError((await client.from("argus_runs").update({ lease_until: "2025-01-01T00:00:00Z" }).eq("id", claim.id)).error);
    const resumed = await store.claim(claim.id);
    assert.ok(resumed && resumed.revision > claim.revision);
    assert.equal(await store.reserveReread(resumed), false);
    await store.cancel(claim.id);
    assert.equal(await store.reserveReread(resumed), false);
    assert.ifError((await client.from("argus_runs").update({ reread_attempted_at: null, allow_cloud: false }).eq("id", claim.id)).error);
    const localOnly = await store.claim(claim.id);
    assert.ok(localOnly);
    assert.equal(await store.reserveReread(localOnly), false);
  } finally {
    assert.ifError((await client.from("argus_runs").delete().eq("owner_id", owner)).error);
    assert.ifError((await client.auth.admin.deleteUser(owner)).error);
  }
});

test("completed OCR retry claims once and recovers the prior analysis when interrupted", async () => {
  const url = new URL(process.env.ARGUS_TEST_SUPABASE_URL!);
  assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(url.hostname), "Use disposable local Supabase.");
  const client = createClient(url.toString(), process.env.ARGUS_TEST_SUPABASE_SECRET!, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const account = await client.auth.admin.createUser({ email: `ocr-retry-${randomUUID()}@example.test`,
    password: randomUUID(), email_confirm: true });
  assert.ifError(account.error);
  const owner = account.data.user!.id;
  const store = runStore(client, owner);
  const bucket = client.storage.from("argus-policy-pdfs");
  const originals: string[] = [];
  const bytes = syntheticPdf("Policy schedule");
  const result = applyRating({ filename: "retry.pdf", checksum: checksum(bytes), extraction_version: EXTRACTION_VERSION,
    reader_failures: { 1: { sarvam: "provider_timeout" } }, fields: {}, clarifications: [] });
  const storedResult = JSON.parse(JSON.stringify(result));
  const now = new Date().toISOString();
  const progress = { stage: "complete", status: "complete", pagesDone: 1, pagesTotal: 1,
    startedAt: now, stageStartedAt: now, updatedAt: now } as const;
  async function completed(allowCloud = true, report = result) {
    const run = await store.upload({ filename: result.filename, bytes, digest: result.checksum, allowCloud }, randomUUID(), 1, "miss");
    originals.push(pdfObject(owner, run.id));
    const { data, error } = await client.from("argus_runs").update({ status: "complete", result: report, revision: 3 })
      .eq("id", run.id).select("*").single();
    assert.ifError(error);
    return data;
  }
  try {
    const run = await completed();
    const local = await completed(false);
    assert.equal(await store.claimOcrRetry(local), null);
    assert.equal(await store.claimOcrRetry(await completed(true, { ...result, status: "unsupported" })), null);
    assert.equal(await runStore(client, randomUUID()).claimOcrRetry(run), null);
    assert.equal(await store.claimOcrRetry({ ...run, revision: run.revision - 1 }), null);
    const claims = await Promise.all([store.claimOcrRetry(run), store.claimOcrRetry(run)]);
    assert.equal(claims.filter(Boolean).length, 1);
    const claim = claims.find(Boolean)!;
    assert.equal(claim.status, "processing");
    assert.deepEqual(claim.result, storedResult);
    const restored = await store.cancel(claim.id);
    assert.equal(restored.status, "complete");
    assert.deepEqual(restored.result, storedResult);
    assert.equal(checksum(new Uint8Array(await (await store.pdf(claim.id)).pdf.arrayBuffer())), result.checksum);
    assert.equal(await store.claimOcrRetry(restored), null);
    assert.equal(await store.claim(claim.id), null);
    assert.equal(await store.stillProcessing(claim), false);
    const late = await store.finish(claim, { ...result, reader_failures: {} }, null, "local", progress, {}, null, "live", "miss");
    assert.equal(late.revision, restored.revision);
    assert.deepEqual(late.result, storedResult);

    const failing = await store.claimOcrRetry(await completed());
    assert.ok(failing);
    const failed = await store.finish(failing, null, "A retry worker failed", "local", progress, {}, null, "live", "miss");
    assert.equal(failed.status, "complete");
    assert.deepEqual(failed.result, storedResult);
    assert.ok(failed.error);
    assert.equal(await store.claimOcrRetry(failed), null);

    const expiring = await store.claimOcrRetry(await completed());
    assert.ok(expiring);
    assert.ifError((await client.from("argus_runs").update({ lease_until: "2025-01-01T00:00:00Z" })
      .eq("id", expiring.id)).error);
    assert.equal(await store.claim(expiring.id), null);
    const expired = await store.get(expiring.id);
    assert.equal(expired.status, "complete");
    assert.deepEqual(expired.result, storedResult);
    assert.equal(await store.claimOcrRetry(expired), null);
    const audit = await client.from("argus_audit_events").select("action").match({ owner_id: owner, action: "analyzed" });
    assert.ifError(audit.error);
    assert.deepEqual(audit.data, []);

    const recovering = await store.claimOcrRetry(await completed());
    assert.ok(recovering);
    const updated = { ...result, reader_failures: {} };
    const recovered = await store.finish(recovering, updated, null, "local", progress, {}, null, "live", "miss");
    assert.equal(recovered.status, "complete");
    assert.equal(recovered.error, null);
    assert.deepEqual(recovered.result, { ...storedResult, reader_failures: {} });
    assert.equal(await store.claimOcrRetry(recovered), null);
    const completedAudit = await client.from("argus_audit_events").select("action").match({ owner_id: owner, action: "analyzed" });
    assert.ifError(completedAudit.error);
    assert.deepEqual(completedAudit.data, [{ action: "analyzed" }]);
  } finally {
    if (originals.length) assert.ifError((await bucket.remove(originals)).error);
    assert.ifError((await client.from("argus_runs").delete().eq("owner_id", owner)).error);
    assert.ifError((await client.auth.admin.deleteUser(owner)).error);
  }
});
