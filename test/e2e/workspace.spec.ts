import { expect, test as base, type Page } from "@playwright/test";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { EXTRACTION_VERSION } from "../../lib/ingestion/providers.ts";
import { decide, type PageRead } from "../../lib/ingestion/facts.ts";
import { applyRating } from "../../lib/report.ts";
import { runStore } from "../../lib/runs.ts";
import { checksum, pdfObject } from "../../lib/upload.ts";
import { verifiedOcrProfile } from "../../lib/verified-ocr.ts";
import { syntheticPdf } from "../fixtures/pdf.ts";

type Reviewer = { email: string; password: string; id: string; db: SupabaseClient };
const test = base.extend<{ reviewer: Reviewer }>({
  reviewer: async ({}, use) => {
    const url = process.env.ARGUS_TEST_SUPABASE_URL;
    const key = process.env.ARGUS_TEST_SUPABASE_SECRET;
    if (!url || !key || !["localhost", "127.0.0.1", "[::1]"].includes(new URL(url).hostname)) {
      throw new Error("Set ARGUS_TEST_SUPABASE_URL and ARGUS_TEST_SUPABASE_SECRET for a disposable local project.");
    }
    const db = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
    const email = `argus-browser-${randomUUID()}@example.test`;
    const password = randomUUID();
    const { data, error } = await db.auth.admin.createUser({ email, password, email_confirm: true });
    if (error) throw error;
    const id = data.user.id;
    try {
      await use({ email, password, id, db });
    } finally {
      const runs = await db.from("argus_runs").select("id").eq("owner_id", id);
      if (runs.error) throw runs.error;
      if (runs.data.length) {
        const removed = await db.storage.from("argus-policy-pdfs").remove(runs.data.map(run => pdfObject(id, run.id)));
        if (removed.error) throw removed.error;
        const deleted = await db.from("argus_runs").delete().eq("owner_id", id);
        if (deleted.error) throw deleted.error;
      }
      const cache = await db.from("argus_ocr_cache").delete().eq("owner_id", id);
      if (cache.error) throw cache.error;
      const account = await db.auth.admin.deleteUser(id);
      if (account.error && account.error.code !== "user_not_found") throw account.error;
    }
  },
});

async function signIn(page: Page, reviewer: Reviewer) {
  await page.getByLabel("Email address").fill(reviewer.email);
  await page.getByLabel("Password", { exact: true }).fill(reviewer.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page).toHaveURL(/\/workspace/);
}

async function uploadPdf(page: Page, name: string, buffer: Buffer) {
  await page.locator('input[type="file"]').setInputFiles({ name, mimeType: "application/pdf", buffer });
  await expect(page.locator(".cache-chip-row .cache-chip")).toBeVisible();
  const consent = page.getByRole("checkbox");
  if (await consent.isVisible()) await consent.check();
  await page.getByRole("button", { name: "Analyze policy" }).click();
  await expect(page.getByRole("heading", { name, exact: true })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole("heading", { name: "Broker commission" })).toBeVisible({ timeout: 15_000 });
}

