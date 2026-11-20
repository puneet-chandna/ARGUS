import { test as base } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

export const test = base.extend<{ coverage: void }>({
  coverage: [async ({ page }, use) => {
    const directory = process.env.ARGUS_COVERAGE_DIR;
    if (!directory) return use();
    const session = await page.context().newCDPSession(page);
    const sources = new Map<string, Promise<string | null>>();
    type Entry = { scriptId: string; url: string; functions: { ranges: { count: number }[] }[]; source?: string };
    const entries: Entry[] = [];
    session.on("Debugger.scriptParsed", event => {
      if (event.url.includes("/_next/static/")) sources.set(event.scriptId,
        session.send("Debugger.getScriptSource", { scriptId: event.scriptId }).then(result => result.scriptSource).catch(() => null));
    });
    await session.send("Debugger.enable");
    await session.send("Profiler.enable");
    await session.send("Profiler.startPreciseCoverage", { callCount: true, detailed: true });
    async function collect() {
      const { result } = await session.send("Profiler.takePreciseCoverage");
      entries.push(...result.filter((entry: Entry) => sources.has(entry.scriptId) &&
        entry.functions.some(fn => fn.ranges.some(range => range.count > 0))));
    }
    // Flush before navigation destroys an execution context; retain counts from earlier pages.
    let collecting: Promise<void> | undefined;
    const timer = setInterval(() => {
      if (!collecting) collecting = collect().finally(() => { collecting = undefined; });
    }, 100);
    try { await use(); } finally {
      clearInterval(timer);
      await collecting;
      await collect();
      await session.send("Profiler.stopPreciseCoverage");
      for (const entry of entries) entry.source = await sources.get(entry.scriptId) ?? undefined;
      await session.detach();
      await mkdir(directory, { recursive: true });
      await writeFile(join(directory, `${randomUUID()}.json`), JSON.stringify(entries.filter(entry => entry.source)));
    }
  }, { auto: true }],
});
