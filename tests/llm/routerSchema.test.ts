import { describe, expect, it } from "vitest";

import { parseRouterDecision, ROUTER_DECISION_SCHEMA } from "../../src/llm/routerSchema.js";

describe("routerSchema", () => {
  it("has strict JSON schema contract", () => {
    expect(ROUTER_DECISION_SCHEMA.type).toBe("object");
    expect(ROUTER_DECISION_SCHEMA.additionalProperties).toBe(false);
    expect(ROUTER_DECISION_SCHEMA.required).toEqual([
      "requested_mode",
      "requested_persona",
      "safety_class",
      "emotional_intensity",
      "needs_escalation",
      "confidence",
      "reasons"
    ]);
  });

  it("accepts valid router decision", () => {
    const decision = parseRouterDecision({
      requested_mode: "SINGLE",
      requested_persona: "yan",
      safety_class: "none",
      emotional_intensity: "medium",
      needs_escalation: false,
      confidence: 0.91,
      reasons: ["DEFAULT_SINGLE"]
    });

    expect(decision.requested_mode).toBe("SINGLE");
    expect(decision.confidence).toBe(0.91);
  });

  it("rejects additional properties", () => {
    expect(() =>
      parseRouterDecision({
        requested_mode: "SINGLE",
        requested_persona: "yan",
        safety_class: "none",
        emotional_intensity: "medium",
        needs_escalation: false,
        confidence: 0.91,
        reasons: ["DEFAULT_SINGLE"],
        extra: true
      })
    ).toThrow("unsupported key");
  });

  it("rejects out-of-range confidence", () => {
    expect(() =>
      parseRouterDecision({
        requested_mode: "SINGLE",
        requested_persona: "yan",
        safety_class: "none",
        emotional_intensity: "medium",
        needs_escalation: false,
        confidence: 1.4,
        reasons: ["LOW_CONF"]
      })
    ).toThrow("confidence");
  });
});