test("the original Tata classification stays unresolved and its evidence and PDF reopen", async ({ page, reviewer }) => {
  const name = "pvt-car-satp-tata-aig.pdf";
  const pdf = await readFile(new URL(`../../vaatun-starter-bundle/sample-policies/${name}`, import.meta.url));
  const fixture = JSON.parse(await readFile(new URL("../../submission/pvt-car-satp-tata-aig.json", import.meta.url), "utf8"));
  // Reuse the source-reviewed observations without inventing a printed vehicle class.
  const seeded = await reviewer.db.from("argus_ocr_cache").insert({
    owner_id: reviewer.id, checksum: checksum(pdf), profile: verifiedOcrProfile(), grounded_text: [],
    extraction: { filename: name, checksum: checksum(pdf), extraction_version: EXTRACTION_VERSION,
      reader_failures: {}, clarifications: [], fields: fixture.fields },
  });
  expect(seeded.error).toBeNull();
  await page.goto("/sign-in");
  await signIn(page, reviewer);
  await uploadPdf(page, name, pdf);
  const commission = page.getByRole("region", { name: "Broker commission" });
  await expect(commission).toContainText("Confirm whether the policy is for a private car");
  await expect(commission).toContainText("Inapplicable");
  await expect(commission).toContainText("Undetermined");
  await page.getByRole("button", { name: "Vehicle class", exact: true }).click();
  const review = page.getByRole("dialog");
  await expect(review.getByRole("textbox", { name: "Value from the policy" })).toBeEmpty();
  await expect(review.getByRole("img", { name: /Page 4 of pvt-car-satp-tata-aig.pdf/i })).toBeVisible();
  await expect(review.getByRole("button", { name: /Use suggested value/ })).toHaveCount(0);
  await expect(review.getByRole("button", { name: "Recalculate commission" })).toBeDisabled();
  await review.getByRole("button", { name: "Back to report" }).click();
  const pdfUrl = await page.getByRole("link", { name: "Open original PDF in a new tab" }).getAttribute("href");
  expect(pdfUrl).toMatch(/^\/api\/runs\/.+\/pdf$/);
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page.getByRole("heading", { name: "Sign in to Argus" })).toBeVisible();
  expect((await page.request.get(pdfUrl!)).status()).toBe(401);
  await signIn(page, reviewer);
  await page.locator(".history-item").filter({ hasText: name }).click();
  await page.reload();
  await expect(commission).toContainText("Undetermined");
  await expect(page.getByRole("button", { name: "Vehicle class", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Export run", exact: true }).click();
  await expect(page.getByRole("link", { name: "Download JSON" })).toBeVisible();
  const activity = await page.request.get("/api/profile?view=activity").then(response => response.json());
  expect(activity.activity.events.map((event: { action: string }) => event.action)).toEqual(expect.arrayContaining(["analyzed", "exported"]));
  const original = await page.request.get(pdfUrl!);
  expect(original.status()).toBe(200);
  expect(checksum(await original.body())).toBe(checksum(pdf));
  const saved = await page.request.get(pdfUrl!.replace(/\/pdf$/, "")).then(response => response.json());
  expect(saved.run.result.fields.vehicle_class.value).toBeNull();
  expect(saved.run.result.fields.vehicle_class.evidence.map((source: { page: number }) => source.page)).toEqual(expect.arrayContaining([4, 7]));
  const legacy = { ...saved.run.result, status: "unsupported", tp: {
    status: "unsupported", rate: null, applicable: true,
    reason: "The workbook does not confirm which payout cluster covers the policy’s RTO.",
  } };
  const update = await reviewer.db.from("argus_runs").update({ result: legacy }).eq("id", saved.run.id);
  expect(update.error).toBeNull();
  await page.reload();
  await expect(commission).toContainText("Confirm whether the policy is for a private car");
  const stored = await reviewer.db.from("argus_runs").select("result,revision").eq("id", saved.run.id).single();
  expect(stored.error).toBeNull();
  expect(stored.data?.result.tp.rate).toBeNull();
  expect(stored.data?.result.status).toBe("ambiguous");
  expect(stored.data?.result.fields).toEqual(saved.run.result.fields);
  expect(stored.data?.revision).toBe(saved.run.revision + 1);
});

test("an unseen HDFC package can finish OD with eligible GWP and its own source", async ({ page, reviewer }) => {
  const name = "unseen-hdfc.pdf";
  const insurer = "HDFC ERGO General Insurance Company Limited";
  const title = "Private Car Comprehensive Policy";
  const premium = "Net Premium 75000";
  const start = "Policy start date: 25-Feb-2026";
  const lines = [insurer, title, "Registration No: MH-12-AB-0123", "Less: No Claim Bonus (20%)", premium, start];
  const pdf = syntheticPdf(...lines);
  const reads: PageRead[] = (["sarvam", "nvidia-super-vl"] as const).map(reader => ({
    reader, page: 1, model: "test", transcript: lines.join("\n"),
    candidates: [
      { field: "insurer", value: insurer, quote: insurer, box: null },
      { field: "policy_type", value: title, quote: title, box: null },
      { field: "net_premium", value: "75000", quote: premium, box: null },
      { field: "start_date", value: "25-Feb-2026", quote: start, box: null },
    ],
  }));
  const seed = await reviewer.db.from("argus_ocr_cache").insert({
    owner_id: reviewer.id, checksum: checksum(pdf), profile: verifiedOcrProfile(), grounded_text: [],
    extraction: { filename: name, checksum: checksum(pdf), extraction_version: EXTRACTION_VERSION,
      reader_failures: {}, clarifications: [], fields: decide(name, reads) },
  });
  expect(seed.error).toBeNull();
  await page.goto("/sign-in");
  await signIn(page, reviewer);
  await uploadPdf(page, name, pdf);
  await expect(page.getByRole("region", { name: "One policy detail to review" })).toContainText("Eligible private-car GWP");
  await page.getByRole("button", { name: "Eligible private-car GWP", exact: true }).click();
  const dialog = page.getByRole("dialog");
  const note = dialog.getByRole("complementary", { name: "Conditional OD estimate" });
  await expect(note).toContainText("₹75,000");
  await expect(note).toContainText("21% OD");
  await expect(note).toContainText("Zone 1");
  await expect(note).toContainText("OD stays undetermined");
  await expect(dialog.getByRole("textbox", { name: "Eligible GWP in rupees" })).toHaveValue("");
  await dialog.getByRole("textbox", { name: "Eligible GWP in rupees" }).fill("25000");
  await expect(dialog.getByRole("button", { name: "Confirm value" })).toBeDisabled();
  await dialog.getByRole("textbox", { name: "GWP source" }).fill("March private-car GWP ledger");
  await dialog.getByRole("button", { name: "Confirm value" }).click();
  await dialog.getByRole("button", { name: "Recalculate commission" }).click();
  const commission = page.getByRole("region", { name: "Broker commission" });
  await expect(commission).toContainText("19.5%");
  await expect(commission).toContainText("Unsupported");
  await page.getByRole("tab", { name: /Policy facts/ }).click();
  await expect(page.getByRole("tabpanel", { name: /Policy facts/ })).toContainText("March private-car GWP ledger");

  const id = new URL(page.url()).hash.slice(1);
  const store = runStore(reviewer.db, reviewer.id);
  const saved = (await store.get(id)).result!;
  const gwp = saved.fields.eligible_private_car_gwp;
  const legacy = { ...saved, fields: { ...saved.fields, eligible_private_car_gwp: {
    ...gwp, confirmation: { ...gwp.confirmation, page: 1, file: name },
  } } };
  const queued = await reviewer.db.from("argus_runs").update({ result: legacy, pdf_cleanup_pending: true })
    .match({ id, owner_id: reviewer.id });
  expect(queued.error).toBeNull();
  await store.cleanupOriginal(id);
  await page.reload();
  await expect(commission).toContainText("Confirm eligible private-car GWP");
  await expect(page.getByRole("button", { name: "Eligible private-car GWP", exact: true })).toBeVisible();
  expect((await page.request.get(`/api/runs/${id}/pdf`)).status()).toBe(200);
});

test("the reviewer resolves an unseen policy conflict from the PDF and keeps the cited choice", async ({ page, reviewer }) => {
  const name = "unseen-review-policy.pdf";
  const policyInputs = [
    { field: "insurer", value: "Digit General Insurance Ltd.", quote: "Digit General Insurance Ltd.", box: null },
    { field: "policy_type", value: "Private Car Liability Only Policy", quote: "Private Car Liability Only Policy", box: null },
    { field: "rto", value: "UP78", quote: "RTO: UP78", box: null },
    { field: "fuel", value: "Petrol", quote: "Fuel type: Petrol", box: null },
    { field: "start_date", value: "2026-03-25", quote: "Policy start date: 2026-03-25", box: null },
  ] as const;
  await page.goto("/sign-in");
  await signIn(page, reviewer);
  expect((await page.request.patch("/api/profile", { headers: { Origin: new URL(page.url()).origin },
    data: { part: "data", retention_days: null, delete_originals: true },
  })).status()).toBe(200);
  await uploadPdf(page, name, syntheticPdf("Engine capacity: 998 cc", ...policyInputs.map(input => input.quote)));
  await expect(page.getByRole("region", { name: "Broker commission" })).toContainText("Undetermined");

  // Inject the two OCR responses at the persisted analysis boundary; the review and storage routes stay real.
  const sources: PageRead[] = [
    { reader: "sarvam", model: "fixture-1", page: 1, transcript: "Engine capacity: 998 cc",
      candidates: [{ field: "engine_cc", value: "998", quote: "Engine capacity: 998 cc", box: [0.08, 0.2, 0.5, 0.4] }] },
    { reader: "nvidia-super-vl", model: "fixture-2", page: 1, transcript: "Engine capacity: 1086 cc",
      candidates: [{ field: "engine_cc", value: "1086", quote: "Engine capacity: 1086 cc", box: [0.08, 0.2, 0.5, 0.4] }] },
    ...policyInputs.flatMap((candidate, index) => (["sarvam", "nvidia-super-vl"] as const).map(reader => ({
      reader, model: "test", page: index + 2, transcript: candidate.quote, candidates: [candidate],
    }))),
  ];
  const { data, error } = await reviewer.db.from("argus_runs").select("id,result").eq("owner_id", reviewer.id).single();
  expect(error).toBeNull();
  const pdfUrl = `/api/runs/${data!.id}/pdf`;
  expect((await page.request.get(pdfUrl)).status()).toBe(200);
  const result = applyRating({ ...data!.result, fields: decide(name, sources), reader_failures: {} });
  const update = await reviewer.db.from("argus_runs")
    .update({ result })
    .eq("id", data!.id).eq("owner_id", reviewer.id);
  expect(update.error).toBeNull();
  await page.reload();
  await page.getByRole("button", { name: "Resolve OCR conflicts" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("img", { name: /page 1 of unseen-review-policy.pdf/i })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Recalculate commission" })).toBeDisabled();
  await expect(dialog.getByText("1086", { exact: true })).toBeVisible();
  await expect(dialog.getByRole("heading", { name: "Reading 1" })).toBeVisible();
  await expect(dialog.getByRole("heading", { name: "Reading 2" })).toBeVisible();
  await dialog.getByRole("button", { name: "Use reading 2" }).click();
  await expect(dialog.getByRole("textbox", { name: "Value from the policy" })).toHaveValue("998");
  await dialog.getByRole("button", { name: "Confirm value" }).click();
  await expect(dialog.getByRole("button", { name: "Recalculate commission" })).toBeEnabled();
  await dialog.getByRole("button", { name: "Recalculate commission" }).click();
  await expect(page.getByText("Review saved. Commission recalculated.")).toBeVisible();
  await expect(page.getByRole("region", { name: "Broker commission" })).toContainText(/15(?:\.0)?%/);

  await page.reload();
  await page.getByRole("tab", { name: /Policy facts/ }).click();
  const facts = page.getByRole("tabpanel", { name: /Policy facts/ });
  await expect(facts.getByText("998", { exact: true })).toBeVisible();
  await expect(facts.getByText("Reviewer confirmed on Policy page 1", { exact: true })).toBeVisible();
  expect((await page.request.get(pdfUrl)).status()).toBe(410);
  await expect.poll(async () => {
    const { data, error } = await reviewer.db.from("argus_runs").select("pdf_deleted_at").eq("owner_id", reviewer.id).single();
    if (error) throw error;
    return data.pdf_deleted_at;
  }).not.toBeNull();
});

test("guided review accepts the business-type alternative without requiring an absent previous insurer", async ({ page, reviewer }) => {
  const name = "synthetic-reliance-rollover.pdf";
  await page.goto("/sign-in");
  await signIn(page, reviewer);
  await uploadPdf(page, name, syntheticPdf("Business Type: Rollover", "Private car package policy - synthetic review fixture"));
  const saved = await reviewer.db.from("argus_runs").select("id,result").eq("owner_id", reviewer.id).single();
  expect(saved.error).toBeNull();
  const result = applyRating({ ...saved.data!.result, reader_failures: {}, fields: Object.fromEntries(Object.entries({
    insurer: "Reliance", policy_type: "Private Car Package Policy", rto: "UP16", make: "Renault", model: "Kwid",
    fuel: "petrol", engine_cc: "999", start_date: "2026-01-15", standalone_zd: "no", tyre_rti_bundle: "no", extended_warranty: "no",
  }).map(([field, value]) => [field, { value, status: "accepted", reason: "independent_agreement", evidence: [] }])) });
  expect(result.review_fields).toEqual(["previous_insurer", "business_type"]);
  expect((await reviewer.db.from("argus_runs").update({ result }).eq("id", saved.data!.id)).error).toBeNull();
  await page.reload();
  await page.getByRole("button", { name: "Verify policy details", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Field to review").selectOption("business_type");
  await dialog.getByRole("textbox", { name: "Value from the policy" }).fill("Rollover");
  await dialog.getByRole("button", { name: "Confirm value" }).click();
  await expect(dialog.getByRole("button", { name: "Recalculate commission" })).toBeEnabled();
  await dialog.getByRole("button", { name: "Recalculate commission" }).click();
  await expect(page.getByText("Review saved. Commission recalculated.")).toBeVisible();
  await expect(page.getByRole("region", { name: "Broker commission" })).toContainText(/17\.5%/);
});

test("profile saves real settings and protects profile data, runs and audit history", async ({ page, reviewer, browser }) => {
  await page.goto("/sign-in");
  await signIn(page, reviewer);
  const pill = page.getByRole("link", { name: "Open profile" });
  await pill.click();
  await expect(page.getByRole("heading", { name: "Account", exact: true })).toBeVisible();
  await expect(pill).toHaveAttribute("aria-current", "location");
  const name = page.getByRole("textbox", { name: "Display name" });
  const save = page.getByRole("button", { name: "Save changes" });
  await expect(save).toBeDisabled();
  await name.fill("Argus Reviewer");
  await page.getByRole("textbox", { name: "Organization" }).fill("Example Brokerage");
  await page.getByRole("combobox", { name: "Time zone" }).fill("Asia/Kolkata");
  await save.click();
  await expect(page.getByRole("status").getByText("Personal details saved.")).toBeVisible();
  await page.reload();
  await expect(name).toHaveValue("Argus Reviewer");
  const avatar = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lE8AAAAASUVORK5CYII=", "base64");
  await page.locator('input[type="file"][accept="image/png,image/jpeg"]').setInputFiles({
    name: "test-photo.png", mimeType: "image/png", buffer: avatar,
  });
  await page.getByRole("button", { name: "Save photo" }).click();
  await expect(page.getByRole("status").getByText("Profile photo saved.")).toBeVisible();
  await page.reload();
  const storedPhoto = await page.request.get("/api/profile/avatar");
  expect(storedPhoto.status()).toBe(200);
  expect(storedPhoto.headers()["cache-control"]).toBe("private, no-store");
  expect(await storedPhoto.body()).toEqual(avatar);
  await expect(name).toHaveValue("Argus Reviewer");
  await page.setViewportSize({ width: 390, height: 844 });
  const content = await page.locator(".profile-content").boundingBox();
  const mobileNav = await page.getByRole("navigation", { name: "Settings" }).boundingBox();
  expect(content?.width).toBeGreaterThanOrEqual(350);
  expect(mobileNav!.y + mobileNav!.height).toBeLessThan(content!.y);
  await page.setViewportSize({ width: 1280, height: 900 });
  await name.fill("Unsaved edit");
  const warning = page.waitForEvent("dialog").then(async dialog => {
    expect(dialog.type()).toBe("beforeunload");
    await dialog.dismiss();
  });
  await page.getByRole("link", { name: "Preferences", exact: true }).click();
  await warning;
  await expect(name).toHaveValue("Unsaved edit");
  await name.fill("Argus Reviewer");

  const origin = new URL(page.url()).origin;
  const key = process.env.ARGUS_TEST_SUPABASE_PUBLISHABLE_KEY;
  const url = process.env.ARGUS_TEST_SUPABASE_URL!;
  const outsiderEmail = `other-${randomUUID()}@example.test`;
  const password = randomUUID();
  const outsider = await reviewer.db.auth.admin.createUser({ email: outsiderEmail, password, email_confirm: true });
  expect(outsider.error).toBeNull();
  const secondary = await browser.newContext({ baseURL: origin });
  try {
    // The disposable app records approval and runs with OCR providers disabled.
    const upload = await page.request.post("/api/runs", { headers: { Origin: origin }, multipart: {
      allowCloud: "true", pdf: { name: "approved-test.pdf", mimeType: "application/pdf", buffer: syntheticPdf("Synthetic policy") },
    } });
    expect(upload.status()).toBe(201);
    const { run } = await upload.json();
    await page.goto(`/workspace#${run.id}`);
    await expect(page.getByRole("heading", { name: "approved-test.pdf", exact: true })).toBeVisible();
    await pill.click();
    await expect(page.getByRole("link", { name: "Back to workspace" })).toHaveAttribute("href", `/workspace#${run.id}`);
    const second = await secondary.newPage();
    await second.goto("/sign-in");
    await signIn(second, { email: outsiderEmail, password, id: outsider.data.user!.id, db: reviewer.db });
    expect((await second.request.get(`/api/runs/${run.id}`)).status()).toBe(404);
    expect((await second.request.get("/api/profile/avatar")).status()).toBe(404);
    expect((await second.request.get(`/api/profile?owner_id=${reviewer.id}`).then(response => response.json())).personal.display_name).toBe("");
    const secondActivity = await second.request.get(`/api/profile?view=activity&owner_id=${reviewer.id}`).then(response => response.json());
    expect(secondActivity.activity.events.map((e: { action: string }) => e.action)).toEqual(["signed_in"]);
    if (key) {
      const userClient = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
      expect((await userClient.auth.signInWithPassword({ email: outsiderEmail, password })).error).toBeNull();
      expect((await userClient.from("argus_profiles").select("*").eq("owner_id", reviewer.id)).data).toEqual([]);
      expect((await userClient.from("argus_audit_events").select("*").eq("owner_id", reviewer.id)).data).toEqual([]);
      expect((await userClient.from("argus_runs").select("*").eq("id", run.id)).data).toEqual([]);
      expect((await userClient.from("argus_profiles").update({ display_name: "Changed" }).eq("owner_id", reviewer.id)).error).not.toBeNull();
    }
    await page.getByRole("button", { name: "Remove", exact: true }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Remove photo" }).click();
    await expect(page.getByRole("status").getByText("Profile photo removed.")).toBeVisible();
    expect((await page.request.get("/api/profile/avatar")).status()).toBe(404);
    await page.getByRole("link", { name: "Preferences", exact: true }).click();
    await page.getByRole("combobox", { name: "Density", exact: true }).selectOption("compact");
    await page.getByRole("button", { name: "Save changes" }).click();
    await expect(page.locator(".app-frame")).toHaveAttribute("data-density", "compact");
    await page.getByRole("link", { name: "Security", exact: true }).click();
    await expect(page.getByText("This device", { exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Change password" })).toBeVisible();
    await page.getByRole("link", { name: "Activity", exact: true }).click();
    await expect(page.getByRole("table", { name: "Audit log" }).getByText("Approved external OCR")).toBeVisible();
    await expect(page.getByRole("table", { name: "Audit log" }).getByRole("cell", { name: "Signed in", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Export CSV" }).click();
    await expect(page.getByRole("link", { name: "Download CSV" })).toBeVisible();
    await page.getByRole("link", { name: "Data & privacy", exact: true }).click();
    await page.getByRole("button", { name: "Prepare ZIP" }).click();
    await expect(page.getByRole("link", { name: "Download ZIP" })).toBeVisible();
    await page.getByRole("button", { name: "Delete all saved runs" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByRole("button", { name: "Cancel" })).toBeFocused();
    await expect(dialog.getByRole("button", { name: "Delete all saved runs" })).toBeDisabled();
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await page.getByRole("button", { name: "Delete all saved runs" }).click();
    await dialog.getByRole("textbox", { name: "Type DELETE to confirm" }).fill("DELETE");
    await dialog.getByRole("button", { name: "Delete all saved runs" }).click();
    await expect(page.getByText("Saved runs deleted.", { exact: true })).toBeVisible();
    expect((await page.request.get(`/api/runs/${run.id}`)).status()).toBe(404);
    const updated = randomUUID();
    const changePassword = (current: string) => page.request.patch("/api/profile", {
      headers: { Origin: origin }, data: { part: "password", current, password: updated, confirm: updated },
    });
    expect((await changePassword("incorrect")).status()).toBe(422);
    expect((await changePassword(reviewer.password)).status()).toBe(200);
    await page.getByRole("button", { name: "Delete account", exact: true }).click();
    await dialog.getByRole("textbox", { name: "Type DELETE to confirm" }).fill("DELETE");
    await dialog.getByRole("button", { name: "Permanently delete account" }).click();
    await expect(page.getByRole("status").getByText("Your Argus account and its data were deleted.")).toBeVisible();
    await expect(page.getByRole("heading", { name: "Sign in to Argus" })).toBeVisible();
  } finally {
    await secondary.close();
    const { error } = await reviewer.db.auth.admin.deleteUser(outsider.data.user!.id);
    expect(error).toBeNull();
  }
});

test("unavailable readers leave a completed run's OCR retry available", async ({ page, reviewer }) => {
  const filename = "unseen-ocr-retry.pdf";
  const pdf = syntheticPdf("Vehicle class: Private car");
  const store = runStore(reviewer.db, reviewer.id);
  const uploaded = await store.upload({ filename, bytes: pdf, digest: checksum(pdf), allowCloud: true }, randomUUID(), 1, "miss");
  const confirmation = { field: "vehicle_class", value: "private car", raw: "Private car", file: filename,
    page: 1, type: "reviewer_confirmation" } as const;
  const result = applyRating({ filename, checksum: uploaded.checksum, extraction_version: EXTRACTION_VERSION,
    reader_failures: { 1: { sarvam: "provider_timeout" } }, clarifications: [confirmation], fields: {
      vehicle_class: { status: "confirmed_by_reviewer", value: confirmation.value, reason: "insufficient_agreement",
        evidence: [], confirmation },
    } });
  expect((await reviewer.db.from("argus_runs").update({ status: "complete", revision: 2, result })
    .eq("id", uploaded.id)).error).toBeNull();

  await page.goto("/sign-in");
  await signIn(page, reviewer);
  const health = await page.request.get("/api/runs");
  expect(health.ok()).toBe(true);
  expect((await health.json()).ocr.live, "Live OCR must be disabled for this test").not.toBe("ready");
  const path = `/api/runs/${uploaded.id}`;
  const saved = async () => {
    const response = await page.request.get(path);
    expect(response.ok()).toBe(true);
    return (await response.json()).run;
  };
  const headers = { Origin: new URL(page.url()).origin };
  await page.getByRole("list", { name: "Saved policy runs" }).getByRole("button", { name: /unseen-ocr-retry\.pdf/ }).click();
  await expect(page).toHaveURL(new RegExp(`#${uploaded.id}$`));
  await expect(page.getByRole("heading", { name: filename, exact: true })).toBeVisible();
  const retry = page.getByRole("button", { name: "Retry OCR from saved PDF" });
  await expect(retry).toBeVisible();
  const before = await saved();
  const resume = await page.request.post(path, { headers });
  expect(resume.status()).toBe(200);
  expect((await resume.json()).run.revision).toBe(before.revision);
  expect((await page.request.post(path, { headers, data: "retry" })).status()).toBe(415);

  const response = page.waitForResponse(response => response.url().endsWith(path) && response.request().method() === "POST");
  await retry.click();
  const started = await response;
  expect(started.status()).toBe(503);
  expect(started.request().postDataJSON()).toEqual({ retryOcr: true, revision: before.revision });
  await expect(page.getByRole("alert").filter({ hasText: "OCR readers are unavailable. Try the saved PDF again later." })).toBeVisible();
  expect(await saved()).toMatchObject({ status: "complete", can_retry_ocr: true,
    revision: before.revision, result: { clarifications: [confirmation] } });
  const audit = await reviewer.db.from("argus_audit_events").select("action").match({ owner_id: reviewer.id, action: "analyzed" });
  expect(audit.error).toBeNull();
  expect(audit.data).toEqual([]);
  await page.reload();
  await expect(page.getByRole("heading", { name: "Broker commission" })).toBeVisible();
  await expect(retry).toBeVisible();
  const original = await page.request.get(`${path}/pdf`);
  expect(original.ok()).toBe(true);
  expect(await original.body()).toEqual(pdf);
});
