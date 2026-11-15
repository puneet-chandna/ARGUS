import { configuredOrigin } from "../../../lib/http.ts";
import { NextResponse } from "next/server";
import { authClient } from "../../../lib/supabase.ts";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const target = new URL("/workspace", configuredOrigin() || url.origin);
  const code = url.searchParams.get("code");
  const tokenHash = url.searchParams.get("token_hash");
  try {
    const auth = await authClient();
    const result = code ? await auth.auth.exchangeCodeForSession(code, {
      flowId: url.searchParams.get("sb_flow_id") ?? undefined,
    }) : tokenHash ? await auth.auth.verifyOtp({ token_hash: tokenHash, type: "email" }) : null;
    if (!result?.data.session || result.error) {
      target.pathname = "/sign-in";
      target.searchParams.set("auth", "confirmation_failed");
    }
  } catch {
    target.pathname = "/sign-in";
    target.searchParams.set("auth", "confirmation_failed");
  }
  const response = NextResponse.redirect(target);
  response.headers.set("Cache-Control", "private, no-store");
  response.headers.set("Referrer-Policy", "no-referrer");
  return response;
}
