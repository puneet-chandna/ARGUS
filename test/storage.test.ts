import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
import test from "node:test";
import { createClient } from "@supabase/supabase-js";
import { decide } from "../lib/ingestion/facts.ts";
import { checksum, parseUpload, pdfObject } from "../lib/upload.ts";
import { EXTRACTION_VERSION } from "../lib/ingestion/providers.ts";
import { verifiedOcrProfile } from "../lib/verified-ocr.ts";

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

const base = process.env.ARGUS_TEST_URL;
test("real auth isolates history and PDF, retries bind to content, and original bytes survive processing", {
  skip: !base || !process.env.ARGUS_TEST_SUPABASE_URL || !process.env.ARGUS_TEST_SUPABASE_SECRET,
}, async () => {
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
    const response = await upload("unseen-synthetic.pdf");
    assert.equal(response.status, 201, JSON.stringify(await response.clone().json()));
    const { run } = await response.json();
    runId = run.id;
    originals.push({ owner: users[0], run: run.id });
    assert.equal(run.status, "queued");
    const prior = await upload("unseen-synthetic.pdf");
    assert.equal((await prior.json()).run.id, runId);
    assert.equal((await upload("different-request.pdf")).status, 409);
    assert.equal((await request("/api/runs", other)).status, 200);
    const otherWorkspace = await (await request("/api/runs", other)).json();
    assert.deepEqual(otherWorkspace.runs, []);
    assert.equal(typeof otherWorkspace.ocr.cache, "boolean");
    assert.equal(typeof otherWorkspace.ocr.live, "string");
    const path = `/api/runs/${runId}`;
    for (const [suffix, method] of [["", "GET"], ["/pdf", "GET"], ["", "POST"], ["", "PATCH"]]) {
      assert.equal((await request(path + suffix, other, {
        method, ...(method === "PATCH" ? { headers: { "Content-Type": "application/json" }, body: "{}" } : {}),
      })).status, 404);
    }
    assert.equal((await request(path + "/pdf", "")).status, 401);
    const { data: publicData } = supabase.storage.from("argus-policy-pdfs").getPublicUrl(pdfObject(users[0], runId!));
    assert.ok(!(await fetch(publicData.publicUrl)).ok);
    assert.equal((await request(path, owner, { method: "POST", headers: { Origin: "https://other.test" } })).status, 403);
    const results = await Promise.all([
      request(path, owner, { method: "POST" }), request(path, owner, { method: "POST" }),
    ]);
    assert.deepEqual(results.map(result => result.status).sort(), [200, 202]);
    const stored = await completed(runId!, owner);
    assert.equal(stored.status, "complete", stored.error);
    assert.equal(stored.revision, 2);
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
    const { error: seedError } = await supabase.from("argus_ocr_cache").insert({
      owner_id: users[0], checksum: checksum(pdf), profile: verifiedOcrProfile(),
      extraction: {
        filename: cachedFile, checksum: checksum(pdf), extraction_version: EXTRACTION_VERSION,
        reader_failures: {}, clarifications: [],
        fields: { make: { value: "private-test-marker", status: "accepted", reason: "independent_agreement",
          evidence: [{ file: cachedFile, page: 1, quote: "Private test marker" }] } },
      },
      grounded_text: [{ page: 1, text: "Private test marker" }],
    });
    assert.ifError(seedError);
    let duplicateId = "";
    for (const [i, cookie] of [owner, other].entries()) {
      const response = await request("/api/runs", cookie, { method: "POST", body: form(pdf, "renamed.pdf") });
      assert.equal(response.status, 201);
      const { run: next } = await response.json();
      originals.push({ owner: users[i], run: next.id });
      const result = await request(`/api/runs/${next.id}`, cookie, { method: "POST" });
      assert.equal(result.status, 202);
      const analyzed = await completed(next.id, cookie);
      const marker = analyzed.result.fields.make;
      if (i === 0) {
        duplicateId = next.id;
        assert.equal(marker.value, "private-test-marker");
        assert.equal(marker.evidence[0].file, "renamed.pdf");
      } else {
        assert.notEqual(marker?.value, "private-test-marker");
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
    const seeded = { ...renamed.result, fields: { ...renamed.result.fields, engine_cc: conflict } };
    assert.ifError((await supabase.from("argus_runs").update({ result: seeded }).eq("id", runId)).error);
    const confirmFields = (cookie: string, page: number, revision: number, resolve = true) => request(path, cookie, {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ revision, confirmations: [
        { field: "policy_type", value: "Liability Only Policy", page },
        ...(resolve ? [{ field: "engine_cc", value: "1086", page: 1 }] : []),
      ] }),
    });
    assert.equal((await confirmFields(other, 1, renamed.revision)).status, 404);
    assert.equal((await confirmFields(owner, pages + 1, renamed.revision)).status, 400);
    assert.equal((await confirmFields(owner, 1, renamed.revision, false)).status, 422);
    assert.deepEqual((await (await request(path, owner)).json()).run.result, seeded);
    const confirmedReview = await confirmFields(owner, 1, renamed.revision);
    assert.equal(confirmedReview.status, 200, JSON.stringify(await confirmedReview.clone().json()));
    const { run: reviewed } = await confirmedReview.json();
    assert.equal(reviewed.result.fields.policy_type.status, "confirmed_by_reviewer");
    assert.equal(reviewed.result.fields.policy_type.confirmation.page, 1);
    assert.equal(reviewed.result.od.applicable, false);
    assert.equal((await confirmFields(owner, 1, renamed.revision)).status, 409);

    for (const [i, cookie] of [owner, other].entries()) {
      const response = await request("/api/runs", cookie, { method: "POST", body: form(pdf, "review-replay.pdf") });
      assert.equal(response.status, 201);
      const { run: next } = await response.json();
      originals.push({ owner: users[i], run: next.id });
      assert.equal((await request(`/api/runs/${next.id}`, cookie, { method: "POST" })).status, 202);
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
    assert.ok((await supabase.storage.from("argus-policy-pdfs").download(pdfObject(users[0], runId!))).error);
    const cacheRows = () => supabase.from("argus_ocr_cache").select("checksum").eq("owner_id", users[0]);
    assert.equal((await cacheRows()).data?.length, 1);
    assert.equal((await remove(`/api/runs/${duplicateId}`, owner, true)).status, 200);
    assert.deepEqual((await cacheRows()).data, []);
  } finally {
    await supabase.storage.from("argus-policy-pdfs").remove(originals.map(({ owner, run }) => pdfObject(owner, run)));
    for (const user of users) {
      await supabase.from("argus_runs").delete().eq("owner_id", user);
      await supabase.auth.admin.deleteUser(user);
    }
  }
});
