import type { SupabaseClient, User } from "@supabase/supabase-js";
import { HttpError } from "./http.ts";
import { auditActions, personalDefaults, preferenceDefaults, type AuditEvent, type Session } from "./profile-settings.ts";

const PROFILE = "argus_profiles";
const PREFS = "argus_user_preferences";
const AUDIT = "argus_audit_events";
const personalColumns = "display_name,organization,time_zone,clock,avatar_revision";
const prefColumns = Object.keys(preferenceDefaults).join(",");
const auditColumns = "id,occurred_at,action,target,ocr_mode,status";

export async function accountSettings(client: SupabaseClient, user: User): Promise<Required<Session>> {
  const [{ data: personal, error }, { data: preferences, error: prefError }] = await Promise.all([
    client.from(PROFILE).select(personalColumns).eq("owner_id", user.id).maybeSingle<Session["personal"]>(),
    client.from(PREFS).select(prefColumns).eq("owner_id", user.id).maybeSingle<Session["preferences"]>(),
  ]);
  if (error || prefError) throw error || prefError;
  return { email: user.email ?? "", personal: personal ?? { ...personalDefaults, avatar_revision: null }, preferences: preferences ?? preferenceDefaults };
}

export async function sessionSettings(client: SupabaseClient, user: User): Promise<Session> {
  // A rolling deploy can sign in before the profile migration has been applied.
  return accountSettings(client, user).catch(() => ({ email: user.email ?? "" }));
}

export async function retentionAvailable(client: SupabaseClient) {
  if ((process.env.ARGUS_MAINTENANCE_SECRET?.length ?? 0) >= 32) return true;
  const { data, error } = await client.rpc("argus_maintenance_scheduled");
  if (error) throw error;
  return data === true;
}

function choice<T extends string | number | boolean | null>(value: unknown, values: readonly T[]): T {
  if (!values.some(item => item === value)) throw new HttpError(422, "Choose a supported setting.");
  return value as T;
}

export function personalInput(input: Record<string, unknown>) {
  const name = (field: string, max: number) => {
    const value = input[field];
    if (typeof value !== "string" || [...value.trim()].length > max || /\p{Cc}/u.test(value)) {
      throw new HttpError(422, `Enter ${field === "display_name" ? "a display name" : "an organization"} of up to ${max} characters.`);
    }
    return value.trim();
  };
  const zone = input.time_zone;
  if (typeof zone !== "string" || zone.length > 100) throw new HttpError(422, "Enter a valid time zone.");
  try { new Intl.DateTimeFormat("en", { timeZone: zone }); }
  catch { throw new HttpError(422, "Enter a valid time zone."); }
  return { display_name: name("display_name", 80), organization: name("organization", 120),
    time_zone: zone, clock: choice(input.clock, ["24", "12"] as const) };
}

export function preferenceInput(input: Record<string, unknown>) {
  return {
    appearance: choice(input.appearance, ["light", "dark", "system"] as const),
    density: choice(input.density, ["comfortable", "compact"] as const),
    landing: choice(input.landing, ["new", "last"] as const),
    decision_filter: choice(input.decision_filter, ["all", "resolved", "ambiguous", "unsupported"] as const),
    decimals: choice(input.decimals, [1, 2] as const), percent_sign: choice(input.percent_sign, [true, false]),
  };
}

export function dataInput(input: Record<string, unknown>, scheduled: boolean) {
  const delete_originals = choice(input.delete_originals, [true, false]);
  if (!scheduled) {
    if (input.retention_days != null) throw new HttpError(409, "Timed retention is not available on this deployment.");
    return { delete_originals };
  }
  return { retention_days: choice(input.retention_days, [null, 30, 90, 365] as const), delete_originals };
}

export function providerLabel(provider: string | undefined, methods: unknown) {
  if (Array.isArray(methods) && methods.some(method => typeof method === "object" && method?.method === "password")) {
    return { provider: "Email and password", password: true };
  }
  if (provider === "email") return { provider: "Email", password: false };
  if (!provider) return { provider: "Unknown", password: false };
  return { provider: provider.charAt(0).toUpperCase() + provider.slice(1), password: false };
}

export type SessionRow = { id: string; user_agent: string | null; last_active: string; current_device: boolean };
export function activityFilters(params: URLSearchParams) {
  const action = params.get("action") || "";
  if (action && !Object.hasOwn(auditActions, action)) throw new HttpError(422, "Choose a valid activity type.");
  const day = (key: string) => {
    const value = params.get(key);
    if (!value) return null;
    const date = new Date(`${value}T00:00:00Z`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
      throw new HttpError(422, "Choose a valid UTC date.");
    }
    if (key === "end") date.setUTCDate(date.getUTCDate() + 1);
    return date.toISOString();
  };
  const start = day("start");
  const end = day("end");
  if (start && end && start >= end) throw new HttpError(422, "The end date must be on or after the start date.");
  return { action, start, end };
}

export function eventsQuery(client: SupabaseClient, owner: string, filters: ReturnType<typeof activityFilters>, exact = false) {
  let query = client.from(AUDIT).select(auditColumns, exact ? { count: "exact" } : undefined).eq("owner_id", owner);
  if (filters.action) query = query.eq("action", filters.action);
  if (filters.start) query = query.gte("occurred_at", filters.start);
  if (filters.end) query = query.lt("occurred_at", filters.end);
  return query.order("occurred_at", { ascending: false }).order("id", { ascending: false });
}

export function profileStore(client: SupabaseClient, owner: string) {
  return {
    async save(part: "personal" | "preferences" | "data", fields: Record<string, unknown>) {
      const values = part === "personal" ? personalInput(fields) : part === "preferences" ? preferenceInput(fields) : dataInput(fields, await retentionAvailable(client));
      const { error } = await client.from(part === "personal" ? PROFILE : PREFS).upsert({ ...values, owner_id: owner }, { defaultToNull: false });
      if (error) throw error;
    },
    async avatar() {
      const { data, error } = await client.from(PROFILE).select("avatar_type,avatar_data").eq("owner_id", owner).maybeSingle();
      if (error) throw error;
      return data;
    },
    async saveAvatar(type: "image/png" | "image/jpeg" | null, encoded: string | null) {
      const revision = type ? crypto.randomUUID() : null;
      const { error } = await client.from(PROFILE).upsert({
        owner_id: owner, avatar_type: type, avatar_data: encoded, avatar_revision: revision,
      }, { defaultToNull: false });
      if (error) throw error;
      return revision;
    },
    async stats() {
      const cutoff = new Date(Date.now() - 30 * 86_400_000).toISOString();
      const queries = [null, "resolved", "ambiguous", "unsupported"].map(decision => {
        const query = client.from("argus_runs").select("id", { count: "exact", head: true }).eq("owner_id", owner)
          .gte("created_at", cutoff).in("status", ["complete", "failed"]).is("deleting_at", null);
        return decision ? query.filter("result->>status", "eq", decision) : query;
      });
      const rows = await Promise.all(queries);
      for (const row of rows) if (row.error) throw row.error;
      return rows.map(row => row.count ?? 0);
    },
    async events(filters: ReturnType<typeof activityFilters>, page: number, size: number) {
      const { data, count, error } = await eventsQuery(client, owner, filters, true).range(page * size, (page + 1) * size - 1);
      if (error) throw error;
      return { events: data as AuditEvent[], count: count ?? 0 };
    },
    async logExport(target: string, action: "exported" | "exported_activity" | "exported_data") {
      const { error } = await client.from(AUDIT).insert({ owner_id: owner, action, target, status: "success" });
      if (error) throw error;
    },
  };
}
