import { UXHandlers, type IncomingEvent, type HandleResult, type LLMTask, type OutgoingMessage } from "./uxHandlers.js";
import type { UserSessionState } from "../state/session.js";

export interface LLMResponder {
  generate(input: { userId: string; task: LLMTask; state: UserSessionState }): Promise<OutgoingMessage[]>;
  clearLongTerm?(userId: string): Promise<void> | void;
  resetSession?(input: { userId: string; previousSessionId: string; newSessionId: string }): Promise<void> | void;
}

export class BotRuntime {
  private readonly handlers: UXHandlers;
  private readonly responder?: LLMResponder;
  private readonly userQueues = new Map<string, Promise<HandleResult>>();

  constructor(handlers: UXHandlers = new UXHandlers(), responder?: LLMResponder) {
    this.handlers = handlers;
    this.responder = responder;
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
      return withGenerationFailure(result);
    }

    try {
      const generatedMessages = await this.responder.generate({
        userId: event.userId,
        task: result.llmTask,
        state: result.state
      });

      if (generatedMessages.length === 0) {
        return withGenerationFailure(result);
      }

      const mergedMessages = mergeMessagesWithGenerated(result.messages, generatedMessages, result.llmTask.mode);
      return {
        ...result,
        messages: mergedMessages
      };
    } catch {
      return withGenerationFailure(result);
    }
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
