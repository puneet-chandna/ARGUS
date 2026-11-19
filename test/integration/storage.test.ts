import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
import test from "node:test";
import { createClient } from "@supabase/supabase-js";
import { decide } from "../../lib/ingestion/facts.ts";
import { checksum, pdfObject } from "../../lib/upload.ts";
import { EXTRACTION_VERSION } from "../../lib/ingestion/providers.ts";
import { applyRating } from "../../lib/report.ts";
import { runStore } from "../../lib/runs.ts";
import { rebindExtraction, verifiedOcrProfile } from "../../lib/verified-ocr.ts";

const pdfFile = new URL("../../vaatun-starter-bundle/sample-policies/pvt-car-satp-go-digit.pdf", import.meta.url);

function form(bytes: BlobPart, filename = "upload.pdf", allowCloud = true) {
  const data = new FormData();
  data.set("pdf", new File([bytes], filename, { type: "application/pdf" }));
  if (allowCloud) data.set("allowCloud", "true");
  return data;
}

const base = process.env.ARGUS_TEST_URL;
test("real auth isolates history and PDF, retries bind to content, and original bytes survive processing", async () => {
  assert.ok(base && process.env.ARGUS_TEST_SUPABASE_URL && process.env.ARGUS_TEST_SUPABASE_SECRET,
    "Configure an Argus app and disposable Supabase instance with ARGUS_TEST_* variables.");
  const url = new URL(base!);
  const supabaseUrl = new URL(process.env.ARGUS_TEST_SUPABASE_URL!);
  for (const address of [url, supabaseUrl]) assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(address.hostname), "Use a disposable local stack.");
  const supabase = createClient(supabaseUrl.toString(), process.env.ARGUS_TEST_SUPABASE_SECRET!, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const users: string[] = [];
  const pdf = await readFile(process.env.ARGUS_TEST_PDF || pdfFile);
  const key = randomUUID();
  const originals: { owner: string; run: string }[] = [];
  let runId: string | undefined;

  async function signIn() {
    const email = `argus-${randomUUID()}@example.test`;
    const password = randomUUID();
    const { data, error } = await supabase.auth.admin.createUser({ email, password, email_confirm: true });
    assert.ifError(error);
    users.push(data.user!.id);
    const response = await fetch(new URL("/api/session", url), {
      method: "POST",
      headers: { Origin: url.origin, "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    assert.equal(response.status, 200);
    const cookie = response.headers.getSetCookie().map((entry) => entry.split(";")[0]).join("; ");
    assert.ok(cookie);
    return cookie;
  }

  async function request(path: string, cookie: string, options: RequestInit = {}) {
    return fetch(new URL(path, url), {
      ...options, headers: { Origin: url.origin, Cookie: cookie, ...options.headers },
    });
  }

  async function completed(id: string, cookie: string) {
    const deadline = Date.now() + 5000;
    for (;;) {
      const response = await request(`/api/runs/${id}`, cookie);
      assert.equal(response.status, 200);
      const { run } = await response.json();
      if (run.status !== "processing" || Date.now() >= deadline) {
        assert.equal(run.status, "complete", run.error);
        return run;
      }
      await sleep(50);
    }
  }

  try {
    const owner = await signIn();
    const other = await signIn();

    const address = `argus-signup-${randomUUID()}@example.test`;
    const signup = await request("/api/signup", "", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: address, password: randomUUID() }),
    });
    assert.ok([201, 202].includes(signup.status), JSON.stringify(await signup.clone().json()));
    const listed = await supabase.auth.admin.listUsers({ perPage: 1000 });
    assert.ifError(listed.error);
    const account = listed.data.users.find(user => user.email === address);
    assert.ok(account);
    users.push(account.id);
    if (signup.status === 201) {
      const fresh = signup.headers.getSetCookie().map((entry) => entry.split(";")[0]).join("; ");
      assert.equal((await (await request("/api/session", fresh)).json()).email, address);
    }
    const generated = await supabase.auth.admin.generateLink({
      type: "signup", email: `argus-confirm-${randomUUID()}@example.test`, password: randomUUID(),
    });
    assert.ifError(generated.error);
    users.push(generated.data.user!.id);
    const callback = await request(`/auth/confirm?token_hash=${encodeURIComponent(generated.data.properties.hashed_token)}`,
      "", { redirect: "manual" });
    assert.equal(callback.headers.get("location"), new URL("/workspace", url).href);
    const confirmed = callback.headers.getSetCookie().map((entry) => entry.split(";")[0]).join("; ");
    assert.equal((await (await request("/api/session", confirmed)).json()).email, generated.data.user!.email);
    const upload = (filename: string, account = owner) => request("/api/runs", account, {
      method: "POST", headers: { "Idempotency-Key": key }, body: form(pdf, filename),
    });
    const hashPath = `/api/cache/check?hash=${checksum(pdf)}`;
    const signedOut = await request("/api/session", "");
    assert.equal(signedOut.status, 200);
    assert.equal(await signedOut.json(), null);
    assert.equal((await request(hashPath, "")).status, 401);
    assert.equal((await (await request(hashPath, owner)).json()).cache, "miss");
    assert.equal((await request("/api/runs", owner, { method: "POST", body: form(pdf, "no-consent.pdf", false) })).status, 422);
    const response = await upload("unseen-synthetic.pdf");
    assert.equal(response.status, 201, JSON.stringify(await response.clone().json()));
    const { run, mode, pagesToOcr } = await response.json();
    assert.equal(mode, "live");
    assert.ok(pagesToOcr > 0);
    runId = run.id;
    originals.push({ owner: users[0], run: run.id });
    assert.equal(run.status, "processing");
    const prior = await upload("unseen-synthetic.pdf");
    assert.equal((await prior.json()).run.id, runId);
    assert.equal((await upload("different-request.pdf")).status, 409);
    assert.equal((await request("/api/runs", other)).status, 200);
    const otherWorkspace = await (await request("/api/runs", other)).json();
    assert.deepEqual(otherWorkspace.runs, []);
    assert.equal(typeof otherWorkspace.ocr.cache, "boolean");
    assert.equal(typeof otherWorkspace.ocr.live, "string");
    const path = `/api/runs/${runId}`;
    for (const [suffix, method] of [["", "GET"], ["/pdf", "GET"], ["", "POST"], ["/cancel", "POST"], ["", "PATCH"]]) {
      assert.equal((await request(path + suffix, other, {
        method, ...(method === "PATCH" ? { headers: { "Content-Type": "application/json" }, body: "{}" } : {}),
      })).status, 404);
    }
    assert.equal((await request(path + "/pdf", "")).status, 401);
    const { data: publicData } = supabase.storage.from("argus-policy-pdfs").getPublicUrl(pdfObject(users[0], runId!));
    assert.ok(!(await fetch(publicData.publicUrl)).ok);
    assert.equal((await request(path, owner, { method: "POST", headers: { Origin: "https://other.test" } })).status, 403);
    const stored = await completed(runId!, owner);
    assert.equal(stored.status, "complete", stored.error);
    assert.equal(stored.revision, 2);
    assert.equal(stored.progress.stage, "complete");
    assert.equal(stored.progress.pagesDone, stored.progress.pagesTotal);
    assert.equal(stored.result.checksum, checksum(pdf));
    assert.ok(["resolved", "unsupported", "ambiguous"].includes(stored.result.status));
    const history = await (await request("/api/runs", owner)).json();
    assert.equal(history.runs.find((item: { id: string }) => item.id === runId).decision, stored.result.status);
    const original = await request(path + "/pdf", owner);
    assert.equal(original.status, 200);
    assert.equal(original.headers.get("cache-control"), "private, no-store");
    assert.deepEqual(Buffer.from(await original.arrayBuffer()), pdf);
    assert.equal((await request(path + "/pages?page=1", "")).status, 401);
    assert.equal((await request(path + "/pages?page=1", other)).status, 404);
    const { pages } = await (await request(path + "/pages", owner)).json();
    assert.ok(pages >= 1);
    const preview = await request(path + "/pages?page=1", owner);
    assert.equal(preview.status, 200);
    assert.equal(preview.headers.get("cache-control"), "private, no-store");
    assert.equal(preview.headers.get("content-type"), "image/png");
    assert.equal(Buffer.from(await preview.arrayBuffer()).subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
    assert.equal((await request(path + "/pages?page=" + (pages + 1), owner)).status, 404);

    const cachedFile = "reviewed-input.pdf";
    const candidates = [
      { field: "insurer", value: "Go Digit General Insurance Ltd.", quote: "Go Digit General Insurance Ltd.", box: null },
      { field: "policy_type", value: "Digit Private Car Liability Only Policy", quote: "Digit Private Car Liability Only Policy", box: null },
      { field: "rto", value: "UP78", quote: "RTO: UP78", box: null },
      { field: "fuel", value: "Petrol", quote: "Fuel type: Petrol", box: null },
      { field: "engine_cc", value: "1086", quote: "Engine capacity: 1086 cc", box: null },
      { field: "start_date", value: "2026-03-25", quote: "Policy Start Date: 2026-03-25", box: null },
    ] as const;
    const reads = (["sarvam", "nvidia-super-vl"] as const).map(reader => ({
      reader, model: "test", page: 1, transcript: candidates.map(candidate => candidate.quote).join("\n"),
      candidates: [...candidates],
    }));
    const report = applyRating({
      filename: cachedFile, checksum: checksum(pdf), extraction_version: EXTRACTION_VERSION,
      reader_failures: {}, clarifications: [], fields: decide(cachedFile, reads),
    });
    assert.equal(report.status, "resolved");
    assert.equal(report.tp.rate, "29.5");
    await runStore(supabase, users[0]).cacheOcr({ ...stored, result: report });
    const { data: cache, error: cacheError } = await supabase.from("argus_ocr_cache").select("grounded_text")
      .eq("owner_id", users[0]).single();
    assert.ifError(cacheError);
    assert.ok(cache.grounded_text.some(({ page, text }: { page: number; text: string }) => page === 1 && text === "RTO: UP78"));
    assert.equal((await (await request(hashPath, owner)).json()).cache, "hit");
    assert.equal((await (await request(hashPath, other)).json()).cache, "miss");
    let duplicateId = "";
    for (const [i, cookie] of [owner, other].entries()) {
      const response = await request("/api/runs", cookie, { method: "POST", body: form(pdf, "renamed.pdf", i !== 0) });
      assert.equal(response.status, 201);
      const { run: next, mode } = await response.json();
      originals.push({ owner: users[i], run: next.id });
      assert.equal(mode, i === 0 ? "instant" : "live");
      if (i === 0) assert.equal(next.status, "complete");
      const analyzed = await completed(next.id, cookie);
      const marker = analyzed.result.fields.insurer;
      if (i === 0) {
        duplicateId = next.id;
        assert.equal(marker.value, "go digit general insurance ltd.");
        assert.equal(marker.evidence[0].file, "renamed.pdf");
      } else {
        assert.notEqual(marker?.value, "go digit general insurance ltd.");
      }
    }

    async function updateRun(cookie: string, revision: number) {
      return request(path, cookie, {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ displayName: "Reviewed motor policy", pinned: true, revision }),
      });
    }
    assert.equal((await updateRun(other, stored.revision)).status, 404);
    assert.equal((await updateRun(owner, stored.revision - 1)).status, 409);
    const changed = await updateRun(owner, stored.revision);
    assert.equal(changed.status, 200);
    const { run: renamed } = await changed.json();
    assert.equal(renamed.display_name, "Reviewed motor policy");
    assert.equal(renamed.filename, "unseen-synthetic.pdf");
    assert.deepEqual(renamed.result, stored.result);
    const pinnedHistory = await (await request("/api/runs", owner)).json();
    assert.equal(pinnedHistory.runs[0].id, runId);
    assert.equal(pinnedHistory.runs[0].pinned, true);

    const conflict = decide("unseen-synthetic.pdf", [
      { reader: "sarvam", page: 1, transcript: "Engine capacity: 998 cc", model: "test",
        candidates: [{ field: "engine_cc", value: "998", quote: "Engine capacity: 998 cc", box: null }] },
      { reader: "nvidia-super-vl", page: 1, transcript: "Engine capacity: 1086 cc", model: "test",
        candidates: [{ field: "engine_cc", value: "1086", quote: "Engine capacity: 1086 cc", box: null }] },
    ]).engine_cc;
    const replayable = rebindExtraction(report, renamed.filename);
    const seeded = applyRating({ ...replayable, fields: { ...replayable.fields, engine_cc: conflict, policy_type: {
      ...replayable.fields.policy_type, value: null, status: "needs_review", reason: "insufficient_agreement",
    } } });
    assert.ifError((await supabase.from("argus_runs").update({ result: seeded }).eq("id", runId)).error);
    const confirmFields = (cookie: string, page: number, revision: number, resolve = true) => request(path, cookie, {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ revision, guided: true, confirmations: [
        { field: "policy_type", value: "Private Car Liability Only Policy", page },
        ...(resolve ? [{ field: "engine_cc", value: "1086", page: 1 }] : []),
      ] }),
    });
    assert.equal((await confirmFields(other, 1, renamed.revision)).status, 404);
    assert.equal((await confirmFields(owner, pages + 1, renamed.revision)).status, 400);
    assert.equal((await confirmFields(owner, 1, renamed.revision, false)).status, 422);
    assert.deepEqual((await (await request(path, owner)).json()).run.result, JSON.parse(JSON.stringify(seeded)));
    const confirmedReview = await confirmFields(owner, 1, renamed.revision);
    assert.equal(confirmedReview.status, 200, JSON.stringify(await confirmedReview.clone().json()));
    const { run: reviewed } = await confirmedReview.json();
    assert.equal(reviewed.result.fields.policy_type.status, "confirmed_by_reviewer");
    assert.equal(reviewed.result.fields.policy_type.confirmation.page, 1);
    assert.equal(reviewed.result.od.applicable, false);
    assert.equal(reviewed.result.tp.rate, "29.5");
    assert.equal((await confirmFields(owner, 1, renamed.revision)).status, 409);

    for (const [i, cookie] of [owner, other].entries()) {
      const response = await request("/api/runs", cookie, { method: "POST", body: form(pdf, "review-replay.pdf") });
      assert.equal(response.status, 201);
      const { run: next, mode } = await response.json();
      originals.push({ owner: users[i], run: next.id });
      assert.equal(mode, i === 0 ? "instant" : "live");
      const replay = await completed(next.id, cookie);
      if (i === 0) {
        assert.equal(replay.result.fields.engine_cc.value, "1086");
        assert.equal(replay.result.fields.engine_cc.status, "confirmed_by_reviewer");
        assert.equal(replay.result.fields.engine_cc.confirmation.file, "review-replay.pdf");
        assert.equal(replay.result.clarifications.length, 2);
        assert.equal((await request(`/api/runs/${next.id}`, owner, {
          method: "DELETE", headers: { "Content-Type": "application/json" }, body: '{"confirm":true}',
        })).status, 200);
      } else {
        assert.deepEqual(replay.result.clarifications, []);
      }
    }

    const remove = (target: string, cookie: string, confirm: boolean) => request(target, cookie, {
      method: "DELETE", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ confirm }),
    });
    assert.equal((await remove(path, owner, false)).status, 400);
    await remove(path, other, true);
    assert.equal((await request(path, owner)).status, 200);
    assert.equal((await remove(path, owner, true)).status, 200);
    assert.equal((await remove(path, owner, true)).status, 200);
    assert.equal((await request(path, owner)).status, 404);
    assert.equal((await request(path + "/pdf", owner)).status, 404);
    const bucket = supabase.storage.from("argus-policy-pdfs");
    const deletedObject = pdfObject(users[0], runId!);
    const lateRetry = await bucket.upload(deletedObject, pdf, { contentType: "application/pdf", upsert: true });
    assert.ok(lateRetry.error, "A delayed retry must not recreate the deleted PDF.");
    assert.ok((await bucket.download(deletedObject)).error);
    const replay = await upload("unseen-synthetic.pdf");
    const { run: replayed } = await replay.json();
    if (replayed) originals.push({ owner: users[0], run: replayed.id });
    assert.equal(replay.status, 409, "A used upload key must not create a new run after deletion.");
    const cacheRows = () => supabase.from("argus_ocr_cache").select("checksum").eq("owner_id", users[0]);
    assert.equal((await cacheRows()).data?.length, 1);
    assert.equal((await remove(`/api/runs/${duplicateId}`, owner, true)).status, 200);
    assert.deepEqual((await cacheRows()).data, []);

    const retryKey = randomUUID();
    assert.ifError((await supabase.from("argus_ocr_cache").insert({ owner_id: users[0], checksum: checksum(pdf),
      profile: verifiedOcrProfile(), extraction: report, grounded_text: [] })).error);
    const withoutConsent = () => request("/api/runs", owner, { method: "POST", headers: { "Idempotency-Key": retryKey },
      body: form(pdf, "cached-retry.pdf", false) });
    const originalResponse = await withoutConsent();
    assert.equal(originalResponse.status, 201);
    const { run: cachedRun } = await originalResponse.json();
    originals.push({ owner: users[0], run: cachedRun.id });
    assert.ifError((await supabase.from("argus_ocr_cache").delete().eq("owner_id", users[0])).error);
    const retry = await withoutConsent();
    assert.equal(retry.status, 201);
    assert.equal((await retry.json()).run.id, cachedRun.id);

    const staged = { owner_id: users[0], filename: "interrupted.pdf", size_bytes: pdf.length, checksum: checksum(pdf),
      pages_total: pages, status: "uploading", analysis_mode: "instant", cache_result: "hit" };
    const next = await supabase.from("argus_runs").insert({ ...staged, upload_key: randomUUID() }).select("id").single();
    assert.ifError(next.error);
    originals.push({ owner: users[0], run: next.data.id });
    assert.ifError((await supabase.storage.from("argus-policy-pdfs").upload(pdfObject(users[0], next.data.id), pdf,
      { contentType: "application/pdf" })).error);
    const recoveredHistory = await (await request("/api/runs", owner)).json();
    assert.equal(recoveredHistory.runs.find((item: { id: string }) => item.id === next.data.id)?.status, "queued");
    assert.equal((await request(`/api/runs/${next.data.id}/pdf`, owner)).status, 200);
    assert.ifError((await supabase.from("argus_runs").update({
      status: "processing", lease_until: "2025-01-01T00:00:00Z",
    }).eq("id", next.data.id)).error);
    const expiredHistory = await (await request("/api/runs", owner)).json();
    assert.ok(expiredHistory.runs.some((item: { id: string }) => item.id === next.data.id));
    const recovered = await request(`/api/runs/${next.data.id}`, owner, { method: "POST" });
    assert.equal(recovered.status, 202);
    assert.equal((await completed(next.data.id, owner)).ocr_mode, "local");

    const filler = Array.from({ length: 100 }, (_, i) => ({ ...staged, status: "queued", filename: `later-${i}.pdf`, upload_key: randomUUID() }));
    assert.ifError((await supabase.from("argus_runs").insert(filler)).error);
    const first = await (await request("/api/runs", owner)).json();
    assert.equal(first.runs.length, 100);
    assert.ok(first.nextCursor);
    const second = await (await request(`/api/runs?after=${encodeURIComponent(first.nextCursor)}`, owner)).json();
    assert.equal(second.runs.length, 2);
    assert.equal(second.nextCursor, null);
    assert.ok(second.runs.some((item: { id: string }) => item.id === cachedRun.id));

    assert.ifError((await supabase.from("argus_runs").update({ created_at: "2025-01-01T00:00:00Z" }).eq("id", cachedRun.id)).error);
    assert.ifError((await supabase.from("argus_user_preferences").upsert({ owner_id: users[0], retention_days: 30 })).error);
    const scheduled = await supabase.rpc("argus_retention_candidates");
    assert.ifError(scheduled.error);
    assert.ok(scheduled.data.some((item: { id: string }) => item.id === cachedRun.id));
    assert.ifError((await supabase.from("argus_user_preferences").update({ retention_days: null }).eq("owner_id", users[0])).error);
    const store = runStore(supabase, users[0]);
    assert.equal(await store.removeExpired(cachedRun.id), false);
    assert.equal((await request(`/api/runs/${cachedRun.id}/pdf`, owner)).status, 200);
    assert.ifError((await supabase.from("argus_user_preferences").update({ retention_days: 30 }).eq("owner_id", users[0])).error);
    const marked = await supabase.rpc("argus_mark_retention_delete", { run_id: cachedRun.id, reviewer_id: users[0] });
    assert.ifError(marked.error);
    assert.equal(marked.data, true);
    assert.ifError((await supabase.from("argus_user_preferences").update({ retention_days: null }).eq("owner_id", users[0])).error);
    const interrupted = await supabase.rpc("argus_retention_candidates");
    assert.ifError(interrupted.error);
    assert.ok(interrupted.data.some((item: { id: string }) => item.id === cachedRun.id));
    assert.equal(await store.removeExpired(cachedRun.id), true);
    assert.equal((await request(`/api/runs/${cachedRun.id}/pdf`, owner)).status, 404);
  } finally {
    await supabase.storage.from("argus-policy-pdfs").remove(originals.map(({ owner, run }) => pdfObject(owner, run)));
    for (const user of users) {
      await supabase.from("argus_runs").delete().eq("owner_id", user);
      await supabase.auth.admin.deleteUser(user);
    }
  }
});
