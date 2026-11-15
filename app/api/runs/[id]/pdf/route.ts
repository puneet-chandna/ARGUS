import { endpoint } from "../../../../../lib/http.ts";
import { reviewer, serviceClient } from "../../../../../lib/supabase.ts";
import { runStore } from "../../../../../lib/runs.ts";

export const GET = endpoint(async (_request, { params }: { params: Promise<{ id: string }> }) => {
  const { user } = await reviewer();
  const { pdf, run } = await runStore(serviceClient(), user.id).pdf((await params).id);
  const filename = encodeURIComponent(run.filename).replace(/['()*]/g, (char) => `%${char.charCodeAt(0).toString(16)}`);
  return new Response(pdf, {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `inline; filename*=UTF-8''${filename}`,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
      "Content-Length": String(pdf.size),
    },
  });
});
