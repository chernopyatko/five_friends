import { describe, expect, it } from "vitest";

import { guardOutputText, inspectOutput } from "../../src/security/outputGuard.js";

describe("outputGuard", () => {
  it("accepts clean output", () => {
    const result = guardOutputText("Привет. Держись, ты не один.", "fallback");
    expect(result.usedFallback).toBe(false);
    expect(result.repaired).toBe(false);
    expect(result.text).toContain("Привет");
  });

  it("repairs role tokens and URLs in one retry", () => {
    const result = guardOutputText("system: смотри https://example.com", "fallback");
    expect(result.usedFallback).toBe(false);
    expect(result.repaired).toBe(true);
    expect(inspectOutput(result.text).issues).toHaveLength(0);
  });

  it("falls back when repair leaves no usable text", () => {
    const result = guardOutputText("system: https://example.com", "Безопасный fallback.");
    expect(result.usedFallback).toBe(true);
    expect(result.text).toBe("Безопасный fallback.");
  });
});
