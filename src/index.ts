import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";

import OpenAI from "openai";
import { Bot, type Context } from "grammy";

import { createOpenAIResponsesCompatClient } from "./llm/openaiCompatClient.js";
import { createLogger, toSafeLog } from "./observability/logger.js";
import { MetricsCollector } from "./observability/metrics.js";
import { OpenAILLMResponder } from "./runtime/llmResponder.js";
import { BotRuntime } from "./telegram/bot.js";
import type { InlineKeyboard, ReplyKeyboard } from "./telegram/keyboard.js";
import { UXHandlers, type IncomingEvent, type OutgoingMessage } from "./telegram/uxHandlers.js";

const SUPPORTED_COMMANDS = ["/start", "/help", "/friends", "/settings", "/demo", "/reset", "/privacy", "/forget"] as const;
type SupportedCommand = (typeof SUPPORTED_COMMANDS)[number];
const BOT_COMMANDS = [
  { command: "start", description: "Начать и выбрать друга" },
  { command: "help", description: "Подробная помощь по боту" },
  { command: "friends", description: "Кто в чате" },
  { command: "settings", description: "Открыть настройки" },
  { command: "demo", description: "Показать демо ответов друзей" },
  { command: "privacy", description: "Что хранится и как удалить память" },
  { command: "reset", description: "Сбросить текущую сессию" },
  { command: "forget", description: "Удалить долгую память" }
] as const;
const STARTUP_RETRY_BASE_MS = 5_000;
const STARTUP_RETRY_MAX_MS = 60_000;

export async function main(): Promise<void> {
  const logger = createLogger();
  const metrics = new MetricsCollector();

  const botToken = process.env.BOT_TOKEN;
  if (!botToken) {
    throw new Error("BOT_TOKEN is required.");
  }

  const openaiApiKey = process.env.OPENAI_API_KEY;
  const responder = openaiApiKey
    ? new OpenAILLMResponder(createOpenAIResponsesCompatClient(new OpenAI({ apiKey: openaiApiKey })))
    : undefined;
  if (!responder) {
    logger.warn(
      toSafeLog({
        outcome: "startup_without_llm",
        details: { reason: "OPENAI_API_KEY_MISSING" }
      }),
      "Starting bot without LLM responder."
    );
  }

  const runtime = new BotRuntime(new UXHandlers(), responder);
  const bot = new Bot(botToken);
  let shuttingDown = false;

  const stopBot = (signal: NodeJS.Signals): void => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    logger.info(
      toSafeLog({
        outcome: "shutdown_signal",
        details: { signal }
      }),
      "Received shutdown signal"
    );
    bot.stop();
  };

  process.once("SIGINT", () => stopBot("SIGINT"));
  process.once("SIGTERM", () => stopBot("SIGTERM"));

  bot.on("message:text", async (ctx) => {
    if (!ctx.from || !ctx.message?.text) {
      return;
    }
    const startedAt = Date.now();
    const event = toMessageEvent(ctx);
    const result = await runtime.processEvent(event);
    await sendMessages(ctx, result.messages);

    metrics.increment("updates_total");
    metrics.increment("updates_message_text");
    logger.info(
      toSafeLog({
        requestId: String(ctx.update.update_id),
        userHash: hashUserId(ctx.from.id),
        mode: result.llmTask?.mode,
        latencyMs: Date.now() - startedAt,
        outcome: "ok"
      }),
      "Handled text update"
    );
  });

  bot.on("callback_query:data", async (ctx) => {
    if (!ctx.from || !ctx.callbackQuery?.data) {
      return;
    }
    const startedAt = Date.now();
    const event = toCallbackEvent(ctx);
    const result = await runtime.processEvent(event);
    await ctx.answerCallbackQuery();
    await sendMessages(ctx, result.messages);

    metrics.increment("updates_total");
    metrics.increment("updates_callback");
    logger.info(
      toSafeLog({
        requestId: String(ctx.update.update_id),
        userHash: hashUserId(ctx.from.id),
        mode: result.llmTask?.mode,
        latencyMs: Date.now() - startedAt,
        outcome: "ok"
      }),
      "Handled callback update"
    );
  });

  bot.catch((error) => {
    logger.error(
      toSafeLog({
        outcome: "handler_error",
        details: {
          error: error.error instanceof Error ? error.error.name : "unknown"
        }
      }),
      "Bot handler error"
    );
  });

  let startupAttempt = 0;
  while (!shuttingDown) {
    try {
      startupAttempt += 1;
      await bot.api.setMyCommands(BOT_COMMANDS);
      await bot.start();
      startupAttempt = 0;
    } catch (error) {
      if (shuttingDown) {
        break;
      }
      const retryDelayMs = computeStartupRetryDelay(startupAttempt);
      logger.error(
        toSafeLog({
          outcome: "startup_retry",
          details: {
            attempt: startupAttempt,
            retryDelayMs,
            ...toStartupErrorDetails(error)
          }
        }),
        "Bot startup failed, retrying"
      );
      await sleep(retryDelayMs);
      continue;
    }

    if (!shuttingDown) {
      const retryDelayMs = computeStartupRetryDelay(startupAttempt || 1);
      logger.warn(
        toSafeLog({
          outcome: "polling_stopped",
          details: {
            retryDelayMs
          }
        }),
        "Bot polling stopped unexpectedly, restarting"
      );
      await sleep(retryDelayMs);
    }
  }
}

