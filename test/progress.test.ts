import assert from "node:assert/strict";
import test from "node:test";
import { estimateSeconds, progressValue, stageText, type RunProgress } from "../lib/progress.ts";

import { requireConsent } from "../lib/upload.ts";

const progress: RunProgress = {
  stage: "reading", status: "processing", pagesDone: 9, pagesTotal: 15,
  page: 6, cachedPages: [1,2,3,4,5,12,13,14,15],
  startedAt: "2026-11-17T00:00:00Z", stageStartedAt: "2026-11-17T00:00:02Z",
  updatedAt: "2026-11-17T00:00:05Z",
};

test("cached page credit and reading copy use the reported pages", () => {
  assert.equal(progressValue(progress), 44);
  assert.equal(stageText(progress), "Reading page 6 of 15 (9 already analyzed)");
  assert.equal(progressValue({ ...progress, stage: "verifying" }), 97);
  assert.equal(progressValue({ ...progress, stage: "complete", status: "complete" }), 100);
});

test("estimates need five live observations and count only uncached pages", () => {
  assert.equal(estimateSeconds([3, 4, 7, 8], 6), undefined);
  assert.equal(estimateSeconds([3, 4, 7, 8, 25], 6), 42);
  assert.equal(estimateSeconds([3, 4, 7, 8, 25], null), undefined);
});

test("live and partial cache routes cannot bypass saved consent", () => {
  assert.throws(() => requireConsent("miss", false), { status: 422 });
  assert.throws(() => requireConsent("partial", false), { status: 422 });
  assert.doesNotThrow(() => requireConsent("hit", false));
  assert.doesNotThrow(() => requireConsent("miss", true));
});
