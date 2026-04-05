import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { pathToFileURL } from "node:url";

import OpenAI from "openai";
import { Bot, type Context } from "grammy";

import { BalanceStore } from "./billing/balanceStore.js";
import { loadBillingConfig, type BillingConfig } from "./billing/config.js";
import { parseTributeWebhookEvent, verifyTributeSignature } from "./billing/tributeWebhook.js";
import { ReferralService } from "./growth/referral.js";
import { createOpenAIResponsesCompatClient } from "./llm/openaiCompatClient.js";
import { AnalyticsService } from "./observability/analytics.js";
import { createLogger, toSafeLog } from "./observability/logger.js";
import { MetricsCollector } from "./observability/metrics.js";
import { OpenAILLMResponder } from "./runtime/llmResponder.js";
import { SqliteStore } from "./state/store.js";
import { BotRuntime } from "./telegram/bot.js";
import type { InlineKeyboard, ReplyKeyboard } from "./telegram/keyboard.js";
import { UXHandlers, type IncomingEvent, type OutgoingMessage } from "./telegram/uxHandlers.js";
import { hashUserId } from "./utils/hashUserId.js";

const SUPPORTED_COMMANDS = ["/start", "/help", "/friends", "/settings", "/demo", "/reset", "/privacy", "/forget", "/stats", "/balance"] as const;
type SupportedCommand = (typeof SUPPORTED_COMMANDS)[number];
const BOT_COMMANDS = [
  { command: "start", description: "Начать и выбрать друга" },
  { command: "help", description: "Подробная помощь по боту" },
  { command: "settings", description: "Открыть настройки" },
  { command: "demo", description: "Показать демо ответов друзей" },
  { command: "privacy", description: "Что хранится и как удалить память" },
  { command: "reset", description: "Сбросить текущую сессию" },
  { command: "forget", description: "Удалить долгую память" },
  { command: "balance", description: "Показать баланс сообщений" },
  { command: "stats", description: "Статистика (админ)" }
] as const;
const STARTUP_RETRY_BASE_MS = 5_000;
const STARTUP_RETRY_MAX_MS = 60_000;
const TYPING_INITIAL_DELAY_MS = 300;
const TYPING_REPEAT_MS = 4_000;
const WEBHOOK_MAX_BODY_BYTES = 64 * 1024;
const TRIBUTE_WEBHOOK_PATH = "/api/tribute/webhook";
const KNOWN_TRIBUTE_EVENTS = new Set(["new_digital_product", "digital_product_refunded"]);

