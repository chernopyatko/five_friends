const SUMMARY_HEADER = "📋 Сводка";

export function formatSummaryResponse(body: string): string {
  const normalized = body.trim();
  if (!normalized) {
    throw new Error("Summary body must not be empty.");
  }
  if (normalized.startsWith(SUMMARY_HEADER)) {
    return normalized;
  }
  return `${SUMMARY_HEADER}\n${normalized}`;
}
