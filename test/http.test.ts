import assert from "node:assert/strict";
import test from "node:test";
import { endpoint, json } from "../lib/http.ts";

test("local mutations accept the browser's exact loopback origin", async t => {
  const { ARGUS_PUBLIC_ORIGIN, RENDER_EXTERNAL_URL } = process.env;
  delete process.env.ARGUS_PUBLIC_ORIGIN;
  delete process.env.RENDER_EXTERNAL_URL;
  t.after(() => {
    if (ARGUS_PUBLIC_ORIGIN === undefined) delete process.env.ARGUS_PUBLIC_ORIGIN;
    else process.env.ARGUS_PUBLIC_ORIGIN = ARGUS_PUBLIC_ORIGIN;
    if (RENDER_EXTERNAL_URL === undefined) delete process.env.RENDER_EXTERNAL_URL;
    else process.env.RENDER_EXTERNAL_URL = RENDER_EXTERNAL_URL;
  });
  const mutation = endpoint(async () => json({ accepted: true }));
  const post = async (host: string, origin: string | null, url = "http://localhost:3170/api/session") => {
    const headers = new Headers({ Host: host, "X-Forwarded-Host": "unrelated.example" });
    if (origin !== null) headers.set("Origin", origin);
    return (await mutation(new Request(url, { method: "POST", headers }))).status;
  };
  assert.equal(await post("127.0.0.1:3170", "http://127.0.0.1:3170"), 200);
  assert.equal(await post("localhost:3170", "http://localhost:3170"), 200);
  assert.equal(await post("[::1]:3170", "http://[::1]:3170"), 200);
  assert.equal(await post("127.0.0.1:3170", "http://localhost:3170"), 403);
  assert.equal(await post("127.0.0.1:3170", "http://127.0.0.1:3171"), 403);
  assert.equal(await post("127.0.0.1:3170", null), 403);
  assert.equal(await post("unrelated.example", "http://unrelated.example"), 403);

  process.env.ARGUS_PUBLIC_ORIGIN = "https://argus.example/";
  assert.equal(await post("127.0.0.1:3170", "http://127.0.0.1:3170"), 403);
  assert.equal(await post("argus.example", "https://argus.example"), 200);
});
