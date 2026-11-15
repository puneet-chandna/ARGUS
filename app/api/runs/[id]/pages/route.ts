import { endpoint, HttpError, json } from "../../../../../lib/http.ts";
import { previewPage, storedPdfPages } from "../../../../../lib/ingestion/index.ts";
import { reviewer, serviceClient } from "../../../../../lib/supabase.ts";
import { runStore } from "../../../../../lib/runs.ts";

export const GET = endpoint(async (request, { params }: { params: Promise<{ id: string }> }) => {
  const { user } = await reviewer();
  const { id } = await params;
  const query = new URL(request.url).searchParams.get("page");
  if (query !== null && !/^[1-9][0-9]?$/.test(query)) throw new HttpError(404, "Policy page not found.");
  const { pdf } = await runStore(serviceClient(), user.id).pdf(id);
  const bytes = new Uint8Array(await pdf.arrayBuffer());
  if (query === null) return json({ pages: await storedPdfPages(bytes) });
  const image = await previewPage(bytes, Number(query));
  if (!image) throw new HttpError(404, "Policy page not found.");
  return new Response(new Uint8Array(image), {
    headers: { "Content-Type": "image/png", "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" },
  });
});
