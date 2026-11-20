import { expect } from "@playwright/test";
import { test } from "./coverage";

test("public entry keeps signup confirmation and failed sign-in recoverable without sending email", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Motor brokerage you can trace." })).toBeVisible();
  await page.getByRole("link", { name: "See a worked example" }).click();
  await expect(page.locator("#worked-example")).toContainText("29.5");
  await page.getByRole("link", { name: "Sign in to Argus", exact: true }).click();
  await page.getByRole("button", { name: "Create an account", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Create a reviewer account" })).toBeVisible();
  await page.getByLabel("Email address").fill("reviewer@example.test");
  await page.getByLabel("Password", { exact: true }).fill("SyntheticPassword123!");
  await page.getByRole("button", { name: "Show password", exact: true }).click();
  await expect(page.getByLabel("Password", { exact: true })).toHaveAttribute("type", "text");
  await page.getByRole("button", { name: "Hide password", exact: true }).click();
  await page.route("**/api/signup", route => route.fulfill({ status: 202, json: { confirmationRequired: true } }));
  await page.getByRole("button", { name: "Create account", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Confirm your email" })).toBeVisible();
  await page.getByRole("button", { name: "Back to sign-in", exact: true }).click();
  await page.route("**/api/session", route => route.request().method() === "POST"
    ? route.fulfill({ status: 401, json: { error: "Invalid sign-in details." } }) : route.continue());
  await page.getByLabel("Password", { exact: true }).fill("IncorrectPassword");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByRole("alert").filter({ hasText: "Invalid sign-in details." })).toBeVisible();
  await expect(page.getByLabel("Email address")).toHaveValue("reviewer@example.test");
  const invalid = await page.request.get("/auth/confirm", { maxRedirects: 0 });
  expect(invalid.status()).toBe(307);
  expect(invalid.headers().location).toContain("/sign-in?auth=confirmation_failed");
  expect(invalid.headers()["referrer-policy"]).toBe("no-referrer");
  await page.goto("/privacy");
  await expect(page.getByRole("heading", { name: "Privacy policy", exact: true })).toBeVisible();
  await page.goto("/terms");
  await expect(page.getByRole("heading", { name: "Terms", exact: true })).toBeVisible();
});
