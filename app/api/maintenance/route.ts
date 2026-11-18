import { createHash, timingSafeEqual } from "node:crypto";
import { json } from "../../../lib/http.ts";
import { runStore } from "../../../lib/runs.ts";
import { serviceClient } from "../../../lib/supabase.ts";

const hash = (value: string) => createHash("sha256").update(value).digest();

export async function POST(request: Request) {
  const authorization = request.headers.get("authorization");
  const bearer = authorization?.match(/^Bearer (\S{32,256})$/)?.[1];
  if (!bearer) return json({ error: "Not authorized." }, 401);
  try {
    const client = serviceClient();
    const secret = process.env.ARGUS_MAINTENANCE_SECRET;
    if (!secret || secret.length < 32 || !timingSafeEqual(hash(bearer), hash(secret))) {
      const { data, error } = await client.rpc("argus_maintenance_scheduled", { candidate: bearer });
      if (error) throw error;
      if (data !== true) return json({ error: "Not authorized." }, 401);
    }
    const [expired, pending] = await Promise.all([
      client.rpc("argus_retention_candidates"),
      client.from("argus_runs").select("id,owner_id").eq("pdf_cleanup_pending", true).order("created_at").limit(100),
    ]);
    if (expired.error || pending.error) throw expired.error || pending.error;
    let failed = 0;
    let removed = 0;
    for (const row of expired.data ?? []) {
      try { if (await runStore(client, row.owner_id).removeExpired(row.id)) removed++; }
      catch { failed++; }
    }
    for (const row of pending.data) {
      try { await runStore(client, row.owner_id).cleanupOriginal(row.id); }
      catch { failed++; }
    }
    return json({ expired: removed, originals: pending.data.length, failed }, failed ? 503 : 200);
  } catch {
    return json({ error: "Maintenance could not complete. Retry the scheduled job." }, 503);
  }
}
