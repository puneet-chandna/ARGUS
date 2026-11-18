import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as wait } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { chromium, expect } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";
import { inspectPdf } from "../lib/ingestion/index.ts";
import { EXTRACTION_VERSION } from "../lib/ingestion/providers.ts";
import { applyRating } from "../lib/report.ts";
import { runStore } from "../lib/runs.ts";
import { checksum, pdfObject } from "../lib/upload.ts";
import { verifiedOcrProfile } from "../lib/verified-ocr.ts";

process.chdir(fileURLToPath(new URL("..", import.meta.url)));
const { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, SUPABASE_SECRET_KEY } = process.env;
assert(SUPABASE_URL && SUPABASE_PUBLISHABLE_KEY && SUPABASE_SECRET_KEY &&
  ["localhost", "127.0.0.1", "[::1]"].includes(new URL(SUPABASE_URL).hostname),
  "Export SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY and SUPABASE_SECRET_KEY for a running local Supabase with Argus migrations.");

const liveOnly = process.argv.includes("--live-only");
assert(process.env.NVIDIA_API_KEY?.trim(), "Export an NVIDIA Build key with access to the free Nemotron and Mistral endpoints.");
Object.assign(process.env, {
  SARVAM_API_KEY: process.env.SARVAM_API_KEY || "", GEMINI_API_KEY: "", ARGUS_OCR_CACHE_DIR: "", ARGUS_WRITE_OCR_CACHE: "0",
  ARGUS_NVIDIA_ENDPOINT: "", ARGUS_OCR_PAGES_PER_RUN: "20", ARGUS_FAKE_SLOW: "",
});

