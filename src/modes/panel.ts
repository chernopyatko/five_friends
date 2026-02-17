const PANEL_HEADERS = [
  "🧠 Ян — Разум",
  "❤️ Наташа — Сердце",
  "🌀 Аня — Смысл",
  "🧱 Макс — Реальность"
] as const;

export const TELEGRAM_SAFE_LIMIT = 3900;

export function validatePanelFormat(text: string): { valid: boolean; reason?: string } {
  const normalized = text.trim();
  if (!normalized) {
    return { valid: false, reason: "EMPTY" };
  }

  let cursor = 0;
  for (const header of PANEL_HEADERS) {
    const nextIndex = normalized.indexOf(header, cursor);
    if (nextIndex === -1) {
      return { valid: false, reason: `MISSING_${header}` };
    }
    if (nextIndex < cursor) {
      return { valid: false, reason: "WRONG_ORDER" };
    }
    cursor = nextIndex + header.length;
  }

  return { valid: true };
}

export function splitMessage(text: string, limit: number = TELEGRAM_SAFE_LIMIT): string[] {
  const normalized = text.trim();
  if (!normalized) {
    return [""];
  }

  if (normalized.length <= limit) {
    return [normalized];
  }

  const chunks: string[] = [];
  let remainder = normalized;

  while (remainder.length > limit && chunks.length < 2) {
    const candidate = remainder.slice(0, limit);
    const splitAt = Math.max(candidate.lastIndexOf("\n\n"), candidate.lastIndexOf("\n"), candidate.lastIndexOf(" "));
    const index = splitAt > 0 ? splitAt : limit;
    chunks.push(remainder.slice(0, index).trim());
    remainder = remainder.slice(index).trim();
  }

  if (remainder.length > limit) {
    chunks.push(remainder.slice(0, limit).trim());
    remainder = remainder.slice(limit).trim();
  }

  if (remainder) {
    chunks.push(remainder);
  }

  return chunks.filter((part) => part.length > 0).slice(0, 3);
}
