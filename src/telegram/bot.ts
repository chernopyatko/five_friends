import { UXHandlers, type IncomingEvent, type HandleResult, type LLMTask, type OutgoingMessage } from "./uxHandlers.js";
import type { UserSessionState } from "../state/session.js";
import type { Logger as PinoLogger } from "pino";

import type { BalanceStore } from "../billing/balanceStore.js";
import type { BillingConfig } from "../billing/config.js";
import { resolveMessageCost } from "../billing/costs.js";
import { buildShareLink } from "../growth/share.js";
import type { ReferralService } from "../growth/referral.js";
import type { AnalyticsEventName, AnalyticsService } from "../observability/analytics.js";
import { paywallKeyboard, shareKeyboard } from "./keyboard.js";

const PAYWALL_TEXT =
  "Друзья на паузе ☕\n\n" +
  "Бесплатные разговоры закончились. Пополни баланс, чтобы продолжить — ребята ждут.";
const GRACE_TEXT =
  "💬 Это было последнее сообщение. Чтобы продолжить разбираться вместе — пополни баланс:";

export interface GenerateResult {
  messages: OutgoingMessage[];
  billable: boolean;
}

export interface LLMResponder {
  generate(input: { userId: string; task: LLMTask; state: UserSessionState }): Promise<GenerateResult>;
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
  private readonly balanceStore?: BalanceStore;
  private readonly bypassBalanceUserIds: Set<string>;
  private readonly billingConfig?: BillingConfig;
  private readonly billingConfigured: boolean;
  private readonly userQueues = new Map<string, Promise<HandleResult>>();

  constructor(
    handlers: UXHandlers = new UXHandlers(),
    responder?: LLMResponder,
    options?: {
      referrals?: ReferralService;
      analytics?: AnalyticsService;
      botUsername?: string;
      logger?: PinoLogger;
      balanceStore?: BalanceStore;
      bypassBalanceUserIds?: Set<string>;
      billingConfig?: BillingConfig;
    }
  ) {
    this.handlers = handlers;
    this.responder = responder;
    this.referrals = options?.referrals;
    this.analytics = options?.analytics;
    this.botUsername = options?.botUsername;
    this.logger = options?.logger;
    this.balanceStore = options?.balanceStore;
    this.bypassBalanceUserIds = options?.bypassBalanceUserIds ?? new Set<string>();
    this.billingConfig = options?.billingConfig;
    this.billingConfigured = options?.billingConfig?.isConfigured ?? false;
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
    const isBypass = !this.billingConfigured || this.bypassBalanceUserIds.has(event.userId);
    if (!isBypass && this.balanceStore && this.billingConfig) {
      this.balanceStore.ensureBalance(event.userId);
      const cost = resolveMessageCost(result.llmTask.mode);
      const balance = this.balanceStore.getBalance(event.userId);
      if (balance < cost) {
        this.analytics?.emitEvent({
          event: "paywall_shown",
          userId: event.userId,
          sessionId: result.state.sessionId
        });
        return {
          ...result,
          messages: [{
            text: PAYWALL_TEXT,
            keyboard: paywallKeyboard(this.billingConfig.tributeLinks)
          }]
        };
      }
    }

    try {
      const generation = await this.responder.generate({
        userId: event.userId,
        task: result.llmTask,
        state: result.state
      });
      const generatedMessages = generation.messages;

      if (generatedMessages.length === 0) {
        this.analytics?.emitEvent({
          event: "model_error",
          userId: event.userId,
          sessionId: result.state.sessionId
        });
        return withGenerationFailure(result);
      }

      const mergedMessages = mergeMessagesWithGenerated(result.messages, generatedMessages, result.llmTask.mode);
      if (generation.billable) {
        const postGenerationEvent = resolvePostGenerationEvent(result.llmTask);
        if (postGenerationEvent) {
          this.analytics?.emitEvent({
            event: postGenerationEvent,
            userId: event.userId,
            sessionId: result.state.sessionId
          });
        }
      }

      if (!isBypass && this.balanceStore && generation.billable && this.billingConfig) {
        const cost = resolveMessageCost(result.llmTask.mode);
        try {
          this.balanceStore.deductBalance(event.userId, cost, result.llmTask.mode);
          const newBalance = this.balanceStore.getBalance(event.userId);

          if (newBalance === 0) {
            mergedMessages.push({
              text: GRACE_TEXT,
              keyboard: paywallKeyboard(this.billingConfig.tributeLinks)
            });
          } else if (newBalance <= 3) {
            const lastMsg = mergedMessages[mergedMessages.length - 1];
            if (lastMsg) {
              lastMsg.text += `\n\n💬 Осталось ${newBalance} — пополни, чтобы ребята были на связи.`;
            }
          } else if (newBalance <= 10) {
            const lastMsg = mergedMessages[mergedMessages.length - 1];
            if (lastMsg) {
              lastMsg.text += `\n\n💬 Баланс: ${newBalance} сообщений`;
            }
          }
        } catch (error) {
          this.logger?.warn(
            {
              outcome: "balance_deduct_failed",
              details: {
                userId: event.userId,
                mode: result.llmTask.mode,
                error: error instanceof Error ? error.message : "unknown"
              }
            },
            "Failed to deduct balance after generation"
          );
        }
      }

      const withShare = generation.billable
        ? this.appendShareMessageIfNeeded(result.llmTask, event.userId, mergedMessages)
        : mergedMessages;

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
  const fallback = "Что-то пошло не так. Попробуй отправить сообщение ещё раз.";
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
