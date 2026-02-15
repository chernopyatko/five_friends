import { describe, expect, it } from "vitest";

import { estimateTokenCount, estimateTotalTokens } from "../../src/utils/tokenCount.js";

describe("tokenCount", () => {
  it("returns 0 for empty text", () => {
    expect(estimateTokenCount("   ")).toBe(0);
  });

  it("estimates tokens from text length", () => {
    expect(estimateTokenCount("1234")).toBe(1);
    expect(estimateTokenCount("12345")).toBe(2);
  });

  it("aggregates token estimates across blocks", () => {
    const total = estimateTotalTokens({
      instructions: "aaaa",
      userMessage: "bbbb",
      memoryBlock: "cccc",
      history: ["dddd", "eeee"]
    });
    expect(total).toBe(5);
  });
});
