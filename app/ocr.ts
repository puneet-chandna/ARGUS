import type { OcrMode } from "../lib/ocr-status";

const reasons: Record<Exclude<OcrMode["live"], "ready">, string> = {
  ocr_disabled: "Live OCR is turned off for this workspace.",
  zero_spend_access_unverified: "The operator still needs to verify zero-spend access for both readers.",
  ocr_not_configured: "Live OCR credentials need to be configured.",
  ocr_invalid_endpoint: "The live OCR endpoint needs to be corrected.",
  quota_budget_exhausted: "An OCR reader has no remaining quota.",
  quota_not_configured: "The quota for live OCR could not be verified.",
};

export function ocrDescription(mode: OcrMode) {
  if (mode.live === "ready") {
    return { title: "Live OCR available", detail: "Cloud readings require your approval for each PDF." };
  }
  return {
    title: mode.cache ? "Cached OCR only" : "OCR unavailable",
    detail: mode.cache
      ? `${reasons[mode.live]} Only pages with matching cached readings can be rated.`
      : `${reasons[mode.live]} You can save the original PDF and open it from history.`,
  };
}

export function readerNotice(failures: Record<string, Record<string, string>> = {}) {
  const pages = Object.values(failures);
  if (!pages.length) return;
  const codes = new Set(pages.flatMap(Object.values));
  const prefix = pages.length === 1 ? "One page is missing an independent reading." : `${pages.length} pages are missing an independent reading.`;
  const configuredReasons = Object.entries(reasons).filter(([reason]) => codes.has(reason)).map(([, label]) => label);
  if (codes.has("cloud_not_authorized")) configuredReasons.push("This upload used cache only. No compatible readings were found for those pages.");
  if (codes.has("provider_timeout")) configuredReasons.push("A reader timed out.");
  if (codes.has("provider_unreachable")) configuredReasons.push("A reader could not be reached.");
  if (codes.has("invalid_provider_response")) configuredReasons.push("A reader returned a response Argus could not verify.");
  if (!configuredReasons.length) configuredReasons.push("A reader did not return usable evidence. Review the policy facts below.");
  return [prefix, ...configuredReasons].join(" ");
}
