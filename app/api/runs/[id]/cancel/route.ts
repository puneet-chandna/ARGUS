import { endpoint, json } from "../../../../../lib/http.ts";
import { present, runStore } from "../../../../../lib/runs.ts";
import { reviewer, serviceClient } from "../../../../../lib/supabase.ts";

export const POST = endpoint(async (_request, route: { params: Promise<{ id: string }> }) => {
  const { user } = await reviewer();
  const { id } = await route.params;
  return json({ run: present(await runStore(serviceClient(), user.id).cancel(id)) });
});
