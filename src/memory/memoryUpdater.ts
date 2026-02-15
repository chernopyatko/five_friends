import { extractLongTermCandidates, type LongTermMemory, type MiniApiClient as LongTermClient } from "./longTermMemory.js";
import { updateRollingSummary, type MiniApiClient as SessionClient, type SessionTurn } from "./sessionMemory.js";

export interface MemoryUpdateInput {
  existingSummary: string;
  recentMessages: SessionTurn[];
}

export interface MemoryUpdateResult {
  rollingSummary: string;
  longTerm: LongTermMemory[];
}

type MemoryClient = SessionClient & LongTermClient;

export async function runMemoryUpdate(
  client: MemoryClient,
  input: MemoryUpdateInput
): Promise<MemoryUpdateResult> {
  const rollingSummary = await updateRollingSummary(client, {
    existingSummary: input.existingSummary,
    recentMessages: input.recentMessages
  });

  const longTerm = await extractLongTermCandidates(client, {
    rollingSummary,
    recentMessages: input.recentMessages
  });

  return {
    rollingSummary,
    longTerm
  };
}
