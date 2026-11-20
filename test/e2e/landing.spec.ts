import { expect, test } from "@playwright/test";

test("worked examples have keyboard tabs and open read-only decisions", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");
  await page.keyboard.press("Tab");
  await expect(page.getByRole("link", { name: "Skip to main content" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.locator("main")).toBeFocused();

  const examples = page.getByRole("tablist", { name: "Challenge policies" });
  await examples.getByRole("tab", { name: "Go Digit" }).focus();
  await page.keyboard.press("ArrowRight");
  await expect(examples.getByRole("tab", { name: "HDFC ERGO" })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("tabpanel")).toContainText("Needs review");
  await page.getByRole("link", { name: "Open decision trace" }).click();
  await expect(page).toHaveURL(/\/example\/hdfc-ergo$/);
  await expect(page.getByRole("heading", { name: "HDFC ERGO · Comprehensive" })).toBeVisible();
  await expect(page.getByText("Read-only example.")).toBeVisible();
  await expect(page.getByRole("tabpanel", { name: "Decision trace" })
    .getByRole("button", { name: /Slab footnote immediately below Zone 2/ })).toBeVisible();
  await expect(page.getByRole("link", { name: "Open original PDF" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /export|retry|verify policy/i })).toHaveCount(0);
});

test("a mobile reviewer can open and dismiss the navigation sheet", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  const menu = page.getByRole("button", { name: "Open menu" });
  await menu.click();
  await expect(page.getByRole("dialog", { name: "Menu" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(menu).toBeFocused();
  await menu.click();
  await page.getByRole("dialog").getByRole("link", { name: "Evidence", exact: true }).click();
  await expect(page).toHaveURL(/#evidence$/);
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

test("the final logo and grid scan pause together and respect reduced motion", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.goto("/");
  const section = page.getByRole("region", { name: "See where your next rate comes from." });
  const cell = section.locator(".final-cell");
  const logo = section.locator(".final-mark");
  const animationState = (element: Element) => element.getAnimations({ subtree: true }).map(animation => animation.playState);

  await section.scrollIntoViewIfNeeded();
  await expect.poll(() => cell.evaluate(animationState)).toContain("running");
  await expect.poll(() => logo.evaluate(animationState)).toContain("running");
  const pause = section.getByRole("button", { name: "Pause logo and grid animation" });
  await pause.press("Enter");
  expect(await cell.evaluate(animationState)).not.toContain("running");
  expect(await logo.evaluate(animationState)).not.toContain("running");
  await section.getByRole("button", { name: "Play logo and grid animation" }).press("Enter");
  await expect.poll(() => cell.evaluate(animationState)).toContain("running");

  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect(pause).toBeHidden();
  expect(await cell.evaluate(animationState)).toEqual([]);
  expect(await logo.evaluate(animationState)).toEqual([]);
});

test("the first worked example counts up like selecting Go Digit again", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  let releaseScripts!: () => void;
  const scripts = new Promise<void>(resolve => { releaseScripts = resolve; });
  await page.route(/\/_next\/static\/.*\.js(?:\?|$)/, async route => {
    await scripts;
    await route.continue();
  });
  await page.goto("/", { waitUntil: "commit" });
  const example = page.getByRole("region", { name: /Worked example/ });
  const panel = example.getByRole("tabpanel");
  const headline = page.locator("#entry-title");
  const count = panel.locator(".hero-rate-count");
  const scanName = () => panel.locator(".hero-policy")
    .evaluate(element => getComputedStyle(element, "::after").animationName);

  try {
    await expect(headline).toBeVisible();
    await expect(panel.locator(".hero-rate-preparing")).toBeVisible();
    await expect(panel.locator(".hero-rate-number")).toBeHidden();
  } finally {
    releaseScripts();
  }

  await expect.poll(scanName).toBe("policy-scan");
  await expect.poll(() => example.evaluate(element => getComputedStyle(element, "::before").animationName)).toBe("hero-frame-seat");
  await expect(count).toBeVisible();
  await expect(count).not.toHaveText("29.5");
  await expect(count).toHaveText("29.5");

  await example.getByRole("tab", { name: "HDFC ERGO" }).click();
  await example.getByRole("tab", { name: "Go Digit" }).click();
  await expect.poll(scanName).toBe("policy-scan");
  await expect(count).not.toHaveText("29.5");
  await expect(count).toHaveText("29.5");

  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect.poll(scanName).toBe("none");
  await expect(panel.locator(".hero-rate-static")).toBeVisible();
});
