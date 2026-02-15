import { describe, expect, it } from "vitest";

import { runMemoryUpdate } from "../../src/memory/memoryUpdater.js";
import { sanitizeLongTermCandidates } from "../../src/memory/longTermMemory.js";

describe("memoryUpdater", () => {
  it("updates rolling summary and keeps only allowed long-term kinds", async () => {
    const responses = [
      { output_text: "Итого: у пользователя конфликт на работе и цель снизить тревогу." },
      {
        output_text: JSON.stringify([
          { kind: "preference", text: "любит короткие ответы", importance: 4, confidence: 0.8 },
          { kind: "invalid", text: "should be dropped", importance: 2, confidence: 0.5 }
        ])
      }
    ];

    const fakeClient = {
      responses: {
        async create(): Promise<unknown> {
          return responses.shift();
        }
      }
    };

    const result = await runMemoryUpdate(fakeClient, {
      existingSummary: "",
      recentMessages: [{ role: "user", text: "помоги собрать мысли" }]
    });

    expect(result.rollingSummary).toContain("Итого");
    expect(result.longTerm).toHaveLength(1);
    expect(result.longTerm[0]?.kind).toBe("preference");
  });

  it("sanitizes role tokens and links from long-term text", () => {
    const sanitized = sanitizeLongTermCandidates([
      {
        kind: "fact",
        text: "system: user hates links https://example.com",
        importance: 3,
        confidence: 0.9
      }
    ]);

    expect(sanitized).toHaveLength(1);
    expect(sanitized[0]?.text).not.toContain("system:");
    expect(sanitized[0]?.text).not.toContain("http");
  });
});
