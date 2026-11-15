export type Facts = Record<string, string>;
export type Source = { file: string; page?: number; row?: string; sheet?: string; cells?: string };
export type TraceStep = { step: string; sources: Source[] };
export type Status = "resolved" | "unsupported" | "ambiguous";
export type Component = {
  applicable: boolean | null;
  rate: string | null;
  status: Status | "inapplicable";
  reason: string;
};
export type Parts = { od: Component; tp: Component; trace: TraceStep[]; review_fields?: readonly string[] };
export type RatingResult = Parts & {
  status: Status;
  rule_version: string;
  business_type: string | null;
  confidence: { level: "low" | "high"; reason: string };
};

export const tidy = (value = "") => value.toLowerCase().match(/[a-z0-9]+/g)?.join(" ") ?? "";
export const rtoCode = (value = "") => value.toUpperCase().replace(/[\s-]+/g, "");
export const validRto = (value: string) => /^[A-Z]{2}[0-9]{1,2}[A-Z]?$/.test(value);
export const integer = (value = "") => /^\d{1,5}$/.test(value.trim()) ? Number(value) : null;

export function component(
  status: Component["status"], reason: string, rate: string | null = null, applicable: boolean | null = status !== "inapplicable",
): Component {
  return { status, reason, rate, applicable };
}

export function policyCoverage(value = "") {
  const label = tidy(value);
  if (["tp", "third party"].includes(label)
      || /\b(?:satp|stp|sa tp|third party only|liability only|stand ?alone tp|stand ?alone third party)\b/.test(label)) return "satp";
  if (/\b(?:comprehensive|package)\b/.test(label)) return "comprehensive";
  if (/\b(?:saod|stand ?alone (?:own damage|od))\b/.test(label)) return "saod";
  return "";
}
