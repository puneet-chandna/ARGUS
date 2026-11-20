import { spawn } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const origin = new URL(process.env.ARGUS_TEST_URL ?? "");
const database = new URL(process.env.ARGUS_TEST_SUPABASE_URL ?? "");
if (![origin, database].every(url => ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) ||
  !process.env.ARGUS_TEST_SUPABASE_SECRET || !process.env.ARGUS_TEST_SUPABASE_PUBLISHABLE_KEY) {
  throw Error("Use the disposable local test stack described in docs/development.md");
}
const directory = resolve(".local/coverage");
await rm(directory, { recursive: true, force: true });
await mkdir(`${directory}/browser`, { recursive: true });
const coverage = { ...process.env, ARGUS_COVERAGE: "1", SUPABASE_URL: database.href,
  SUPABASE_SECRET_KEY: process.env.ARGUS_TEST_SUPABASE_SECRET,
  SUPABASE_PUBLISHABLE_KEY: process.env.ARGUS_TEST_SUPABASE_PUBLISHABLE_KEY };
const environment = { ...coverage, NODE_V8_COVERAGE: `${directory}/node`,
  NODE_OPTIONS: `--enable-source-maps --import ${resolve("scripts/coverage-loader.mjs")}` };
function run(command, args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, stdio: "inherit" });
    child.on("error", reject);
    child.on("exit", code => code === 0 ? resolve() : reject(Error(`${command} ${args.join(" ")} exited ${code}`)));
  });
}
await run("npm", ["run", "build"], coverage);
await run("npm", ["test"], environment);
const serverEnv = { ...environment, ARGUS_PUBLIC_ORIGIN: origin.origin,
  NVIDIA_API_KEY: "", SARVAM_API_KEY: "", GEMINI_API_KEY: "", ARGUS_FAKE_SLOW: "", ARGUS_OCR_CACHE_DIR: "" };
const server = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "--hostname", origin.hostname, "--port", origin.port || "80"], { env: serverEnv, stdio: "inherit" });
const stopped = new Promise(resolve => server.on("exit", resolve));
try {
  let ready = false;
  for (let attempt = 0; attempt < 40; attempt++) {
    if (server.exitCode !== null) throw Error("Coverage server did not start");
    try { ready = (await fetch(new URL("/api/health", origin), { signal: AbortSignal.timeout(1000) })).ok; } catch {}
    if (ready) break;
    await delay(250);
  }
  if (!ready) throw Error("Coverage server did not become healthy");
  await run("npm", ["run", "test:integration"], environment);
  await run("npm", ["run", "test:e2e"], { ...environment, ARGUS_COVERAGE_DIR: `${directory}/browser` });
} finally {
  server.kill("SIGTERM");
  await stopped;
}
await run(process.execPath, ["scripts/coverage-report.mjs"], process.env);
