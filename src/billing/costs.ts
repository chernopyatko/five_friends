import type { BotMode } from "../llm/schemas.js";

export function resolveMessageCost(mode: BotMode): number {
  return mode === "PANEL" ? 3 : 1;
}
