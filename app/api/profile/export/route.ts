import { endpoint, HttpError, readJson } from "../../../../lib/http.ts";
import { accountSettings, activityFilters, eventsQuery, profileStore } from "../../../../lib/profile.ts";
import { csv, zip } from "../../../../lib/profile-export.ts";
import { auditActions, type AuditEvent } from "../../../../lib/profile-settings.ts";
import { present, runStore } from "../../../../lib/runs.ts";
import { reviewer, serviceClient } from "../../../../lib/supabase.ts";

async function all<T>(page: (start: number, end: number) => PromiseLike<{data: T[] | null; error: unknown}>) {
  const result: T[] = [];
  let size = 0;
  const batch = 100;
  for (let start = 0; ; start += batch) {
    const { data, error } = await page(start, start + batch - 1);
    if (error) throw error;
    if (!data?.length) return result;
    result.push(...data);
    size += Buffer.byteLength(JSON.stringify(data));
    if (size > 64 * 1024 * 1024) throw new HttpError(413, "This export is too large. Contact the workspace owner.");
    if (data.length < batch) return result;
  }
}

export const POST = endpoint(async (request) => {
  const { auth, user } = await reviewer();
  const input = await readJson(request);
  const service = serviceClient();
  const audit = profileStore(service, user.id);
  const headers = { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" };
  if (input.type === "run") {
    if (typeof input.runId !== "string") throw new HttpError(404, "Run not found.");
    const run = await runStore(service, user.id).get(input.runId);
    if (run.deleting_at || !run.result) throw new HttpError(409, "Only completed runs can be exported.");
    await audit.logExport(run.display_name ?? run.filename, "exported");
    return new Response(JSON.stringify(present(run), null, 2), { headers: { ...headers, "Content-Type": "application/json" } });
  }
  if (input.type !== "activity" && input.type !== "data") throw new HttpError(400, "Choose an export.");
  const params = new URLSearchParams();
  if (input.type === "activity") {
    for (const key of ["action", "start", "end"]) if (typeof input[key] === "string") params.set(key, input[key]);
  }
  const filters = activityFilters(params);
  const until = new Date().toISOString();
  const events = await all((a, b) => eventsQuery(auth, user.id, filters).lte("occurred_at", until).range(a, b)) as AuditEvent[];
  const activity = csv([["Time (UTC)", "Action", "Target", "OCR mode", "Status"],
    ...events.map(row => [row.occurred_at, auditActions[row.action], row.target, row.ocr_mode, row.status])]);
  if (input.type === "activity") {
    await audit.logExport("Activity CSV", "exported_activity");
    return new Response(activity, { headers: { ...headers, "Content-Type": "text/csv; charset=utf-8" } });
  }
  const [settings, photo, runs] = await Promise.all([
    accountSettings(auth, user), profileStore(auth, user.id).avatar(),
    all((a, b) => auth.from("argus_runs")
      .select("id,filename,display_name,created_at,status,result,ocr_mode,pdf_deleted_at").eq("owner_id", user.id)
      .lte("created_at", until).is("deleting_at", null).order("created_at").order("id").range(a, b)),
  ]);
  const archive = zip({
    "argus.json": JSON.stringify({ ...settings, photo, memberSince: user.created_at, runs, activity: events }, null, 2),
    "activity.csv": activity,
    "runs.csv": csv([["ID", "Filename", "Label", "Time (UTC)", "Status", "Decision"], ...runs.map(row =>
      [row.id, row.filename, row.display_name, row.created_at, row.status, row.result?.status])]),
    "account.csv": csv([["Email", "Display name", "Organization", "Member since"],
      [settings.email, settings.personal.display_name, settings.personal.organization, user.created_at]]),
  });
  await audit.logExport("Personal data ZIP", "exported_data");
  return new Response(new Uint8Array(archive), { headers: { ...headers, "Content-Type": "application/zip" } });
});
