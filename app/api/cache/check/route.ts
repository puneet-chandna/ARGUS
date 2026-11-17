import { endpoint, HttpError, json } from "../../../../lib/http.ts";
import { estimateSeconds } from "../../../../lib/progress.ts";
import { lookupCache } from "../../../../lib/run-analysis.ts";
import { runStore } from "../../../../lib/runs.ts";
import { reviewer, serviceClient } from "../../../../lib/supabase.ts";

export const GET = endpoint(async request => {
  const { user } = await reviewer();
  const hash = new URL(request.url).searchParams.get("hash");
  if (!hash || !/^[a-f0-9]{64}$/.test(hash)) throw new HttpError(400, "Invalid PDF checksum.");
  const store = runStore(serviceClient(), user.id);
  const { check } = await lookupCache(store, hash);
  const estimatedSeconds = check.cache !== "hit" && check.pagesTotal
    ? estimateSeconds(await store.samples(), check.pagesTotal - check.pagesCached) : undefined;
  return json({ ...check, estimatedSeconds });
});
