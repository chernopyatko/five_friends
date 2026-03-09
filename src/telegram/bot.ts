import { UXHandlers, type IncomingEvent, type HandleResult, type LLMTask, type OutgoingMessage } from "./uxHandlers.js";
import type { UserSessionState } from "../state/session.js";
import type { Logger as PinoLogger } from "pino";

import { buildShareLink } from "../growth/share.js";
import type { ReferralService } from "../growth/referral.js";
import type { AnalyticsEventName, AnalyticsService } from "../observability/analytics.js";
import { shareKeyboard } from "./keyboard.js";

export interface LLMResponder {
  generate(input: { userId: string; task: LLMTask; state: UserSessionState }): Promise<OutgoingMessage[]>;
  clearLongTerm?(userId: string): Promise<void> | void;
  resetSession?(input: { userId: string; previousSessionId: string; newSessionId: string }): Promise<void> | void;
}

export class BotRuntime {
  private readonly handlers: UXHandlers;
  private readonly responder?: LLMResponder;
  private readonly referrals?: ReferralService;
  private readonly analytics?: AnalyticsService;
  private readonly botUsername?: string;
  private readonly logger?: PinoLogger;
  private readonly userQueues = new Map<string, Promise<HandleResult>>();

  constructor(
    handlers: UXHandlers = new UXHandlers(),
    responder?: LLMResponder,
    options?: {
      referrals?: ReferralService;
      analytics?: AnalyticsService;
      botUsername?: string;
      logger?: PinoLogger;
    }
  ) {
    this.handlers = handlers;
    this.responder = responder;
    this.referrals = options?.referrals;
    this.analytics = options?.analytics;
    this.botUsername = options?.botUsername;
    this.logger = options?.logger;
  }

  processEvent(event: IncomingEvent): Promise<HandleResult> {
    const userId = event.userId;
    const previous = this.userQueues.get(userId) ?? Promise.resolve<HandleResult | undefined>(undefined);

    const next = previous.catch(() => undefined).then(async () => {
      const baseResult = this.handlers.handleEvent(event);
      return this.applyLLMIfNeeded(baseResult, event);
    });

    this.userQueues.set(userId, next);
    return next.finally(() => {
      if (this.userQueues.get(userId) === next) {
        this.userQueues.delete(userId);
      }
    });
  }

  private async applyLLMIfNeeded(result: HandleResult, event: IncomingEvent): Promise<HandleResult> {
    if (result.clearLongTerm && this.responder?.clearLongTerm) {
      await this.responder.clearLongTerm(event.userId);
    }
    if (this.responder?.resetSession && result.sessionReset) {
      await this.responder.resetSession({
        userId: event.userId,
        previousSessionId: result.sessionReset.previousSessionId,
        newSessionId: result.state.sessionId
      });
    }

    if (!result.llmTask) {
      return result;
    }
    if (!this.responder) {
      // Intentionally no model_error emit: missing responder is a config issue
      // already logged at startup (startup_without_llm), not a per-message error.
      return withGenerationFailure(result);
    }

    try {
      const generatedMessages = await this.responder.generate({
        userId: event.userId,
        task: result.llmTask,
        state: result.state
      });

      if (generatedMessages.length === 0) {
        this.analytics?.emitEvent({
          event: "model_error",
          userId: event.userId,
          sessionId: result.state.sessionId
        });
        return withGenerationFailure(result);
      }

      const mergedMessages = mergeMessagesWithGenerated(result.messages, generatedMessages, result.llmTask.mode);
      const postGenerationEvent = resolvePostGenerationEvent(result.llmTask);
      if (postGenerationEvent) {
        this.analytics?.emitEvent({
          event: postGenerationEvent,
          userId: event.userId,
          sessionId: result.state.sessionId
        });
      }
      const withShare = this.appendShareMessageIfNeeded(result.llmTask, event.userId, mergedMessages);
      return {
        ...result,
        messages: withShare
      };
    } catch {
      this.analytics?.emitEvent({
        event: "model_error",
        userId: event.userId,
        sessionId: result.state.sessionId
      });
      return withGenerationFailure(result);
    }
  }

  private appendShareMessageIfNeeded(task: LLMTask, userId: string, messages: OutgoingMessage[]): OutgoingMessage[] {
    if (!isShareEligible(task) || !this.referrals) {
      return messages;
    }

    const inviterCode = this.referrals.getOrCreateInviterCode(userId);
    const share = buildShareLink(this.botUsername, inviterCode);
    if (share.isPlaceholder) {
      this.logger?.warn(
        {
          outcome: "share_link_placeholder",
          details: {
            reason: "BOT_USERNAME_MISSING"
          }
        },
        "BOT_USERNAME is missing, share link is in degraded mode"
      );
    }
    return [
      ...messages,
      {
        text: "Что дальше?",
        keyboard: shareKeyboard(share.url)
      }
    ];
  }
}

function mergeMessagesWithGenerated(
  _original: OutgoingMessage[],
  generated: OutgoingMessage[],
  mode: LLMTask["mode"]
): OutgoingMessage[] {
  if (mode === "PANEL") {
    return generated;
  }
  return generated;
}

function withGenerationFailure(result: HandleResult): HandleResult {
  const fallback = "Не удалось получить ответ от GPT. Попробуй отправить сообщение ещё раз.";
  if (!result.llmTask) {
    return result;
  }
  if (result.llmTask.mode === "PANEL") {
    return {
      ...result,
      messages: [{ text: fallback }]
    };
  }
  return {
    ...result,
    messages: [{ text: fallback }]
  };
}

function resolvePostGenerationEvent(task: LLMTask): AnalyticsEventName | null {
  if (task.scenario === "compose") {
    return "tool_write_for_me";
  }
  if (task.scenario === "reply") {
    return "tool_help_reply";
  }
  if (task.mode === "PANEL") {
    return "ask_all";
  }
  if (task.mode === "SUMMARY") {
    return "tool_summary";
  }
  return null;
}

function isShareEligible(task: LLMTask): boolean {
  return resolvePostGenerationEvent(task) !== null;
}
