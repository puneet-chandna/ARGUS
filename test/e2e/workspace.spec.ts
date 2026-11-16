import { expect, test as base, type Page } from "@playwright/test";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { EXTRACTION_VERSION } from "../../lib/ingestion/providers.ts";
import { decide, type PageRead } from "../../lib/ingestion/facts.ts";
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
      if (account.error) throw account.error;
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
  await page.getByRole("button", { name: "Analyze policy" }).click();
  await expect(page.getByRole("heading", { name, exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Broker commission" })).toBeVisible({ timeout: 15_000 });
}

test("an uploaded policy keeps its conditional rate, exact citations and private PDF after reauthentication", async ({ page, reviewer }) => {
  const name = "pvt-car-satp-tata-aig.pdf";
  const pdf = await readFile(new URL(`../../vaatun-starter-bundle/sample-policies/${name}`, import.meta.url));
  const fixture = JSON.parse(await readFile(new URL("../../submission/pvt-car-satp-tata-aig.json", import.meta.url), "utf8"));
  // Reuse the source-reviewed extraction so the browser exercises the real app without paid OCR.
  const seeded = await reviewer.db.from("argus_ocr_cache").insert({
    owner_id: reviewer.id, checksum: checksum(pdf), profile: verifiedOcrProfile(), grounded_text: [],
    extraction: {
      filename: name, checksum: checksum(pdf), extraction_version: EXTRACTION_VERSION,
      reader_failures: {}, clarifications: [], fields: {
        ...fixture.fields,
        vehicle_class: {
          value: "hatch back", status: "accepted", reason: "independent_agreement",
          evidence: [{ file: name, page: 4, raw: "Hatch Back" }],
        },
      },
    },
  });
  expect(seeded.error).toBeNull();

  await page.goto("/sign-in");
  await signIn(page, reviewer);
  await uploadPdf(page, name, pdf);
  const commission = page.getByRole("region", { name: "Broker commission" });
  await expect(commission).toContainText("Confirm whether the policy is for a private car");
  await page.getByRole("button", { name: "Vehicle class", exact: true }).click();
  const review = page.getByRole("dialog");
  await review.getByRole("textbox", { name: "Value from the policy" }).fill("Private car");
  await review.getByRole("button", { name: "Confirm value" }).click();
  await review.getByRole("button", { name: "Recalculate commission" }).click();
  await expect(page.getByText("Review saved. Commission recalculated.")).toBeVisible();
  await expect(commission).toContainText("Inapplicable");
  await expect(commission).toContainText("Unsupported");
  await expect(commission).toContainText("does not confirm which payout cluster");
  await expect(commission).not.toContainText("38%");
  await page.getByRole("button", { name: "View decision evidence" }).click();
  const trace = page.getByRole("tabpanel", { name: "Decision trace" });
  await expect(trace.getByText(/if .*DELHI payout cluster.*38%/i)).toBeInViewport();
  await expect(trace.getByText("Pvtcar!V511, V515, V519, V523, V527, V531, V535")).toBeVisible();
  await expect(trace.getByText("General Guidelines!C10").first()).toBeVisible();
  await expect(trace.getByRole("link", { name: /page 4, in a new tab/ }).first()).toHaveAttribute("href", /\/pdf#page=4$/);
  const pdfUrl = await page.getByRole("link", { name: "Open original PDF in a new tab" }).getAttribute("href");
  expect(pdfUrl).toMatch(/^\/api\/runs\/.+\/pdf$/);

  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page.getByRole("heading", { name: "Sign in to Argus" })).toBeVisible();
  expect((await page.request.get(pdfUrl!)).status()).toBe(401);
  await signIn(page, reviewer);
  await page.getByRole("button", { name: new RegExp(`^${name} Unsupported`) }).click();
  await page.reload();
  await expect(commission).toContainText("Unsupported");
  const original = await page.request.get(pdfUrl!);
  expect(original.status()).toBe(200);
  expect(checksum(await original.body())).toBe(checksum(pdf));
});

test("the reviewer resolves an unseen policy conflict from the PDF and keeps the cited choice", async ({ page, reviewer }) => {
  const name = "unseen-review-policy.pdf";
  await page.goto("/sign-in");
  await signIn(page, reviewer);
  await uploadPdf(page, name, syntheticPdf("Engine capacity: 998 cc"));
  await expect(page.getByRole("region", { name: "Broker commission" })).toContainText("Undetermined");

  // Inject the two OCR responses at the persisted analysis boundary; the review and storage routes stay real.
  const sources: PageRead[] = [
    { reader: "sarvam", model: "fixture-1", page: 1, transcript: "Engine capacity: 998 cc",
      candidates: [{ field: "engine_cc", value: "998", quote: "Engine capacity: 998 cc", box: [0.08, 0.2, 0.5, 0.4] }] },
    { reader: "nvidia-super-vl", model: "fixture-2", page: 1, transcript: "Engine capacity: 1086 cc",
      candidates: [{ field: "engine_cc", value: "1086", quote: "Engine capacity: 1086 cc", box: [0.08, 0.2, 0.5, 0.4] }] },
  ];
  const { data, error } = await reviewer.db.from("argus_runs").select("id,result").eq("owner_id", reviewer.id).single();
  expect(error).toBeNull();
  const update = await reviewer.db.from("argus_runs")
    .update({ result: { ...data!.result, fields: decide(name, sources), reader_failures: {} } })
    .eq("id", data!.id).eq("owner_id", reviewer.id);
  expect(update.error).toBeNull();
  await page.reload();
  await page.getByRole("button", { name: "Resolve OCR conflicts" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("img", { name: /page 1 of unseen-review-policy.pdf/i })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Recalculate commission" })).toBeDisabled();
  await expect(dialog.getByText("1086", { exact: true })).toBeVisible();
  await dialog.getByRole("button", { name: "Enter a custom value" }).click();
  await dialog.getByRole("textbox", { name: "Value from the policy" }).fill("998");
  await dialog.getByRole("button", { name: "Confirm value" }).click();
  await dialog.getByRole("button", { name: "Recalculate commission" }).click();
  await expect(page.getByText("Review saved. Commission recalculated.")).toBeVisible();

  await page.reload();
  await page.getByRole("tab", { name: /Policy facts/ }).click();
  const facts = page.getByRole("tabpanel", { name: /Policy facts/ });
  await expect(facts.getByText("998", { exact: true })).toBeVisible();
  await expect(facts.getByText("Reviewer confirmed on")).toContainText("Policy page 1");
});
