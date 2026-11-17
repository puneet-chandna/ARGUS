import { endpoint, HttpError, json, readJson } from "../../../lib/http.ts";
import { accountSettings, activityFilters, profileStore, providerLabel, retentionAvailable } from "../../../lib/profile.ts";
import { runStore } from "../../../lib/runs.ts";
import { reviewer, serviceClient, verifyCurrentPassword } from "../../../lib/supabase.ts";
import { uuid } from "../../../lib/upload.ts";

export const GET = endpoint(async (request) => {
  const { auth, user } = await reviewer();
  const query = new URL(request.url).searchParams;
  const store = profileStore(auth, user.id);
  const view = query.get("view");
  if (view === "activity") {
    const pageNumber = (key: string) => {
      const value = Number(query.get(key) ?? 0);
      return Number.isSafeInteger(value) && value >= 0 && value < 100_000 ? value : 0;
    };
    const [activity, approvals] = await Promise.all([
      store.events(activityFilters(query), pageNumber("page"), 20),
      store.events({ action: "ocr_approved", start: null, end: null }, pageNumber("approvalPage"), 10),
    ]);
    return json({ activity, approvals });
  }
  if (view === "security") {
    const [claims, sessions] = await Promise.all([auth.auth.getClaims(), auth.rpc("argus_my_sessions")]);
    if (claims.error) throw claims.error;
    if (sessions.error) throw sessions.error;
    return json({ ...providerLabel(user.app_metadata.provider, claims.data?.claims.amr), sessions: sessions.data });
  }
  const [settings, stats] = await Promise.all([
    accountSettings(auth, user), view === "account" ? store.stats() : Promise.resolve(null),
  ]);
  return json({ ...settings, stats, memberSince: user.created_at, verified: Boolean(user.email_confirmed_at),
    timedRetention: view === "data" && await retentionAvailable(serviceClient()) });
});

export const PATCH = endpoint(async (request) => {
  const { user, auth } = await reviewer();
  const input = await readJson(request);
  if (input.part === "personal" || input.part === "preferences" || input.part === "data") {
    await profileStore(serviceClient(), user.id).save(input.part, input);
    return json(await accountSettings(auth, user));
  }
  if (input.part === "password") {
    const { data, error } = await auth.auth.getClaims();
    if (error) throw error;
    if (!providerLabel(user.app_metadata.provider, data?.claims.amr).password) {
      throw new HttpError(403, "This session does not use a password.");
    }
    const { current, password, confirm } = input;
    if (typeof current !== "string" || !current || Buffer.byteLength(current) > 1024 || typeof password !== "string" ||
        password.length < 8 || Buffer.byteLength(password) > 72 || password !== confirm || password === current) {
      throw new HttpError(422, "Enter your current password and a different matching password of 8–72 bytes.");
    }
    if (!user.email) throw new HttpError(403, "This account has no email password.");
    await verifyCurrentPassword(user.id, user.email, current);
    const result = await auth.auth.updateUser({ current_password: current, password });
    if (result.error) {
      if (result.error.status === 429) throw new HttpError(429, "Too many attempts. Try again later.");
      if (result.error.code === "reauthentication_needed") throw new HttpError(409, "Sign out and back in before changing your password.");
      throw new HttpError(422, "Password change failed. Check your current password and choose a stronger new one.");
    }
    return json({ saved: true });
  }
  if (input.part === "revoke") {
    if (input.target === "others") {
      const { error } = await auth.auth.signOut({ scope: "others" });
      if (error) throw error;
    } else {
      if (typeof input.target !== "string" || !uuid(input.target)) throw new HttpError(422, "Choose an active session.");
      const { data, error } = await auth.rpc("argus_revoke_my_session", { target: input.target });
      if (error) throw error;
      if (!data) throw new HttpError(404, "Session not found.");
    }
    return json({ signedOut: true });
  }
  throw new HttpError(400, "Unknown profile setting.");
});

export const DELETE = endpoint(async (request) => {
  const { auth, user } = await reviewer();
  const { target, confirmation } = await readJson(request);
  if ((target !== "runs" && target !== "account") || confirmation !== "DELETE") {
    throw new HttpError(422, "Type DELETE to confirm.");
  }
  const client = serviceClient();
  await runStore(client, user.id).removeAll();
  if (target === "account") {
    const { error } = await client.auth.admin.deleteUser(user.id);
    if (error) throw new HttpError(503, "Saved runs were removed, but account deletion could not finish. Try again.");
    await auth.auth.signOut({ scope: "local" }).catch(() => {});
  }
  return json({ deleted: target });
});
