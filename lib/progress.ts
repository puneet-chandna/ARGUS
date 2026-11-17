export type Stage = "uploading" | "reading" | "locating_rate_card" | "matching" |
  "resolving" | "verifying" | "complete" | "failed" | "cancelled";

export type RunProgress = {
  stage: Stage;
  status: "queued" | "processing" | "complete" | "failed" | "cancelled";
  pagesDone: number;
  pagesTotal: number | null;
  startedAt: string;
  stageStartedAt: string;
  updatedAt: string;
  page?: number;
  completedPages?: number[];
  cachedPages?: number[];
  partial?: { insurer?: string; vehicle?: string };
  estimatedSeconds?: number;
};

export type CacheCheck = {
  cache: "hit" | "partial" | "miss";
  pagesTotal: number | null;
  pagesCached: number;
  estimatedSeconds?: number;
};

export const stageLabels: Record<Stage, string> = {
  uploading: "Uploading PDF",
  reading: "Reading the policy",
  locating_rate_card: "Finding the rate card",
  matching: "Matching insurer and vehicle class",
  resolving: "Resolving commission and citing the grid cell",
  verifying: "Checking the citation against the source",
  complete: "Done",
  failed: "Couldn't finish analyzing this PDF",
  cancelled: "Analysis cancelled",
};

export function stageText(progress: RunProgress) {
  if (progress.stage !== "reading" || !progress.page || !progress.pagesTotal) return stageLabels[progress.stage];
  const cached = progress.cachedPages?.length;
  return `Reading page ${progress.page} of ${progress.pagesTotal}${cached ? ` (${cached} already analyzed)` : ""}`;
}

export function progressValue(progress: RunProgress) {
  switch (progress.stage) {
    case "uploading": return progress.status === "queued" ? 5 : 0;
    case "reading": return Math.min(70, 5 + Math.floor(65 * progress.pagesDone / (progress.pagesTotal || 1)));
    case "locating_rate_card": return 70;
    case "matching":
    case "resolving": return 80;
    case "verifying": return 97;
    case "complete": return 100;
    default: return 0;
  }
}

export function estimateSeconds(samples: number[], pages: number | null) {
  if (samples.length < 5 || !pages) return undefined;
  const sorted = [...samples].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return Math.ceil(pages * (sorted[middle] + sorted[Math.floor((sorted.length - 1) / 2)]) / 2);
}

export function estimateCopy(seconds: number) {
  if (seconds < 60) return `about ${Math.max(10, Math.round(seconds / 10) * 10)} seconds`;
  const minutes = Math.max(1, Math.round(seconds / 60));
  return `about ${minutes} to ${minutes + 1} minutes`;
}
