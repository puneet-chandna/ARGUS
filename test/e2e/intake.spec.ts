import { expect, test } from "@playwright/test";

const id = "00000000-0000-4000-8000-000000000001";
const saved = {
  id, filename: "policy.pdf", status: "complete", decision: "resolved",
  created_at: "2026-11-16T16:12:00Z", revision: 2,
};

test.use({ timezoneId: "UTC" });

for (const width of [1440, 390]) {
  test(`intake requires consent and exposes saved run details at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    await page.route("**/api/session", route => route.fulfill({ json: { email: "reviewer@example.test" } }));
    const review = { ...saved, id: id.replace(/1$/, "2"), decision: "ambiguous" };
    const unsupported = { ...saved, id: id.replace(/1$/, "3"), decision: "unsupported" };
    await page.route("**/api/runs", route => route.fulfill({ json: {
      runs: [saved, review, unsupported], ocr: { live: "ready", cache: true },
    } }));
    await page.route(`**/api/runs/*`, route => {
      const item = [saved, review, unsupported].find(run => route.request().url().endsWith(run.id));
      return route.fulfill({ json: { run: {
        ...item, result: {
          status: item?.decision, fields: item === saved ? {
            insurer: { value: "Go Digit", status: "accepted" },
            model: { value: "Swift", status: "accepted" },
          } : {}, od: { rate: null }, tp: { rate: item === saved ? 29.5 : null },
        },
      } } });
    });
    await page.goto("/workspace");

    const analyze = page.getByRole("button", { name: "Analyze policy" });
    const consent = page.getByRole("checkbox");
    const file = page.locator('input[type="file"]');
    const choose = page.getByRole("button", { name: "Choose PDF" });
    await expect(analyze).toBeDisabled();
    await choose.focus();
    const chooser = page.waitForEvent("filechooser");
    await page.keyboard.press("Enter");
    await chooser;
    await page.keyboard.press("Tab");
    await expect(consent).toBeFocused();
    await expect(consent).toHaveCSS("outline-style", "solid");
    await expect(consent).toHaveCSS("outline-width", "2px");
    await file.setInputFiles({ name: "invalid.txt", mimeType: "text/plain", buffer: Buffer.from("test") });
    await expect(page.locator(".file-control").getByRole("alert")).toHaveText("Choose a nonempty PDF up to 20 MiB.");
    await consent.check();
    await expect(analyze).toBeDisabled();
    await consent.uncheck();
    await file.setInputFiles({ name: "example.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-test") });
    await expect(analyze).toBeDisabled();
    await consent.check();
    await expect(analyze).toBeEnabled();
    await expect(page.locator(".workspace .button.primary")).toHaveCount(1);
    await expect(analyze).toHaveCSS("background-color", "rgb(15, 92, 110)");
    expect(await page.evaluate(() => [...document.querySelectorAll(".app-frame *")].filter(el =>
      el.getClientRects().length && [...el.childNodes].some(n => n.nodeType === Node.TEXT_NODE && n.textContent?.trim()))
      .map(el => parseFloat(getComputedStyle(el).fontSize)).every(size => size >= 12))).toBe(true);
    await page.getByRole("button", { name: "Remove", exact: true }).click();
    await expect(analyze).toBeDisabled();
    await expect(analyze).toHaveCSS("background-color", "rgb(232, 227, 211)");
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
    await expect(page.locator(".file-control")).toHaveCSS("min-height", width === 390 ? "180px" : "240px");
    if (width === 1440) await expect(page.getByRole("button", { name: /Go Digit.*Swift.*29\.5%/ })).toBeVisible();
    if (process.env.ARGUS_CAPTURE_UI) {
      await page.mouse.move(0, 0);
      await page.screenshot({ animations: "disabled", path: testInfo.outputPath("new-analysis.png") });
    }

    const drawer = page.getByRole("button", { name: "Saved runs", exact: true });
    if (width === 390) await drawer.click();
    await expect(page.getByRole("button", { name: /Go Digit.*Swift.*29\.5%/ })).toContainText("16 Nov, 16:12");
    await expect(page.getByRole("button", { name: "Run actions" })).toHaveCount(3);
    await expect(page.getByRole("button", { name: /Commission undetermined/ })).toBeVisible();
    await expect(page.getByRole("button", { name: /Outside rate card coverage/ })).toBeVisible();
    if (width === 390) {
      if (process.env.ARGUS_CAPTURE_UI) await page.screenshot({ animations: "disabled", path: testInfo.outputPath("saved-runs.png") });
      await page.keyboard.press("Escape");
      await expect(drawer).toBeFocused();
    }
  });
}

test("the upload iris stays in the dropzone until the result arrives", async ({ page }) => {
  const queued = { ...saved, status: "queued", decision: null, revision: 1 };
  const complete = { ...saved, result: {
    status: "resolved",
    confidence: { level: "high", reason: "The rate card matches." },
    fields: {},
    od: { rate: null, applicable: false, reason: "Third party only." },
    tp: { rate: 29.5, applicable: true, status: "resolved", reason: "Rate card match." },
    trace: [{ step: "Rate card match.", sources: [{ file: "Rate card.xlsx", sheet: "TP", cells: "B12" }] }],
  } };
  let started = false;
  let finish = false;
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.route("**/api/session", route => route.fulfill({ json: { email: "reviewer@example.test" } }));
  await page.route("**/api/runs", route => {
    if (route.request().method() === "POST") {
      expect(route.request().postData()).toContain('name="allowCloud"');
      return route.fulfill({ json: { run: queued } });
    }
    return route.fulfill({ json: { runs: [], ocr: { live: "ready", cache: false } } });
  });
  await page.route(`**/api/runs/${id}`, route => {
    if (route.request().method() === "POST") started = true;
    const processing = { ...queued, status: "processing", lease_until: "2099-01-01T00:00:00Z" };
    return route.fulfill({ json: { run: finish ? complete : started ? processing : queued } });
  });
  await page.goto("/workspace");
  await page.locator('input[type="file"]').setInputFiles({
    name: saved.filename, mimeType: "application/pdf", buffer: Buffer.from("%PDF-test"),
  });
  await page.getByRole("checkbox").check();
  await page.getByRole("button", { name: "Analyze policy", exact: true }).click();
  const iris = page.locator(".file-control img");
  await expect(iris).toHaveAttribute("src", /argus-logo-4-pixel-iris-animated/);
  await expect(iris).toHaveCSS("width", "96px");
  await expect(page.getByRole("button", { name: "Analyzing policy…" })).toBeDisabled();
  await expect(page.getByRole("checkbox")).toBeDisabled();
  await expect.poll(() => started).toBe(true);
  finish = true;
  await expect(page.getByRole("heading", { name: "Broker commission" })).toBeVisible({ timeout: 10_000 });
  await expect(iris).toHaveCount(0);
  await expect(page.getByText("TP!B12")).toHaveCSS("background-color", "rgb(248, 233, 209)");
});
