import type { BotMode, Persona } from "./schemas.js";

export type SafetyClass = "none" | "soft" | "hard";
export type EmotionalIntensity = "low" | "medium" | "high";

export interface RouterDecision {
  requested_mode: BotMode;
  requested_persona: Persona | null;
  safety_class: SafetyClass;
  emotional_intensity: EmotionalIntensity;
  needs_escalation: boolean;
  confidence: number;
  reasons: string[];
}

export const ROUTER_DECISION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "requested_mode",
    "requested_persona",
    "safety_class",
    "emotional_intensity",
    "needs_escalation",
    "confidence",
    "reasons"
  ],
  properties: {
    requested_mode: { type: "string", enum: ["SINGLE", "PANEL", "SUMMARY", "CRISIS"] },
    requested_persona: {
      anyOf: [
        { type: "string", enum: ["yan", "natasha", "anya", "max", "inna"] },
        { type: "null" }
      ]
    },
    safety_class: { type: "string", enum: ["none", "soft", "hard"] },
    emotional_intensity: { type: "string", enum: ["low", "medium", "high"] },
    needs_escalation: { type: "boolean" },
    confidence: { type: "number", minimum: 0, maximum: 1 },
    reasons: {
      type: "array",
      items: { type: "string", minLength: 1 },
      maxItems: 12
    }
  }
} as const;

const VALID_MODES: readonly BotMode[] = ["SINGLE", "PANEL", "SUMMARY", "CRISIS"];
const VALID_PERSONAS: readonly Persona[] = ["yan", "natasha", "anya", "max", "inna"];
const VALID_SAFETY_CLASSES: readonly SafetyClass[] = ["none", "soft", "hard"];
const VALID_EMOTIONAL_INTENSITY: readonly EmotionalIntensity[] = ["low", "medium", "high"];

export function parseRouterDecision(input: unknown): RouterDecision {
  if (!isRecord(input)) {
    throw new Error("Router decision must be an object.");
  }

  const allowedKeys = new Set([
    "requested_mode",
    "requested_persona",
    "safety_class",
    "emotional_intensity",
    "needs_escalation",
    "confidence",
    "reasons"
  ]);
  for (const key of Object.keys(input)) {
    if (!allowedKeys.has(key)) {
      throw new Error(`Router decision has unsupported key: ${key}`);
    }
  }

  const requested_mode = input.requested_mode;
  if (!isOneOf(requested_mode, VALID_MODES)) {
    throw new Error("requested_mode is invalid.");
  }

  const requested_persona = input.requested_persona;
  if (requested_persona !== null && !isOneOf(requested_persona, VALID_PERSONAS)) {
    throw new Error("requested_persona is invalid.");
  }

  const safety_class = input.safety_class;
  if (!isOneOf(safety_class, VALID_SAFETY_CLASSES)) {
    throw new Error("safety_class is invalid.");
  }

  const emotional_intensity = input.emotional_intensity;
  if (!isOneOf(emotional_intensity, VALID_EMOTIONAL_INTENSITY)) {
    throw new Error("emotional_intensity is invalid.");
  }

  const needs_escalation = input.needs_escalation;
  if (typeof needs_escalation !== "boolean") {
    throw new Error("needs_escalation must be boolean.");
  }

  const confidence = input.confidence;
  if (typeof confidence !== "number" || Number.isNaN(confidence) || confidence < 0 || confidence > 1) {
    throw new Error("confidence must be number in range [0,1].");
  }

  const reasons = input.reasons;
  if (!Array.isArray(reasons) || reasons.some((reason) => typeof reason !== "string" || !reason.trim())) {
    throw new Error("reasons must be an array of non-empty strings.");
  }

  return {
    requested_mode,
    requested_persona,
    safety_class,
    emotional_intensity,
    needs_escalation,
    confidence,
    reasons
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isOneOf<T extends string>(value: unknown, options: readonly T[]): value is T {
  return typeof value === "string" && options.includes(value as T);
}
