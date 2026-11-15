export type OcrMode = {
  live: "ready" | "ocr_disabled" | "zero_spend_access_unverified" | "ocr_not_configured" |
    "ocr_invalid_endpoint" | "quota_budget_exhausted" | "quota_not_configured";
  cache: boolean;
};