const digit = "pvt-car-satp-go-digit";
const hdfc = "pvt-car-comprehensive-hdfc-ergo";
const tata = "pvt-car-satp-tata-aig";
const reliance = "pvt-car-comprehensive-reliance";
const titles = ["Go Digit · Stand-alone TP", "HDFC ERGO · Comprehensive", "Tata AIG · Archived decision"];
const archivedTata = "9840933f7ef5d7df4f3409039edd5634885da545";
const pdfPath = (sample) => resolve("vaatun-starter-bundle/sample-policies", sample + ".pdf");
const viewport = { width: 1280, height: 760 };
const browserOptions = { viewport, colorScheme: "light", reducedMotion: "no-preference" };
const command = (file, args) => execFileSync(file, args, { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
const value = ({ data, error }) => {
  if (error) throw error;
  return data;
};

execFileSync("npm", ["run", "verify:corpus"], { stdio: "inherit" });
execFileSync("npm", ["run", "build"], { stdio: "inherit" });

const portFinder = createServer();
await new Promise((done, reject) => {
  portFinder.once("error", reject);
  portFinder.listen(0, "127.0.0.1", done);
});
const { port } = portFinder.address();
await new Promise((done) => portFinder.close(done));
const baseURL = "http://127.0.0.1:" + port;
const temporary = await mkdtemp(join(tmpdir(), "argus-readme-"));
const db = createClient(SUPABASE_URL, SUPABASE_SECRET_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
const email = "demo-" + randomUUID().slice(0, 6) + "@argus.example";
const password = randomUUID();
let server;
let browser;
let owner;

async function seed() {
  owner = value(await db.auth.admin.createUser({ email, password, email_confirm: true })).user.id;
  value(await db.from("argus_profiles").insert({ owner_id: owner, display_name: "Argus Demo", time_zone: "Asia/Kolkata" }));
  const store = runStore(db, owner);
  for (const [index, sample] of [digit, hdfc, tata].entries()) {
    const prior = JSON.parse(sample === tata
      ? command("git", ["show", archivedTata + ":submission/" + tata + ".json"])
      : await readFile("submission/" + sample + ".json", "utf8"));
    const bytes = await readFile(pdfPath(sample));
    const digest = checksum(bytes);
    assert.equal(prior.checksum, digest);
    const { filename, fields, clarifications } = prior;
    const extraction = { filename, checksum: digest, fields, clarifications, reader_failures: {}, extraction_version: EXTRACTION_VERSION };
    // Preserve the published historical decision under its original rule version.
    const result = sample === tata
      ? { ...prior, reader_failures: {}, rating_trace_start: prior.trace.findIndex(step => step.sources.some(source => source.sheet)) }
      : applyRating(extraction);
    assert.equal(result.status, ["resolved", "ambiguous", "unsupported"][index]);
    const run = await store.upload({ filename, bytes, digest, allowCloud: false }, randomUUID(), await inspectPdf(bytes), "hit");
    value(await db.from("argus_runs").update({
      display_name: titles[index], status: "complete", ocr_mode: "local", result,
      created_at: new Date(Date.now() - (index + 1) * 86_400_000).toISOString(),
    }).match({ id: run.id, owner_id: owner }));
    if (sample === digit && !liveOnly) {
      value(await db.from("argus_ocr_cache").insert({
        owner_id: owner, checksum: digest, profile: verifiedOcrProfile(), extraction, grounded_text: [],
      }));
    }
  }
}

const button = (page, name) => page.getByRole("button", { name, exact: true });
const heading = (page, name) => page.getByRole("heading", { name, exact: true });
const commission = (page) => page.getByRole("region", { name: "Broker commission" });
const trace = (page) => page.getByRole("tabpanel", { name: "Decision trace" });
const row = (page, index) => page.locator(".history-item").filter({ hasText: titles[index] });

async function workspace(context, signedIn = true) {
  const page = await context.newPage();
  page.setDefaultTimeout(15_000);
  await page.goto(signedIn ? "/workspace" : "/sign-in");
  if (!signedIn) {
    await page.getByLabel("Email address").fill(email);
    await page.getByLabel("Password", { exact: true }).fill(password);
    await button(page, "Sign in").click();
  }
  await expect(heading(page, "New analysis")).toBeVisible();
  await expect(page.locator(".history-item")).toHaveCount(3);
  for (const [index, status] of ["Resolved", "Needs review", "Unsupported"].entries()) {
    await expect(row(page, index)).toContainText(status);
  }
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
  // Let the masthead's line drawing finish before the first capture.
  await wait(700);
  return page;
}

async function moveTo(page, locator) {
  await expect(locator).toBeInViewport();
  const { x, y, width, height } = await locator.boundingBox();
  await page.mouse.move(x + width / 2, y + height / 2, { steps: 25 });
  await wait(100);
}

function installCursor() {
  document.addEventListener("DOMContentLoaded", () => {
    const cursor = document.createElement("div");
    const shape = "position:fixed;pointer-events:none;z-index:2147483647;border-radius:50%;width:14px;height:14px;transform:translate(-50%,-50%);";
    cursor.style.cssText = shape + "background:#12645d;border:1px solid white;box-shadow:0 0 0 4px #12645d45;";
    cursor.hidden = true;
    document.body.append(cursor);
    const position = (element, x, y) => {
      element.style.left = x + "px";
      element.style.top = y + "px";
    };
    document.addEventListener("pointermove", (event) => {
      cursor.hidden = false;
      position(cursor, event.clientX, event.clientY);
    }, { passive: true });
    document.addEventListener("pointerdown", (event) => {
      const ripple = document.createElement("div");
      ripple.style.cssText = shape + "border:2px solid #12645d;";
      position(ripple, event.clientX, event.clientY);
      document.body.append(ripple);
      ripple.animate([{ scale: 1, opacity: 0.8 }, { scale: 3, opacity: 0 }], 300).finished.then(() => ripple.remove());
    }, { passive: true });
  }, { once: true });
}

async function screenshots(storageState) {
  const context = await browser.newContext({ ...browserOptions, baseURL, deviceScaleFactor: 2, storageState });
  const page = await workspace(context);
  const screenshot = async (name) => {
    await page.screenshot({ path: join(temporary, name), scale: "device", animations: "disabled" });
  };
  await row(page, 0).click();
  await expect(commission(page)).toContainText("29.5%");
  await expect(trace(page).locator(".run-trace li").first()).toBeInViewport();
  await screenshot("01-result.png");
  await row(page, 2).click();
  await expect(commission(page)).toContainText("The supplied grid has no usable mapping");
  await screenshot("02-unsupported.png");
  await button(page, "New analysis").click();
  await page.locator('input[type="file"]').setInputFiles(pdfPath(reliance));
  await expect(page.locator(".cache-chip-row")).toContainText("New PDF");
  await button(page, "Analyze policy").evaluate(element => element.scrollIntoView({ block: "nearest" }));
  await page.locator(".work").evaluate(element => element.scrollBy(0, 16));
  await expect(page.getByRole("checkbox", { name: /approved for processing/ })).toBeInViewport();
  await screenshot("04-consent.png");
  await context.close();
}

async function record(storageState) {
  const context = await browser.newContext({
    ...browserOptions, baseURL, deviceScaleFactor: 1, storageState,
    recordVideo: { dir: temporary, size: viewport },
  });
  await context.addInitScript(installCursor);
  const page = await workspace(context);
  const video = page.video();
  // Pace the genuine cached request so the production loading state has time to play.
  await page.route("**/api/runs", async (route) => {
    if (route.request().method() === "POST") await wait(5050);
    await route.continue();
  });
  const seconds = () => performance.now() / 1000;

  await page.mouse.move(340, 155, { steps: 25 });
  const start = seconds();
  await wait(260);
  const choose = button(page, "Choose PDF");
  await moveTo(page, choose);
  const chooser = page.waitForEvent("filechooser");
  await choose.click();
  await (await chooser).setFiles(pdfPath(digit));
  await expect(page.locator(".cache-chip-row .cache-chip")).toContainText("Analyzed before");
  const analyze = button(page, "Analyze policy");
  await analyze.evaluate(element => element.scrollIntoView({ block: "nearest", behavior: "smooth" }));
  await wait(1450);
  await moveTo(page, analyze);
  const uploaded = page.waitForResponse(response => new URL(response.url()).pathname === "/api/runs" &&
    response.request().method() === "POST");
  const completed = page.waitForFunction(() => Boolean(document.querySelector('.reading-stage[data-beat="true"]')))
    .then(() => seconds());
  await analyze.click();
  const stage = page.locator(".reading-stage");
  await expect(stage).toBeVisible();
  const loading = seconds();
  const response = await uploaded;
  assert.equal(response.status(), 201, "The app could not complete its cached upload.");
  const { mode, run } = await response.json();
  assert.equal(mode, "instant");
  assert.equal(run.result.status, "resolved");
  const beat = await completed;
  await expect(commission(page)).toContainText("29.5%");
  const citation = commission(page).locator(".cited-cell");
  await expect(citation).toBeInViewport();
  await wait(850);

  const evidence = button(page, "View decision evidence");
  await moveTo(page, evidence);
  for (let index = 0; index < 9; index++) {
    await page.mouse.wheel(0, 9);
    await wait(40);
  }
  await moveTo(page, evidence);
  await evidence.click();
  const cell = await citation.textContent();
  const traceCell = trace(page).getByText(cell, { exact: true });
  await expect(traceCell).toBeVisible();
  await traceCell.evaluate(element => element.scrollIntoView({ block: "center", behavior: "smooth" }));
  await expect(traceCell).toBeInViewport();
  await wait(250);
  const { x, y, height } = await traceCell.boundingBox();
  await page.mouse.move(x - 16, y + height / 2, { steps: 25 });
  const traceReady = seconds();
  const evidenceEnd = Math.max(beat + 4.60, traceReady + 0.65);
  await wait(Math.max(0, evidenceEnd - seconds()) * 1000);
  const beforeUnsupported = seconds();
  await moveTo(page, row(page, 2));
  await row(page, 2).click();
  await expect(commission(page)).toContainText("The supplied grid has no usable mapping");
  await page.locator(".work").evaluate(element => element.scrollTo(0, 0));
  await expect(commission(page)).toBeInViewport();
  const unsupported = seconds();
  await wait(2150);
  const end = seconds();
  const { source, time } = await recordedVideo(context, video, end);
  const hero = join(temporary, "hero.mkv");
  const clips = [[start, loading + 3.0], [beat - 0.2, beforeUnsupported], [unsupported + 0.15, end - 0.05]];
  console.log("Hero segments (seconds): " + clips.map(([from, to]) => (to - from).toFixed(2)).join(", "));
  editVideo(source, time, clips, hero, 1.2);
  return hero;
}

async function recordedVideo(context, video, end) {
  await context.close();
  const source = await video.path();
  const videoEnd = Number(command("ffprobe", [
    "-v", "error", "-select_streams", "v:0", "-show_entries", "packet=pts_time", "-of", "csv=p=0", source,
  ]).trim().split("\n").at(-1));
  return { source, time: (mark) => (videoEnd - (end - mark)).toFixed(3) };
}

function editVideo(source, time, clips, output, hold = 0) {
  const filters = clips.map(([from, to], index) => "[0:v]trim=start=" + time(from) + ":end=" + time(to) +
    ",setpts=PTS-STARTPTS[v" + index + "]");
  const streams = clips.map((_, index) => "[v" + index + "]").join("");
  ffmpeg(["-i", source, "-filter_complex", filters.join(";") + ";" + streams +
    "concat=n=" + clips.length + ":v=1:a=0,tpad=stop_mode=clone:stop_duration=" + hold, "-c:v", "ffv1", output]);
}

async function recordLive(storageState) {
  const context = await browser.newContext({ ...browserOptions, baseURL, deviceScaleFactor: 1, storageState,
    recordVideo: { dir: temporary, size: viewport } });
  await context.addInitScript(installCursor);
  const page = await workspace(context);
  const video = page.video();
  await page.locator('input[type="file"]').setInputFiles(pdfPath(digit));
  await expect(page.locator(".cache-chip-row .cache-chip")).toContainText("New PDF");
  await page.getByRole("checkbox", { name: /approved for processing/ }).check();
  const analyze = button(page, "Analyze policy");
  await analyze.scrollIntoViewIfNeeded();
  await moveTo(page, analyze);
  // Mark visible page changes so the edit can cut idle waits without speeding up the eye.
  await page.evaluate(() => {
    const times = [];
    const observer = new MutationObserver(() => {
      const stage = document.querySelector('.reading-stage[data-short="false"]');
      if (!stage) return;
      const time = Date.now() / 1000;
      if (stage.dataset.beat === "true") {
        window.liveCapture = { times, beat: time };
        observer.disconnect();
        return;
      }
      const caption = stage.querySelector('.eye-caption span[data-exit="false"]')?.textContent;
      if (!caption?.startsWith("Reading page")) return;
      const done = stage.querySelectorAll('.eye-page[data-state="done"]').length;
      const key = caption + ":" + done;
      if (times.at(-1)?.key !== key) times.push({ time, key, done });
    });
    observer.observe(document.querySelector(".analysis-region"), { subtree: true, childList: true, attributes: true });
  });
  const upload = page.waitForResponse(response => new URL(response.url()).pathname === "/api/runs" &&
    response.request().method() === "POST");
  await analyze.click();
  const response = await upload;
  assert.equal(response.status(), 201);
  const { mode, cache, pagesToOcr, run } = await response.json();
  assert.equal(mode, "live");
  assert.equal(cache, "miss");
  assert.equal(pagesToOcr, 4);
  console.log("Recording four uncached pages through live OCR.");
  await expect(commission(page)).toBeVisible({ timeout: 240_000 });
  const completed = value(await db.from("argus_runs").select("ocr_mode, cache_result, progress, result, duration_ms")
    .match({ id: run.id, owner_id: owner }).single());
  assert.equal(completed.ocr_mode, "external");
  assert.equal(completed.cache_result, "miss");
  assert.equal(completed.progress.pagesDone, pagesToOcr);
  assert.deepEqual(completed.result.reader_failures, {});

  const { times, beat } = await page.evaluate(() => window.liveCapture);
  const endOfClip = beat + 1.8;
  await wait(Math.max(0, endOfClip + 0.2 - Date.now() / 1000) * 1000);
  const { source, time } = await recordedVideo(context, video, Date.now() / 1000);
  const first = times[0].time + 0.08;
  const last = beat - 1.55;
  const middle = times.find(mark => mark.done > 0)?.time ?? (first + last) / 2;
  const pivot = Math.min(last - 1.1, Math.max(first + 1.2, middle - 0.08));
  const clips = last - first >= 2.3
    ? [[first, first + 1.2], [pivot, pivot + 1.1], [last, endOfClip]]
    : [[first, endOfClip]];
  const seconds = clips.reduce((sum, [from, to]) => sum + to - from, 0);
  const output = join(temporary, "analyzing.mkv");
  editVideo(source, time, clips, output, Math.max(0, 5.55 - seconds));
  console.log("Live OCR completed in " + (completed.duration_ms / 1000).toFixed(1) + " s · " + completed.result.status);
  return output;
}

function ffmpeg(args) {
  command("ffmpeg", ["-nostdin", "-v", "error", "-y", ...args]);
}

async function gif(source, name, minSeconds, maxSeconds, maxBytes) {
  const path = join(temporary, name);
  function encode(fps) {
    ffmpeg(["-i", source, "-filter_complex_threads", "1", "-vf",
      "fps=" + fps + ",scale=900:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=128:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4",
      "-loop", "0", path]);
  }
  encode(12);
  if ((await stat(path)).size > maxBytes) {
    encode(10);
    const optimized = join(temporary, "optimized-" + name);
    command("gifsicle", ["-O3", "--lossy=60", path, "-o", optimized]);
    await copyFile(optimized, path);
  }
  const size = (await stat(path)).size;
  const duration = Number(command("ffprobe", [
    "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", path,
  ]));
  assert(size <= maxBytes && duration >= minSeconds && duration <= maxSeconds,
    name + " is " + size + " bytes and " + duration + " seconds.");
  console.log(name + " · " + size + " bytes · " + duration.toFixed(2) + " s");
}

try {
  server = spawn("npm", ["run", "start", "--", "--hostname", "127.0.0.1", "--port", String(port)], {
    env: { ...process.env, ARGUS_PUBLIC_ORIGIN: baseURL }, detached: true, stdio: ["ignore", "inherit", "inherit"],
  });
  await expect.poll(async () => fetch(baseURL + "/api/health", { signal: AbortSignal.timeout(1000) })
    .then(res => res.ok).catch(() => false), { timeout: 15_000 }).toBe(true);
  await seed();
  browser = await chromium.launch({ headless: true });
  const session = await browser.newContext({ ...browserOptions, baseURL });
  await workspace(session, false);
  const storageState = await session.storageState();
  await session.close();
  const names = ["03-analyzing.gif"];
  if (!liveOnly) {
    await screenshots(storageState);
    const hero = await record(storageState);
    await gif(hero, "hero.gif", 12, 15, 5_000_000);
    ffmpeg(["-i", hero, "-vf", "fps=24,scale=900:-2:flags=lanczos", "-c:v", "libx264", "-crf", "19",
      "-pix_fmt", "yuv420p", "-movflags", "+faststart", join(temporary, "hero.mp4")]);
    value(await db.from("argus_ocr_cache").delete().eq("owner_id", owner));
    // The cached hero also creates a fourth saved run. Keep the demo sidebar consistent.
    const { id } = value(await db.from("argus_runs").select("id").eq("owner_id", owner).is("display_name", null).single());
    await runStore(db, owner).remove(id);
    names.push("hero.gif", "hero.mp4", "01-result.png", "02-unsupported.png", "04-consent.png");
  }
  const analyzing = await recordLive(storageState);
  await gif(analyzing, "03-analyzing.gif", 5, 6, 3_000_000);
  await mkdir("docs/assets", { recursive: true });
  for (const name of names) {
    await copyFile(join(temporary, name), join("docs/assets", name));
  }
} finally {
  try {
    await browser?.close();
    if (owner) {
      const runs = value(await db.from("argus_runs").select("id").eq("owner_id", owner));
      if (runs.length) {
        value(await db.storage.from("argus-policy-pdfs").remove(runs.map(run => pdfObject(owner, run.id))));
        value(await db.from("argus_runs").delete().eq("owner_id", owner));
      }
      value(await db.auth.admin.deleteUser(owner));
    }
  } finally {
    if (server?.pid && server.exitCode === null) process.kill(-server.pid, "SIGTERM");
    await rm(temporary, { recursive: true, force: true });
  }
}
