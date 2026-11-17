import { createServerClient } from "@supabase/ssr";
import { createClient } from "@supabase/supabase-js";
import { cookies } from "next/headers";
import { configuredOrigin, HttpError } from "./http.ts";

function config() {
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_PUBLISHABLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if (!url || !key) throw new HttpError(503, "Supabase is not configured.");
  return { url, key };
}

export async function authClient(userAgent?: string | null) {
  const { url, key } = config();
  const jar = await cookies();
  return createServerClient(url, key, {
    ...(userAgent ? { global: { headers: { "User-Agent": userAgent.slice(0, 512) } } } : {}),
    cookieOptions: {
      httpOnly: true,
      sameSite: "lax",
      path: "/",
      secure: configuredOrigin()?.startsWith("https://") ?? process.env.NODE_ENV === "production",
    },
    cookies: {
      getAll: () => jar.getAll(),
      setAll: (entries) => {
        for (const { name, value, options } of entries) jar.set(name, value, options);
      },
    },
  });
}

export async function reviewer() {
  const auth = await authClient();
  const { data, error } = await auth.auth.getUser();
  if (error || !data.user) throw new HttpError(401, "Sign in to open your workspace.");
  return { auth, user: data.user };
}

export async function verifyCurrentPassword(userId: string, email: string, password: string) {
  const { url, key } = config();
  const check = createClient(url, key, {
    global: { headers: { "User-Agent": "Argus password verification" } },
    auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
  });
  // Older Auth servers can ignore updateUser's current_password field.
  const { data, error } = await check.auth.signInWithPassword({ email, password });
  if (error?.status === 429) throw new HttpError(429, "Too many attempts. Try again later.");
  if (data.session) {
    const revoked = await check.auth.signOut({ scope: "local" });
    if (revoked.error) throw revoked.error;
  }
  if (error || !data.session || data.user?.id !== userId) throw new HttpError(422, "Current password is incorrect.");
}

export function serviceClient() {
  const { url } = config();
  const secret = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!secret) throw new HttpError(503, "Supabase server credentials are not configured.");
  return createClient(url, secret, {
    auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
  });
}
