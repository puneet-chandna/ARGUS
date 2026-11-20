import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { resolve, relative, dirname } from "node:path";
import { stripTypeScriptTypes } from "node:module";
import { fileURLToPath } from "node:url";
import { CoverageReport } from "monocart-coverage-reports";
import { loadBindings, transform } from "next/dist/build/swc/index.js";

const directory = resolve(".local/coverage");
await loadBindings();
const paths = new Set();
for (const dir of ["app", "lib"]) {
  for (const file of await readdir(dir, { recursive: true })) {
    if (!/\.tsx?$/.test(file)) continue;
    if (file.endsWith(".ts") && !stripTypeScriptTypes(await readFile(`${dir}/${file}`, "utf8"), { mode: "transform" })
      .replace(/export\s*\{\s*\};?/, "").trim()) continue;
    paths.add(`${dir}/${file}`);
  }
}
function sourcePath(path) {
  const prefix = "[project]/";
  return path.startsWith(prefix) ? path.slice(prefix.length) : path;
}
const report = new CoverageReport({
  name: "Argus runtime coverage", outputDir: `${directory}/report`, cleanCache: true,
  reports: ["v8", "v8-json", "console-summary", "lcovonly"],
  entryFilter: entry => {
    if (entry.url.startsWith("http")) return entry.url.includes("/_next/static/");
    if (!entry.url.startsWith("file:")) return false;
    const path = relative(process.cwd(), fileURLToPath(entry.url));
    return paths.has(path) || path.startsWith(".next/server/");
  },
  sourcePath, sourceFilter: path => paths.has(sourcePath(path)),
  outputFilter: entry => paths.has(entry.sourcePath),
  all: { dir: ["app", "lib"], filter: path => /\.tsx?$/.test(path), transformer: async entry => {
    const result = await transform(entry.source, { filename: fileURLToPath(entry.url), sourceMaps: true,
      jsc: { parser: { syntax: "typescript", tsx: entry.url.endsWith(".tsx") }, target: "es2022" } });
    entry.source = result.code; entry.sourceMap = JSON.parse(result.map);
  } },
});
await report.addFromDir(`${directory}/node`);
for (const file of await readdir(`${directory}/browser`)) {
  const entries = JSON.parse(await readFile(`${directory}/browser/${file}`, "utf8"));
  for (const entry of entries) {
    if (!entry.url.includes("/_next/static/")) continue;
    const map = /\/\/# sourceMappingURL=(\S+)/.exec(entry.source ?? "")?.[1];
    if (!map) continue;
    const path = resolve(".next", dirname(new URL(entry.url).pathname.replace("/_next/", "")), map);
    assert.ok(path.startsWith(resolve(".next") + "/"));
    entry.sourceMap = JSON.parse(await readFile(path, "utf8"));
  }
  await report.add(entries);
}
const result = await report.generate();
const reported = new Set(result.files.map(file => file.sourcePath));
assert.equal(reported.size, paths.size, "Every authored runtime TS/TSX file must appear, including untested files");
assert.equal(result.files.length, paths.size, "Source maps must not create duplicate source files");
for (const path of paths) assert.ok(reported.has(path), `Missing coverage: ${path}`);
assert.ok(result.summary.lines.pct > 80, `Runtime line coverage ${result.summary.lines.pct}% must exceed 80%`);
