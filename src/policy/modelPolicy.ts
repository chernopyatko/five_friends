import type { BotMode } from "../llm/schemas.js";
import type { RouterDecision } from "../llm/routerSchema.js";

type PendingMode = "awaiting_panel_input" | "awaiting_summary_input" | null;

export interface ModelPolicyInput {
  userText: string;
  state: {
    pendingMode: PendingMode;
  };
  routerDecision?: RouterDecision | null;
  tokenEstimate?: number;
  crisisHeuristicHard?: boolean;
  safetyHeuristicSoft?: boolean;
}

export interface ModelPolicyResult {
  mode: BotMode;
  model: "gpt-5.2" | "gpt-5.1" | "gpt-5-mini" | "fixed";
  needsEscalation: boolean;
  safetyHold: boolean;
  reasons: string[];
}

const PANEL_TRIGGERS = ["все сразу", "совет всех", "позвать всех"];
const SUMMARY_TRIGGERS = ["сводка", "инна"];
const HIGH_IMPORTANCE_MARKERS = ["очень важно", "срочно", "помоги сформулировать", "разложи по полочкам"];
const CONFLICT_MARKERS = ["не знаю что делать", "меня разрывает", "я на грани"];

export function resolveModelPolicy(input: ModelPolicyInput): ModelPolicyResult {
  const normalizedText = normalize(input.userText);
  const reasons: string[] = [];

  if (input.crisisHeuristicHard === true || input.routerDecision?.safety_class === "hard") {
    reasons.push("SAFETY_HARD");
    return {
      mode: "CRISIS",
      model: "fixed",
      needsEscalation: false,
      safetyHold: true,
      reasons
    };
  }

  if (input.state.pendingMode === "awaiting_panel_input") {
    reasons.push("PENDING_PANEL");
    return {
      mode: "PANEL",
      model: "gpt-5.2",
      needsEscalation: true,
      safetyHold: false,
      reasons
    };
  }

  if (input.state.pendingMode === "awaiting_summary_input") {
    reasons.push("PENDING_SUMMARY");
    return {
      mode: "SUMMARY",
      model: "gpt-5-mini",
      needsEscalation: false,
      safetyHold: false,
      reasons
    };
  }

  if (isExplicitTrigger(normalizedText, PANEL_TRIGGERS)) {
    reasons.push("TRIGGER_PANEL");
    return {
      mode: "PANEL",
      model: "gpt-5.2",
      needsEscalation: true,
      safetyHold: false,
      reasons
    };
  }

  if (isExplicitTrigger(normalizedText, SUMMARY_TRIGGERS)) {
    reasons.push("TRIGGER_SUMMARY");
    return {
      mode: "SUMMARY",
      model: "gpt-5-mini",
      needsEscalation: false,
      safetyHold: false,
      reasons
    };
  }

  let model: ModelPolicyResult["model"] = "gpt-5.1";
  let needsEscalation = false;

  if ((input.tokenEstimate ?? 0) >= 850) {
    needsEscalation = true;
    reasons.push("TOKENS_HIGH");
  }
  if (containsAny(normalizedText, HIGH_IMPORTANCE_MARKERS)) {
    needsEscalation = true;
    reasons.push("IMPORTANCE_HIGH");
  }
  if (containsAny(normalizedText, CONFLICT_MARKERS)) {
    needsEscalation = true;
    reasons.push("CONFLICT_HIGH");
  }

  if (input.routerDecision?.emotional_intensity === "high") {
    needsEscalation = true;
    reasons.push("EMO_HIGH");
  }

  if (input.safetyHeuristicSoft === true || input.routerDecision?.safety_class === "soft") {
    needsEscalation = true;
    reasons.push("SAFETY_SOFT");
  }

  if ((input.routerDecision?.confidence ?? 1) < 0.75) {
    needsEscalation = true;
    reasons.push("LOW_CONF");
  }

  if (
    input.routerDecision &&
    input.routerDecision.requested_mode !== "SINGLE" &&
    input.routerDecision.requested_mode !== "SUMMARY"
  ) {
    needsEscalation = true;
    reasons.push("SIGNAL_CONFLICT");
  }

  if (input.routerDecision?.needs_escalation === true) {
    needsEscalation = true;
    reasons.push("ROUTER_ESCALATE");
  }

  if (needsEscalation) {
    model = "gpt-5.2";
  }

  return {
    mode: "SINGLE",
    model,
    needsEscalation,
    safetyHold: false,
    reasons
  };
}

function normalize(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

function isExplicitTrigger(text: string, triggers: readonly string[]): boolean {
  if (!text) {
    return false;
  }
  const words = text.split(" ").filter(Boolean);
  if (words.length > 7) {
    return false;
  }
  return triggers.some((trigger) => text.includes(trigger));
}

function containsAny(text: string, markers: readonly string[]): boolean {
  return markers.some((marker) => text.includes(marker));
}
