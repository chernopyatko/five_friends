export type Persona = "yan" | "natasha" | "anya" | "max";
export type PendingMode =
  | "awaiting_panel_input"
  | "awaiting_compose_input"
  | "awaiting_reply_input"
  | null;

export interface LastModeBeforeSafety {
  currentPersona: Persona | null;
  pendingMode: PendingMode;
}

export interface RateLimitState {
  windowStartTs: number;
  count: number;
}

export interface UserSessionState {
  currentPersona: Persona | null;
  pendingMode: PendingMode;
  pendingUserText: string | null;
  pendingForgetConfirmation: boolean;
  pendingResetConfirmation: boolean;
  lastPersonaBeforePanel: Persona | null;
  sessionId: string;
  sessionStartTs: number;
  lastActivityTs: number;
  safetyHold: boolean;
  pendingSafetyCheck: boolean;
  safetySuppressedUntilTs: number | null;
  lastModeBeforeSafety: LastModeBeforeSafety | null;
  lastProcessedUpdateId: number | null;
  rateLimitState: RateLimitState;
}

export const SESSION_TIMEOUT_MS = 12 * 60 * 60 * 1000;

export function createInitialSessionState(input: {
  sessionId: string;
  now?: number;
}): UserSessionState {
  const now = input.now ?? Date.now();
  return {
    currentPersona: null,
    pendingMode: null,
    pendingUserText: null,
    pendingForgetConfirmation: false,
    pendingResetConfirmation: false,
    lastPersonaBeforePanel: null,
    sessionId: input.sessionId,
    sessionStartTs: now,
    lastActivityTs: now,
    safetyHold: false,
    pendingSafetyCheck: false,
    safetySuppressedUntilTs: null,
    lastModeBeforeSafety: null,
    lastProcessedUpdateId: null,
    rateLimitState: {
      windowStartTs: now,
      count: 0
    }
  };
}

export function isSessionExpired(
  lastActivityTs: number,
  now: number = Date.now()
): boolean {
  return now - lastActivityTs >= SESSION_TIMEOUT_MS;
}