export async function main(): Promise<void> {
  const logger = createLogger();
  const metrics = new MetricsCollector();
  const store = new SqliteStore(process.env.SQLITE_PATH ?? "data/bot.sqlite");
  const referrals = new ReferralService(store.getDb(), logger);
  const analytics = new AnalyticsService({
    db: store.getDb(),
    logger,
    httpEndpoint: process.env.ANALYTICS_HTTP_ENDPOINT
  });
  const balanceStore = new BalanceStore(store.getDb());
  const billingConfig = loadBillingConfig();
  if (!billingConfig.isConfigured) {
    const billingDisableReason = !billingConfig.tributeApiSecret ? "TRIBUTE_API_SECRET_MISSING" : "BILLING_CONFIG_INCOMPLETE";
    logger.warn(
      toSafeLog({
        outcome: "startup_billing_disabled",
        details: {
          reason: billingDisableReason
        }
      }),
      "Billing is disabled, unlimited access mode is active."
    );
  }

  const botToken = process.env.BOT_TOKEN;
  if (!botToken) {
    throw new Error("BOT_TOKEN is required.");
  }

  const openaiApiKey = process.env.OPENAI_API_KEY;
  const responder = openaiApiKey
    ? new OpenAILLMResponder(createOpenAIResponsesCompatClient(new OpenAI({ apiKey: openaiApiKey })), {
        store,
        analytics
      })
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

  const adminUserIds = parseUserIdSet(process.env.ADMIN_USER_IDS);
  const bypassBalanceUserIds = new Set<string>([
    ...adminUserIds,
    ...parseUserIdSet(process.env.BYPASS_BALANCE_USER_IDS)
  ]);
  const bot = new Bot(botToken);
  let botUsername = process.env.BOT_USERNAME;
  try {
    const botInfo = await bot.api.getMe();
    botUsername = botInfo.username;
    logger.info(
      toSafeLog({
        outcome: "bot_username_detected",
        details: { username: botInfo.username }
      }),
      "Bot username auto-detected from Telegram API"
    );
  } catch (error) {
    logger.warn(
      toSafeLog({
        outcome: "bot_username_detection_failed",
        details: {
          fallback: botUsername ?? "<none>",
          error: error instanceof Error ? error.message : "unknown"
        }
      }),
      "Failed to auto-detect bot username, using BOT_USERNAME env var"
    );
  }
  const runtime = new BotRuntime(
    new UXHandlers({
      referrals,
      analytics,
      adminUserIds,
      bypassBalanceUserIds,
      balanceStore,
      billingConfig,
      botUsername
    }),
    responder,
    {
      referrals,
      analytics,
      botUsername,
      logger,
      balanceStore,
      bypassBalanceUserIds,
      billingConfig
    }
  );
  let webhookServer: Server | undefined;
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
    if (webhookServer) {
      webhookServer.close();
    }
    store.close();
  };

  process.once("SIGINT", () => stopBot("SIGINT"));
  process.once("SIGTERM", () => stopBot("SIGTERM"));

  bot.on("message:text", async (ctx) => {
    if (!ctx.from || !ctx.message?.text) {
      return;
    }
    const startedAt = Date.now();
    const event = toMessageEvent(ctx);
    if (event.command === "/start") {
      balanceStore.ensureBalance(event.userId);
    }
    const result = await runWithTypingIndicator(ctx, () => runtime.processEvent(event));
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
    const result = await runWithTypingIndicator(ctx, () => runtime.processEvent(event));
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

  if (billingConfig.tributeApiSecret) {
    const webhookPort = parsePort(process.env.WEBHOOK_PORT) ?? parsePort(process.env.PORT) ?? 3100;
    webhookServer = await startTributeWebhookServer({
      port: webhookPort,
      bot,
      billingConfig,
      balanceStore,
      analytics,
      store,
      logger
    });
  }

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

function parseUserIdSet(raw: string | undefined): Set<string> {
  return new Set(
    (raw ?? "")
      .split(",")
      .map((item) => item.trim())
      .filter((item) => item.length > 0)
  );
}

function parsePort(rawValue: string | undefined): number | null {
  if (!rawValue) {
    return null;
  }
  const value = Number(rawValue);
  if (!Number.isInteger(value) || value <= 0 || value > 65_535) {
    return null;
  }
  return value;
}

async function startTributeWebhookServer(input: {
  port: number;
  bot: Bot;
  billingConfig: BillingConfig;
  balanceStore: BalanceStore;
  analytics: AnalyticsService;
  store: SqliteStore;
  logger: ReturnType<typeof createLogger>;
}): Promise<Server> {
  const server = createServer((req, res) => {
    void handleTributeWebhookRequest(req, res, input);
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (error: unknown): void => reject(error);
    server.once("error", onError);
    server.listen(input.port, () => {
      server.off("error", onError);
      resolve();
    });
  });

  input.logger.info(
    toSafeLog({
      outcome: "tribute_webhook_started",
      details: {
        port: input.port
      }
    }),
    "Tribute webhook server started"
  );

  return server;
}

async function handleTributeWebhookRequest(
  req: IncomingMessage,
  res: ServerResponse,
  input: {
    bot: Bot;
    billingConfig: BillingConfig;
    balanceStore: BalanceStore;
    analytics: AnalyticsService;
    store: SqliteStore;
    logger: ReturnType<typeof createLogger>;
  }
): Promise<void> {
  const urlPath = req.url?.split("?")[0];
  if (urlPath !== TRIBUTE_WEBHOOK_PATH) {
    writeJson(res, 404, { error: "not found" });
    return;
  }
  if (req.method !== "POST") {
    writeJson(res, 405, { error: "method not allowed" });
    return;
  }
  if (!input.billingConfig.isConfigured) {
    input.logger.warn(
      toSafeLog({
        outcome: "tribute_webhook_billing_incomplete"
      }),
      "Billing is not fully configured for webhook handling"
    );
    writeJson(res, 503, { error: "billing not configured" });
    return;
  }

  try {
    const rawBody = await readRequestBody(req, WEBHOOK_MAX_BODY_BYTES);
    const signatureHeader = getSignatureHeader(req);

    if (
      !verifyTributeSignature({
        rawBody,
        signatureHeader,
        apiSecret: input.billingConfig.tributeApiSecret ?? ""
      })
    ) {
      input.logger.warn(
        toSafeLog({
          outcome: "tribute_webhook_invalid_signature"
        }),
        "Invalid Tribute signature"
      );
      writeJson(res, 401, { error: "invalid signature" });
      return;
    }

    let payload: unknown;
    try {
      payload = JSON.parse(rawBody.toString("utf8"));
    } catch {
      input.logger.warn(
        toSafeLog({
          outcome: "tribute_webhook_unparseable"
        }),
        "Webhook payload is not valid JSON"
      );
      writeJson(res, 200, { ok: true, ignored: true });
      return;
    }

    const event = parseTributeWebhookEvent(payload);
    if (!event || !KNOWN_TRIBUTE_EVENTS.has(event.eventType)) {
      input.logger.info(
        toSafeLog({
          outcome: "tribute_webhook_ignored"
        }),
        "Webhook event ignored"
      );
      writeJson(res, 200, { ok: true, ignored: true });
      return;
    }

    if (event.eventType === "digital_product_refunded") {
      input.logger.warn(
        toSafeLog({
          outcome: "tribute_webhook_refund",
          details: {
            purchaseId: event.purchaseId,
            userId: event.telegramId
          }
        }),
        "Digital product refunded (no balance deduction yet)"
      );
      writeJson(res, 200, { ok: true, refund_logged: true });
      return;
    }

    const amount = input.billingConfig.productMap[event.productId];
    if (!amount) {
      input.logger.info(
        toSafeLog({
          outcome: "tribute_webhook_unknown_product",
          details: {
            productId: event.productId
          }
        }),
        "Unknown Tribute product id"
      );
      writeJson(res, 200, { ok: true, ignored: true });
      return;
    }

    const credited = input.balanceStore.addBalance(event.telegramId, amount, "tribute_purchase", event.purchaseId);
    if (!credited.credited) {
      input.logger.info(
        toSafeLog({
          outcome: "tribute_webhook_duplicate",
          details: {
            purchaseId: event.purchaseId
          }
        }),
        "Duplicate Tribute purchase id"
      );
      writeJson(res, 200, { ok: true, credited: false });
      return;
    }

    const latestSessionId = input.store.getLatestSessionForUser(event.telegramId)?.id ?? `purchase:${event.purchaseId}`;
    input.analytics.emitEvent({
      event: "purchase_completed",
      userId: event.telegramId,
      sessionId: latestSessionId
    });

    try {
      await input.bot.api.sendMessage(
        event.telegramId,
        `✅ Баланс пополнен! +${amount} сообщений\n💬 Баланс: ${credited.balance}`
      );
    } catch (error) {
      input.logger.warn(
        toSafeLog({
          outcome: "tribute_webhook_notify_failed",
          details: {
            error: error instanceof Error ? error.message : "unknown",
            userId: event.telegramId
          }
        }),
        "Failed to send purchase notification"
      );
    }

    input.logger.info(
      toSafeLog({
        outcome: "tribute_webhook_success",
        details: {
          userId: event.telegramId,
          purchaseId: event.purchaseId,
          amount
        }
      }),
      "Webhook credited user balance"
    );
    writeJson(res, 200, { ok: true, credited: true });
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      writeJson(res, 413, { error: "payload too large" });
      return;
    }

    input.logger.error(
      toSafeLog({
        outcome: "tribute_webhook_error",
        details: {
          error: error instanceof Error ? error.message : "unknown"
        }
      }),
      "Unhandled Tribute webhook error"
    );
    writeJson(res, 500, { error: "internal error" });
  }
}

async function readRequestBody(req: IncomingMessage, maxBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    let rejected = false;

    req.on("data", (chunk: Buffer | string) => {
      if (rejected) {
        return;
      }
      const asBuffer = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
      totalBytes += asBuffer.length;
      if (totalBytes > maxBytes) {
        rejected = true;
        reject(new RequestBodyTooLargeError());
        return;
      }
      chunks.push(asBuffer);
    });

    req.on("end", () => {
      if (rejected) {
        return;
      }
      resolve(Buffer.concat(chunks));
    });

    req.on("error", (error) => {
      if (rejected) {
        return;
      }
      reject(error);
    });
  });
}

