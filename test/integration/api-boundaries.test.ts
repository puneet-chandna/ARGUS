import assert from "node:assert/strict";
import test from "node:test";

test("public API guards reject unauthorized maintenance and malformed sign-up without creating accounts", async () => {
  const origin = new URL(process.env.ARGUS_TEST_URL!);
  assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname), "Use a disposable local app");
  const request = (path: string, init: RequestInit = {}) => fetch(new URL(path, origin), init);
  for (const authorization of [undefined, "Bearer short", `Bearer ${"x".repeat(64)}`]) {
    const response = await request("/api/maintenance", { method: "POST", headers: authorization ? { Authorization: authorization } : {} });
    assert.equal(response.status, 401);
    assert.equal(response.headers.get("cache-control"), "private, no-store");
  }
  for (const [body, status] of [["{", 400], ["[]", 400], [JSON.stringify({ email: "reviewer@example.test", password: "short" }), 400],
    [JSON.stringify({ extra: "x".repeat(9000) }), 413]] as const) {
    const response = await request("/api/signup", { method: "POST", headers: { Origin: origin.origin, "Content-Type": "application/json" }, body });
    assert.equal(response.status, status);
  }
  const foreign = await request("/api/signup", { method: "POST", headers: { Origin: "https://unrelated.example", "Content-Type": "application/json" }, body: "{}" });
  assert.equal(foreign.status, 403);
  const invalidSession = await request("/api/session", { method: "POST", headers: { Origin: origin.origin, "Content-Type": "application/json" }, body: JSON.stringify({ email: 7, password: "" }) });
  assert.equal(invalidSession.status, 400);
  for (const path of ["/auth/confirm?code=invalid", "/auth/confirm?token_hash=invalid"]) {
    const response = await request(path, { redirect: "manual" });
    assert.equal(response.status, 307);
    const target = new URL(response.headers.get("location")!);
    assert.equal(target.origin, origin.origin);
    assert.equal(target.pathname, "/sign-in");
    assert.equal(target.searchParams.get("auth"), "confirmation_failed");
    assert.equal(response.headers.get("referrer-policy"), "no-referrer");
  }
});
