import { pino, type Logger as PinoLogger } from "pino";

type LogValue = string | number | boolean | null | undefined;

export interface SafeLogPayload {
  requestId?: string;
  userHash?: string;
  mode?: string;
  latencyMs?: number;
  outcome?: string;
  safetyClass?: string;
  details?: Record<string, LogValue>;
}

export function createLogger(logLevel: string = process.env.LOG_LEVEL ?? "info"): PinoLogger {
  return pino({
    level: logLevel,
    base: undefined
  });
}

export function toSafeLog(payload: SafeLogPayload): Record<string, LogValue | Record<string, LogValue>> {
  const details = payload.details ?? {};
  const sanitizedDetails = sanitizeDetails(details);

  return {
    request_id: payload.requestId,
    user_hash: payload.userHash,
    mode: payload.mode,
    latency_ms: payload.latencyMs,
    outcome: payload.outcome,
    safety_class: payload.safetyClass,
    details: sanitizedDetails
  };
}

function sanitizeDetails(details: Record<string, LogValue>): Record<string, LogValue> {
  const blockedKeys = new Set(["text", "userText", "message", "rawOutput", "prompt"]);
  const result: Record<string, LogValue> = {};
  for (const [key, value] of Object.entries(details)) {
    if (blockedKeys.has(key)) {
      continue;
    }
    result[key] = value;
  }
  return result;
}