function getSignatureHeader(req: IncomingMessage): string | undefined {
  const headers = [
    req.headers["trbt-signature"],
    req.headers["x-tribute-signature"],
    req.headers["tribute-signature"]
  ];

  for (const header of headers) {
    if (typeof header === "string") {
      return header;
    }
    if (Array.isArray(header) && header.length > 0) {
      return header[0];
    }
  }
  return undefined;
}

function writeJson(res: ServerResponse, statusCode: number, body: Record<string, unknown>): void {
  res.statusCode = statusCode;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

class RequestBodyTooLargeError extends Error {
  constructor() {
    super("Request body exceeds limit.");
  }
}

function toMessageEvent(ctx: Context): IncomingEvent {
  const text = ctx.message?.text ?? "";
  const parsedCommand = parseSupportedCommand(text);

  if (parsedCommand) {
    return {
      updateId: ctx.update.update_id,
      userId: String(ctx.from?.id ?? ""),
      command: parsedCommand.command,
      commandPayload: parsedCommand.payload
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

export interface ParsedSupportedCommand {
  command: SupportedCommand;
  payload?: string;
}

export function parseSupportedCommand(text: string): ParsedSupportedCommand | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) {
    return null;
  }
  const [commandToken = "", ...rest] = trimmed.split(/\s+/);
  const normalizedCommand = commandToken.split("@")[0] ?? commandToken;
  if (!SUPPORTED_COMMANDS.includes(normalizedCommand as SupportedCommand)) {
    return null;
  }
  const payload = rest.join(" ").trim();
  return {
    command: normalizedCommand as SupportedCommand,
    payload: normalizedCommand === "/start" && payload.length > 0 ? payload : undefined
  };
}

export function computeStartupRetryDelay(attempt: number): number {
  const normalizedAttempt = Number.isFinite(attempt) ? Math.max(1, Math.floor(attempt)) : 1;
  const exponent = Math.min(10, normalizedAttempt - 1);
  return Math.min(STARTUP_RETRY_MAX_MS, STARTUP_RETRY_BASE_MS * 2 ** exponent);
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

function toInlineReplyMarkup(
  keyboard: InlineKeyboard
): { inline_keyboard: Array<Array<{ text: string; callback_data: string } | { text: string; url: string }>> } {
  return {
    inline_keyboard: keyboard.map((row) =>
      row.map((button) => {
        if ("url" in button) {
          return {
            text: button.text,
            url: button.url
          };
        }
        return {
          text: button.text,
          callback_data: button.data
        };
      })
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
    input_field_placeholder: "Расскажи, что случилось..."
  };
}

interface TypingCapableContext {
  chat?: { id: number | string };
  api: {
    sendChatAction(chatId: number | string, action: "typing"): Promise<unknown>;
  };
}

export async function runWithTypingIndicator<T>(
  ctx: TypingCapableContext,
  work: () => Promise<T>
): Promise<T> {
  const chatId = ctx.chat?.id;
  if (!chatId) {
    return work();
  }

  let interval: NodeJS.Timeout | undefined;
  let timeout: NodeJS.Timeout | undefined;

  const sendTyping = async (): Promise<void> => {
    try {
      await ctx.api.sendChatAction(chatId, "typing");
    } catch {
      // Ignore transient Telegram errors for typing action.
    }
  };

  timeout = setTimeout(() => {
    void sendTyping();
    interval = setInterval(() => {
      void sendTyping();
    }, TYPING_REPEAT_MS);
  }, TYPING_INITIAL_DELAY_MS);

  try {
    return await work();
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
    if (interval) {
      clearInterval(interval);
    }
  }
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
