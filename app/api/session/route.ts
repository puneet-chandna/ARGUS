import { authClient, reviewer } from "../../../lib/supabase.ts";
import { endpoint, HttpError, json, readJson } from "../../../lib/http.ts";

export const GET = endpoint(async () => {
  const { user } = await reviewer();
  return json({ email: user.email });
});

export const POST = endpoint(async (request) => {
  const { email, password } = await readJson(request);
  if (typeof email !== "string" || email.length > 254 ||
      typeof password !== "string" || password.length > 1024 || !password) {
    throw new HttpError(400, "Enter your reviewer email and password.");
  }
  const auth = await authClient();
  const { data, error } = await auth.auth.signInWithPassword({ email, password });
  if (error || !data.user) {
    if (error?.status === 429) throw new HttpError(429, "Too many sign-in attempts. Try again later.");
    throw new HttpError(401, "Could not sign in with those credentials.");
  }
  return json({ email: data.user.email });
});

export const DELETE = endpoint(async () => {
  const auth = await authClient();
  const { error } = await auth.auth.signOut({ scope: "local" });
  if (error && error.name !== "AuthSessionMissingError") throw error;
  return json({ signedOut: true });
});
