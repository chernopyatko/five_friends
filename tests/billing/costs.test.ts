import { describe, expect, it } from "vitest";

import { resolveMessageCost } from "../../src/billing/costs.js";

describe("billing costs", () => {
  it("uses PANEL=3 and default=1", () => {
    expect(resolveMessageCost("PANEL")).toBe(3);
    expect(resolveMessageCost("SINGLE")).toBe(1);
    expect(resolveMessageCost("SUMMARY")).toBe(1);
    expect(resolveMessageCost("CRISIS")).toBe(1);
  });
});
