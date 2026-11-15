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

export async function authClient() {
  const { url, key } = config();
  const jar = await cookies();
  return createServerClient(url, key, {
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

export function serviceClient() {
  const { url } = config();
  const secret = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!secret) throw new HttpError(503, "Supabase server credentials are not configured.");
  return createClient(url, secret, {
    auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
  });
}
