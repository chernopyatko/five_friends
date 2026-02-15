export interface TokenCountInput {
  instructions?: string;
  userMessage?: string;
  memoryBlock?: string;
  history?: string[];
}

const AVG_CHARS_PER_TOKEN = 4;

export function estimateTokenCount(text: string): number {
  const normalized = text.trim();
  if (!normalized) {
    return 0;
  }

  // Conservative rough estimate suitable for policy routing decisions.
  return Math.ceil(normalized.length / AVG_CHARS_PER_TOKEN);
}

export function estimateTotalTokens(input: TokenCountInput): number {
  let total = 0;
  if (input.instructions) {
    total += estimateTokenCount(input.instructions);
  }
  if (input.userMessage) {
    total += estimateTokenCount(input.userMessage);
  }
  if (input.memoryBlock) {
    total += estimateTokenCount(input.memoryBlock);
  }
  if (input.history?.length) {
    for (const chunk of input.history) {
      total += estimateTokenCount(chunk);
    }
  }
  return total;
}
