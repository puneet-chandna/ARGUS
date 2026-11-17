import { sessionSettings } from "../../../lib/profile.ts";
import { authClient, reviewer } from "../../../lib/supabase.ts";
import { endpoint, HttpError, json, readJson } from "../../../lib/http.ts";

export const GET = endpoint(async () => {
  const signedIn = await reviewer().catch(error => {
    if (error instanceof HttpError && error.status === 401) return null;
    throw error;
  });
  return json(signedIn ? await sessionSettings(signedIn.auth, signedIn.user) : null);
});

export const POST = endpoint(async (request) => {
  const { email, password } = await readJson(request);
  if (typeof email !== "string" || email.length > 254 ||
      typeof password !== "string" || password.length > 1024 || !password) {
    throw new HttpError(400, "Enter your reviewer email and password.");
  }
  const auth = await authClient(request.headers.get("user-agent"));
  const { data, error } = await auth.auth.signInWithPassword({ email, password });
  if (error || !data.user) {
    if (error?.status === 429) throw new HttpError(429, "Too many sign-in attempts. Try again later.");
    throw new HttpError(401, "Could not sign in with those credentials.");
  }
  return json(await sessionSettings(auth, data.user));
});

export const DELETE = endpoint(async () => {
  const auth = await authClient();
  const { error } = await auth.auth.signOut({ scope: "local" });
  if (error && error.name !== "AuthSessionMissingError") throw error;
  return json({ signedOut: true });
});
