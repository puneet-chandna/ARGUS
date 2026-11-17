import assert from "node:assert/strict";
import test from "node:test";
import { commissionLabel, preferenceDefaults, workspaceReturn } from "../lib/profile-settings.ts";

test("profile returns only to an Argus workspace view", () => {
  const saved = "/workspace#00000000-0000-4000-8000-000000000001";
  for (const url of ["//other.site/workspace", "/workspace?redirect=//other.site", "/workspace/../profile", "/workspace#bad#hash"]) {
    assert.equal(workspaceReturn(url), "/workspace");
  }
  assert.equal(workspaceReturn(saved), saved);
  assert.equal(workspaceReturn("/workspace?new=1"), "/workspace?new=1");
});

test("commission display preserves zero and applies the reviewer format", () => {
  assert.equal(commissionLabel(0, preferenceDefaults), "0.0%");
  assert.equal(commissionLabel("29.55", { ...preferenceDefaults, decimals: 2, percent_sign: false }), "29.55");
});
