import { defineConfig, devices } from "@playwright/test";

const baseURL = process.env.ARGUS_TEST_URL;
if (!baseURL || !["localhost", "127.0.0.1", "[::1]"].includes(new URL(baseURL).hostname)) {
  throw new Error("Set ARGUS_TEST_URL to a disposable local Argus instance.");
}

export default defineConfig({
  testDir: "./test/e2e",
  forbidOnly: Boolean(process.env.CI),
  workers: 1,
  use: {
    ...devices["Desktop Chrome"],
    baseURL,
    trace: "retain-on-failure",
    ...(process.env.ARGUS_TEST_BROWSER_CHANNEL ? { channel: process.env.ARGUS_TEST_BROWSER_CHANNEL } : {}),
  },
});
