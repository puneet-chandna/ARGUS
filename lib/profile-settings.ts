export const profilePaths = {
  account: "Account", preferences: "Preferences", security: "Security", activity: "Activity", data: "Data & privacy",
} as const;
export type ProfileSection = keyof typeof profilePaths;

export const runHash = /^#[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
export function workspaceReturn(value: string | null | undefined) {
  if (!value) return "/workspace";
  const [path, hash, ...rest] = value.split("#");
  if (rest.length || (path !== "/workspace" && path !== "/workspace?new=1")) return "/workspace";
  return hash && runHash.test(`#${hash}`) ? `/workspace#${hash}` : path;
}

export const personalDefaults = { display_name: "", organization: "", time_zone: null as string | null, clock: "24" as "24" | "12" };
export const preferenceDefaults = {
  appearance: "light" as "light" | "dark" | "system",
  density: "comfortable" as "comfortable" | "compact",
  landing: "new" as "new" | "last",
  decision_filter: "all" as "all" | "resolved" | "ambiguous" | "unsupported",
  decimals: 1 as 1 | 2,
  percent_sign: true,
  retention_days: null as null | 30 | 90 | 365,
  delete_originals: false,
};
export type Personal = typeof personalDefaults;
export type Preferences = typeof preferenceDefaults;
export type Session = {
  email: string;
  personal?: Personal & { avatar_revision: string | null };
  preferences?: Preferences;
};
export const auditActions = {
  signed_in: "Signed in", analyzed: "Analyzed policy", ocr_approved: "Approved external OCR", exported: "Exported run", exported_activity: "Exported activity", exported_data: "Exported personal data", deleted: "Deleted run",
} as const;

export type AuditEvent = {
  id: number; occurred_at: string; action: keyof typeof auditActions; target: string | null;
  ocr_mode: "external" | "local" | null; status: "success" | "failed" | "resolved" | "ambiguous" | "unsupported";
};

export function profileDate(value: string, personal?: Personal, dateOnly = false) {
  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric", month: "short", ...(dateOnly ? { year: "numeric" } : { hour: "2-digit", minute: "2-digit", hour12: personal?.clock === "12" }),
    timeZone: personal?.time_zone || undefined,
  }).format(new Date(value));
}

export function commissionLabel(rate: number | string, prefs?: Preferences) {
  const number = typeof rate === "number" ? rate : Number(rate);
  return `${prefs && Number.isFinite(number) ? number.toFixed(prefs.decimals) : rate}${prefs?.percent_sign === false ? "" : "%"}`;
}