function toMessageEvent(ctx: Context): IncomingEvent {
  const text = ctx.message?.text ?? "";
  const command = parseSupportedCommand(text);

  if (command) {
    return {
      updateId: ctx.update.update_id,
      userId: String(ctx.from?.id ?? ""),
      command
    };
  }

  return {
    updateId: ctx.update.update_id,
    userId: String(ctx.from?.id ?? ""),
    text
  };
}

function toCallbackEvent(ctx: Context): IncomingEvent {
  return {
    updateId: ctx.update.update_id,
    userId: String(ctx.from?.id ?? ""),
    callbackData: ctx.callbackQuery?.data
  };
}

export function parseSupportedCommand(text: string): SupportedCommand | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) {
    return null;
  }
  const token = trimmed.split(/\s+/, 1)[0] ?? "";
  const normalized = token.split("@")[0] ?? token;
  return SUPPORTED_COMMANDS.includes(normalized as SupportedCommand)
    ? (normalized as SupportedCommand)
    : null;
}

async function sendMessages(ctx: Context, messages: OutgoingMessage[]): Promise<void> {
  for (const message of messages) {
    const replyMarkup = message.keyboard
      ? toInlineReplyMarkup(message.keyboard)
      : message.replyKeyboard
        ? toPersistentReplyKeyboard(message.replyKeyboard)
        : undefined;
    const options = replyMarkup
      ? {
          reply_markup: replyMarkup
        }
      : undefined;
    await ctx.reply(message.text, options);
  }
}

function toInlineReplyMarkup(keyboard: InlineKeyboard): { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> } {
  return {
    inline_keyboard: keyboard.map((row) =>
      row.map((button) => ({
        text: button.text,
        callback_data: button.data
      }))
    )
  };
}

function toPersistentReplyKeyboard(keyboard: ReplyKeyboard): {
  keyboard: Array<Array<{ text: string }>>;
  resize_keyboard: true;
  is_persistent: true;
  input_field_placeholder: string;
} {
  return {
    keyboard: keyboard.map((row) => row.map((text) => ({ text }))),
    resize_keyboard: true,
    is_persistent: true,
    input_field_placeholder: "Напиши сообщение..."
  };
}

function hashUserId(userId: number): string {
  const salt = process.env.TELEMETRY_SALT ?? "dev-salt";
  return createHash("sha256").update(`${salt}:${userId}`).digest("hex").slice(0, 16);
}

function toStartupErrorDetails(error: unknown): Record<string, string> {
  if (error instanceof Error) {
    return {
      errorName: error.name,
      errorMessage: error.message
    };
  }
  return {
    errorName: "unknown",
    errorMessage: "unknown"
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch((error) => {
    // eslint-disable-next-line no-console
    console.error(error);
    process.exitCode = 1;
  });
}
