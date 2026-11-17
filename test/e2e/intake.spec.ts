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
    await page.route("**/api/cache/check?*", route => route.fulfill({ json: { cache: "miss", pagesTotal: null, pagesCached: 0 } }));
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
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
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


const complete = { ...saved, analysis_mode: "instant", duration_ms: 150, result: {
  status: "resolved",
  confidence: { level: "high", reason: "The rate card matches." },
  fields: {},
  od: { rate: null, applicable: false, reason: "Third party only." },
  tp: { rate: 29.5, applicable: true, status: "resolved", reason: "Rate card match." },
  trace: [{ step: "Rate card match.", sources: [{ file: "Rate card.xlsx", sheet: "TP", cells: "B12" }] }],
} };

function running(pagesDone: number, cachedPages: number[] = []) {
  const now = new Date().toISOString();
  return { ...saved, status: "processing", decision: null, revision: 1, analysis_mode: "live",
    lease_until: "2099-01-01T00:00:00Z", progress: {
      stage: "reading", status: "processing", pagesDone, pagesTotal: 15,
      page: cachedPages.length ? 6 : pagesDone + 1, completedPages: Array.from({ length: pagesDone }, (_, i) => i + 1),
      cachedPages, startedAt: now, stageStartedAt: now, updatedAt: now,
    } };
}

const files = { name: "policy.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-test") };
const empty = { runs: [], ocr: { live: "ready", cache: false } };

for (const cache of ["miss", "partial"] as const) {
  test(`Reading Eye reports persisted ${cache} progress, reattaches and reveals the result`, async ({ page }) => {
    let next: object = cache === "partial" ? running(9, [1,2,3,4,5,12,13,14,15]) : running(0);
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.route("**/api/session", route => route.fulfill({ json: { email: "reviewer@example.test" } }));
    await page.route("**/api/cache/check?*", route => route.fulfill({ json: {
      cache, pagesTotal: 15, pagesCached: cache === "partial" ? 9 : 0,
    } }));
    await page.route("**/api/runs", route => {
      if (route.request().method() === "POST") {
        expect(route.request().postData()).toContain('name="allowCloud"');
        return route.fulfill({ json: { runId: id, mode: "live", cache, pagesToOcr: cache === "partial" ? 6 : 15, run: next } });
      }
      return route.fulfill({ json: empty });
    });
    await page.route(`**/api/runs/${id}`, route => route.fulfill({ json: { run: next } }));
    await page.goto("/workspace");
    await page.locator('input[type="file"]').setInputFiles(files);
    await page.getByRole("checkbox").check();
    await page.getByRole("button", { name: "Analyze policy", exact: true }).click();
    const meter = page.getByRole("progressbar", { name: "Policy analysis" });
    const iris = page.locator(".reading-eye");
    await expect(iris).toHaveCSS("width", "144px");
    await expect(iris.locator(".eye-pixels i")).toHaveCount(45);
    await expect(iris.locator(".eye-pixels i").first()).toHaveCSS("animation-name", "none");
    if (cache === "partial") {
      await expect(meter).toHaveAttribute("aria-valuenow", "44");
      await expect(meter).toHaveAttribute("aria-valuetext", "Reading page 6 of 15 (9 already analyzed)");
      await expect(page.locator('.eye-page[data-state="cached"]')).toHaveCount(9);
    } else {
      await expect(meter).toHaveAttribute("aria-valuetext", "Reading page 1 of 15");
      next = running(5);
      await expect(meter).toHaveAttribute("aria-valuetext", "Reading page 6 of 15");
    }
    await page.getByRole("button", { name: "New analysis", exact: true }).click();
    await expect(iris).toHaveCount(0);
    await page.getByRole("button", { name: /Analyzing [59]\/15/ }).click();
    await expect(iris).toBeVisible();
    const cancel = page.getByRole("button", { name: "Cancel analysis" });
    await cancel.focus();
    await expect(cancel).toBeFocused();
    next = { ...complete, analysis_mode: "live" };
    await expect(page.getByRole("heading", { name: "Broker commission" })).toBeVisible();
    await expect(iris).toHaveCount(0);
    await expect(page.getByRole("heading", { name: files.name })).toBeFocused();
    await expect(page.locator(".cited-cell")).toHaveText("TP!B12");
  });
}

test("verified file hit hides consent and skips the stage and analyzing row", async ({ page }) => {
  await page.route("**/api/session", route => route.fulfill({ json: { email: "reviewer@example.test" } }));
  await page.route("**/api/cache/check?*", route => {
    expect(new URL(route.request().url()).search).toMatch(/^\?hash=[0-9a-f]{64}$/);
    return route.fulfill({ json: { cache: "hit", pagesTotal: 15, pagesCached: 15 } });
  });
  await page.route("**/api/runs", route => {
    if (route.request().method() === "POST") {
      expect(route.request().postData()).not.toContain("allowCloud");
      return route.fulfill({ json: { runId: id, mode: "instant", cache: "hit", pagesToOcr: 0, run: complete } });
    }
    return route.fulfill({ json: empty });
  });
  await page.route(`**/api/runs/${id}`, route => route.fulfill({ json: { run: complete } }));
  await page.goto("/workspace");
  await page.locator('input[type="file"]').setInputFiles(files);
  await expect(page.getByText("Analyzed before. Result is instant, no external OCR needed.")).toBeVisible();
  await expect(page.getByRole("checkbox")).toHaveCount(0);
  await page.evaluate(() => new MutationObserver(() => {
    if (document.querySelector(".reading-stage, .history-row .state.processing")) document.body.dataset.flashed = "true";
  }).observe(document.body, { subtree: true, childList: true }));
  await page.getByRole("button", { name: "Analyze policy", exact: true }).click();
  await expect(page.getByText("From saved analysis")).toBeVisible();
  await expect(page.getByRole("heading", { name: files.name })).toBeFocused();
  await expect(page.locator("body")).not.toHaveAttribute("data-flashed", "true");
});

test("a stalled run can be cancelled and retried from the original", async ({ page }) => {
  let next = running(5);
  next.progress.updatedAt = new Date(Date.now() - 95_000).toISOString();
  let cancelRequests = 0;
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.route("**/api/session", route => route.fulfill({ json: { email: "reviewer@example.test" } }));
  await page.route("**/api/runs", route => route.fulfill({ json: { ...empty, runs: [next] } }));
  await page.route(`**/api/runs/${id}`, route => {
    if (route.request().method() === "POST") next = { ...running(0), revision: 3 };
    return route.fulfill({ json: { run: next } });
  });
  await page.route(`**/api/runs/${id}/cancel`, route => {
    cancelRequests++;
    next = { ...next, status: "cancelled", revision: 2,
      progress: { ...next.progress, stage: "cancelled", status: "cancelled" } };
    return route.fulfill({ json: { run: next } });
  });
  await page.goto(`/workspace#${id}`);
  await expect(page.getByText("Still working on page 6. Scanned pages take longer.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Retry", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "Cancel analysis", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Analysis cancelled" })).toBeVisible();
  await expect(page.getByRole("button", { name: "View run details" })).toBeVisible();
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(page.getByRole("progressbar")).toHaveAttribute("aria-valuetext", "Reading page 1 of 15");
  expect(cancelRequests).toBe(1);
});
