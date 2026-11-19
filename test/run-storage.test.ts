import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { createClient } from "@supabase/supabase-js";
import { runStore } from "../lib/runs.ts";
import { checksum, pdfObject } from "../lib/upload.ts";

test("a fenced same-key upload returns the peer's queued run", async () => {
  const owner = randomUUID();
  const id = randomUUID();
  const key = randomUUID();
  const bytes = Buffer.from("%PDF-test");
  const input = { filename: "retry.pdf", bytes, digest: checksum(bytes), allowCloud: true };
  const run = { id, owner_id: owner, upload_key: key, filename: input.filename, checksum: input.digest,
    allow_cloud: input.allowCloud, status: "uploading", deleting_at: null };
  const started = Promise.withResolvers<void>();
  const resume = Promise.withResolvers<void>();
  let uploads = 0;
  const client = createClient("https://argus.test", "test-key", {
    auth: { autoRefreshToken: false, persistSession: false },
    global: {
      fetch: async (resource, options) => {
        const url = new URL(String(resource));
        if (url.pathname === `/storage/v1/object/argus-policy-pdfs/${pdfObject(owner, id)}`) {
          if (++uploads === 1) {
            started.resolve();
            await resume.promise;
            return Response.json({ error: "Conflict", message: "PDF reservation is closed." }, { status: 409 });
          }
          return Response.json({ Key: pdfObject(owner, id) });
        }
        assert.equal(url.pathname, "/rest/v1/argus_runs");
        if (options?.method === "POST") return new Response(null, { status: 201 });
        if (options?.method === "PATCH") {
          run.status = "queued";
          return Response.json(run);
        }
        return Response.json([run]);
      },
    },
  });

  const store = runStore(client, owner);
  const first = store.upload(input, key, 1, "miss");
  try {
    await started.promise;
    const peer = await store.upload(input, key, 1, "miss");
    assert.equal(peer.status, "queued");
  } finally {
    resume.resolve();
  }
  assert.equal((await first).id, id);
});
