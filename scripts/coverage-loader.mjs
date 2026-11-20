import { registerHooks, stripTypeScriptTypes } from "node:module";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

const root = pathToFileURL(process.cwd() + "/").href;
registerHooks({ load(url, context, next) {
  if (!url.startsWith(root) || !/\/(?:app|lib|test)\//.test(url.slice(root.length - 1)) || !url.endsWith(".ts")) return next(url, context);
  const source = stripTypeScriptTypes(readFileSync(new URL(url), "utf8"), { mode: "transform", sourceMap: true, sourceUrl: url });
  const directory = process.env.NODE_V8_COVERAGE;
  if (directory) {
    mkdirSync(directory, { recursive: true });
    writeFileSync(resolve(directory, `source-${createHash("sha1").update(url + source).digest("hex")}.json`), JSON.stringify({ url, source }));
  }
  return { format: "module", source, shortCircuit: true };
} });
