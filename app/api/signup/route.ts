import { endpoint, HttpError, json, readJson, requestOrigin } from "../../../lib/http.ts";
import { authClient } from "../../../lib/supabase.ts";

export const POST = endpoint(async (request) => {
  const { email, password } = await readJson(request);
  const address = typeof email === "string" ? email.trim() : "";
  if (!address || address.length > 254 || typeof password !== "string" ||
      password.length < 8 || password.length > 72) {
    throw new HttpError(400, "Enter your email and a password between 8 and 72 characters.");
  }
  const auth = await authClient(request.headers.get("user-agent"));
  const { data, error } = await auth.auth.signUp({
    email: address, password, options: { emailRedirectTo: new URL("/auth/confirm", requestOrigin(request)).href },
  });
  if (error?.status === 429) throw new HttpError(429, "Too many sign-up attempts. Try again later.");
  if (error?.code === "signup_disabled") throw new HttpError(403, "Account creation is disabled. Ask the workspace owner for access.");
  if (error?.code === "weak_password") throw new HttpError(400, "Choose a stronger password and try again.");
  if (error?.code === "user_already_exists") return json({ confirmationRequired: true });
  if (error || !data.user) {
    throw new HttpError(400, "Could not create an account. Check your email and password or contact the workspace owner.");
  }
  return data.session ? json({ email: data.user.email }, 201) : json({ confirmationRequired: true }, 202);
});
