import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import manifest from "../vaatun-starter-bundle/MANIFEST.json" with { type: "json" };

const bundle = new URL("../vaatun-starter-bundle/", import.meta.url);

for (const { path, bytes, sha256 } of manifest.files) {
  const file = readFileSync(new URL(path, bundle));
  const digest = createHash("sha256").update(file).digest("hex");
  if (file.length !== bytes || digest !== sha256) {
    throw new Error(`Starter file differs from the pinned manifest: ${path}`);
  }
}

console.log(`Verified ${manifest.files.length} official starter files.`);
