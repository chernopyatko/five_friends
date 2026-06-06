import { describe, expect, it } from "vitest";

import { resolveModelPolicy } from "../../src/policy/modelPolicy.js";

describe("modelPolicy", () => {
  it("routes pending panel state to PANEL on gpt-5.5", () => {
    const result = resolveModelPolicy({
      userText: "любой текст",
      state: { pendingMode: "awaiting_panel_input" }
    });

    expect(result.mode).toBe("PANEL");
    expect(result.model).toBe("gpt-5.5");
  });

  it("routes forced panel mode to PANEL on gpt-5.5", () => {
    const result = resolveModelPolicy({
      userText: "любой текст",
      state: { pendingMode: null },
      forcedMode: "PANEL"
    });

    expect(result.mode).toBe("PANEL");
    expect(result.model).toBe("gpt-5.5");
  });

  it("routes forced summary mode to SUMMARY on gpt-5-mini", () => {
    const result = resolveModelPolicy({
      userText: "любой текст",
      state: { pendingMode: null },
      forcedMode: "SUMMARY"
    });

    expect(result.mode).toBe("SUMMARY");
    expect(result.model).toBe("gpt-5-mini");
  });

  it("routes summary trigger to SUMMARY on gpt-5-mini", () => {
    const result = resolveModelPolicy({
      userText: "сводка",
      state: { pendingMode: null }
    });

    expect(result.mode).toBe("SUMMARY");
    expect(result.model).toBe("gpt-5-mini");
  });

  it("routes Inna trigger to SUMMARY on gpt-5-mini", () => {
    const result = resolveModelPolicy({
      userText: "📌 Инна",
      state: { pendingMode: null }
    });

    expect(result.mode).toBe("SUMMARY");
    expect(result.model).toBe("gpt-5-mini");
  });

  it("keeps default SINGLE on gpt-5.4 when no escalation signals", () => {
    const result = resolveModelPolicy({
      userText: "мне просто грустно сегодня",
      state: { pendingMode: null },
      tokenEstimate: 150
    });

    expect(result.mode).toBe("SINGLE");
    expect(result.model).toBe("gpt-5.4");
    expect(result.needsEscalation).toBe(false);
  });

  it("escalates SINGLE to gpt-5.5 on high token count", () => {
    const result = resolveModelPolicy({
      userText: "подробно",
      state: { pendingMode: null },
      tokenEstimate: 900
    });

    expect(result.mode).toBe("SINGLE");
    expect(result.model).toBe("gpt-5.5");
    expect(result.reasons).toContain("TOKENS_HIGH");
  });

  it("escalates on low router confidence and never down-escalates PANEL", () => {
    const panelResult = resolveModelPolicy({
      userText: "все сразу",
      state: { pendingMode: null },
      routerDecision: {
        requested_mode: "SINGLE",
        requested_persona: "yan",
        safety_class: "none",
        emotional_intensity: "low",
        needs_escalation: false,
        confidence: 0.99,
        reasons: []
      }
    });
    expect(panelResult.mode).toBe("PANEL");
    expect(panelResult.model).toBe("gpt-5.5");

    const singleResult = resolveModelPolicy({
      userText: "хочу понять ситуацию",
      state: { pendingMode: null },
      routerDecision: {
        requested_mode: "SINGLE",
        requested_persona: "yan",
        safety_class: "none",
        emotional_intensity: "low",
        needs_escalation: false,
        confidence: 0.5,
        reasons: ["LOW_CONF"]
      }
    });
    expect(singleResult.mode).toBe("SINGLE");
    expect(singleResult.model).toBe("gpt-5.5");
    expect(singleResult.reasons).toContain("LOW_CONF");
  });

  it("accepts legacy panel trigger text", () => {
    const result = resolveModelPolicy({
      userText: "совет всех",
      state: { pendingMode: null }
    });

    expect(result.mode).toBe("PANEL");
    expect(result.model).toBe("gpt-5.5");
  });

  it("forces CRISIS fixed response on hard safety", () => {
    const result = resolveModelPolicy({
      userText: "мне небезопасно",
      state: { pendingMode: null },
      crisisHeuristicHard: true
    });

    expect(result.mode).toBe("CRISIS");
    expect(result.model).toBe("fixed");
    expect(result.safetyHold).toBe(true);
  });
});
