import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { pathToFileURL } from "node:url";

import OpenAI from "openai";
import { Bot, type Context } from "grammy";

import { BalanceStore } from "./billing/balanceStore.js";
import { loadBillingConfig, type BillingConfig } from "./billing/config.js";
import { parseTributeWebhookEvent, verifyTributeSignature } from "./billing/tributeWebhook.js";
import { ReferralService } from "./growth/referral.js";
import { sanitizeCampaign } from "./growth/sourceAttribution.js";
import { MODEL_ROUTES, resolveModelOverride } from "./llm/modelRouting.js";
import { createOpenAIResponsesCompatClient } from "./llm/openaiCompatClient.js";
import { AnalyticsService } from "./observability/analytics.js";
import { createLogger, toSafeLog } from "./observability/logger.js";
import { MetricsCollector } from "./observability/metrics.js";
import { OpenAILLMResponder } from "./runtime/llmResponder.js";
import { processReminders } from "./scheduler/reminderHandler.js";
import { SqliteStore } from "./state/store.js";
import { BotRuntime, PAYWALL_TEXT } from "./telegram/bot.js";
import { paywallKeyboard, type InlineKeyboard, type ReplyKeyboard } from "./telegram/keyboard.js";
import { UXHandlers, type IncomingEvent, type OutgoingMessage } from "./telegram/uxHandlers.js";
import { ImageRecognitionError, OpenAIImageRecognizer } from "./telegram/imageRecognition.js";
import { OpenAIVoiceTranscriber, VoiceTranscriptionError } from "./telegram/voiceTranscription.js";
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
const VOICE_MAX_DURATION_SECONDS = 600;
const VOICE_MAX_FILE_SIZE_BYTES = 20 * 1024 * 1024;
const SCREENSHOT_MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024;
const MEDIA_QUOTA_WINDOW_MS = 60 * 60 * 1000;
const MEDIA_QUOTA_MAX_POINTS = 24;
const VOICE_SECONDS_PER_MEDIA_QUOTA_POINT = 60;
const WEBHOOK_MAX_BODY_BYTES = 64 * 1024;
const TRIBUTE_WEBHOOK_PATH = "/api/tribute/webhook";
const REMINDER_TRIGGER_PATH = "/api/reminders/trigger";
const GO_REDIRECT_PATH = "/go";
const KNOWN_TRIBUTE_EVENTS = new Set(["new_digital_product", "digital_product_refunded"]);
const GO_REDIRECT_CSP = "default-src 'none'; script-src https://www.googletagmanager.com 'unsafe-inline'; connect-src https://www.google-analytics.com";
const MEDIA_PAYWALL_TEXT =
  `${PAYWALL_TEXT}\n\n` +
  "Голосовые и скрины распознаются через платный API. Пополни баланс или отправь текстом.";

export async function main(): Promise<void> {
  const logger = createLogger();
  const metrics = new MetricsCollector();
  const store = new SqliteStore(process.env.SQLITE_PATH ?? "data/bot.sqlite");
  const referrals = new ReferralService(store.getDb(), logger);
  const analytics = new AnalyticsService({
    db: store.getDb(),
    logger,
    posthogApiKey: process.env.POSTHOG_API_KEY,
    posthogHost: process.env.POSTHOG_HOST
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
  const openaiClient = openaiApiKey ? new OpenAI({ apiKey: openaiApiKey }) : undefined;
  const responder = openaiClient
    ? new OpenAILLMResponder(createOpenAIResponsesCompatClient(openaiClient), {
        store,
        analytics
      })
    : undefined;
  const voiceTranscriber = openaiClient
    ? new OpenAIVoiceTranscriber({
        botToken,
        client: openaiClient,
        model: resolveModelOverride(process.env.VOICE_TRANSCRIPTION_MODEL, MODEL_ROUTES.voiceTranscription)
      })
    : undefined;
  const imageRecognizer = openaiClient
    ? new OpenAIImageRecognizer({
        botToken,
        client: openaiClient,
        model: resolveModelOverride(process.env.IMAGE_RECOGNITION_MODEL, MODEL_ROUTES.imageRecognition)
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
      firstPanelStateStore: store,
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
      firstPanelStateStore: store,
      bypassBalanceUserIds,
      billingConfig
    }
  );
  const mediaQuota = new MediaQuota();
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
    analytics.shutdown().catch((err) => {
      logger.warn(
        toSafeLog({
          outcome: "analytics_shutdown_error",
          details: { error: err instanceof Error ? err.message : "unknown" }
        }),
        "Analytics shutdown failed"
      );
    }).finally(() => {
      store.close();
    });
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

  bot.on("message:voice", async (ctx) => {
    if (!ctx.from || !ctx.message?.voice) {
      return;
    }
    const startedAt = Date.now();
    const userId = String(ctx.from.id);
    const preflightFailure = getVoicePreflightFailure(ctx.message.voice);
    if (preflightFailure) {
      await ctx.reply(formatVoicePreflightFailure(preflightFailure));
      metrics.increment("updates_total");
      metrics.increment("updates_message_voice");
      logger.warn(
        toSafeLog({
          requestId: String(ctx.update.update_id),
          userHash: hashUserId(ctx.from.id),
          latencyMs: Date.now() - startedAt,
          outcome: "voice_rejected",
          details: {
            reason: preflightFailure
          }
        }),
        "Voice update rejected before transcription"
      );
      return;
    }
    if (!voiceTranscriber) {
      await ctx.reply("Голосовые сейчас недоступны: не настроено распознавание. Отправь текстом.");
      metrics.increment("updates_total");
      metrics.increment("updates_message_voice");
      logger.warn(
        toSafeLog({
          requestId: String(ctx.update.update_id),
          userHash: hashUserId(ctx.from.id),
          latencyMs: Date.now() - startedAt,
          outcome: "voice_transcription_unconfigured"
        }),
        "Voice update skipped because transcription is not configured"
      );
      return;
    }
    if (getPaidMediaPreflightFailure({
      userId,
      billingConfig,
      balanceStore,
      bypassBalanceUserIds
    })) {
      await sendMessages(ctx, [{
        text: MEDIA_PAYWALL_TEXT,
        keyboard: paywallKeyboard(billingConfig.tributeLinks)
      }]);
      metrics.increment("updates_total");
      metrics.increment("updates_message_voice");
      logger.warn(
        toSafeLog({
          requestId: String(ctx.update.update_id),
          userHash: hashUserId(ctx.from.id),
          latencyMs: Date.now() - startedAt,
          outcome: "voice_rejected",
          details: {
            reason: "insufficient_balance"
          }
        }),
        "Voice update rejected before transcription"
      );
      return;
    }
    const quota = mediaQuota.tryConsume(userId, getVoiceMediaQuotaPoints(ctx.message.voice));
    if (!quota.allowed) {
      await ctx.reply(formatMediaQuotaFailure(quota));
      metrics.increment("updates_total");
      metrics.increment("updates_message_voice");
      logger.warn(
        toSafeLog({
          requestId: String(ctx.update.update_id),
          userHash: hashUserId(ctx.from.id),
          latencyMs: Date.now() - startedAt,
          outcome: "voice_rejected",
          details: {
            reason: "media_quota_exceeded"
          }
        }),
        "Voice update rejected by media quota"
      );
      return;
    }

    let transcript: string;
    try {
      transcript = await runWithTypingIndicator(ctx, async () => {
        const telegramFile = await ctx.getFile();
        return voiceTranscriber.transcribe({
          fileId: ctx.message.voice.file_id,
          fileUniqueId: ctx.message.voice.file_unique_id,
          filePath: telegramFile.file_path
        });
      });
    } catch (error) {
      metrics.increment("updates_total");
      metrics.increment("updates_message_voice");
      logger.warn(
        toSafeLog({
          requestId: String(ctx.update.update_id),
          userHash: hashUserId(ctx.from.id),
          latencyMs: Date.now() - startedAt,
          outcome: "voice_transcription_failed",
          details: {
            errorName: error instanceof Error ? error.name : "unknown",
            reason: error instanceof VoiceTranscriptionError ? error.reason : undefined
          }
        }),
        "Failed to transcribe voice update"
      );
      await ctx.reply("Не смог разобрать голосовое. Перезапиши чуть громче или отправь текстом.");
      return;
    }

    try {
      const result = await runWithTypingIndicator(ctx, () => runtime.processEvent(toVoiceTextEvent(ctx, transcript)));
      await sendMessages(ctx, result.messages);

      metrics.increment("updates_total");
      metrics.increment("updates_message_voice");
      logger.info(
        toSafeLog({
          requestId: String(ctx.update.update_id),
          userHash: hashUserId(ctx.from.id),
          mode: result.llmTask?.mode,
          latencyMs: Date.now() - startedAt,
          outcome: "ok"
        }),
        "Handled voice update"
      );
    } catch (error) {
      metrics.increment("updates_total");
      metrics.increment("updates_message_voice");
      logger.error(
        toSafeLog({
          requestId: String(ctx.update.update_id),
          userHash: hashUserId(ctx.from.id),
          latencyMs: Date.now() - startedAt,
          outcome: "voice_runtime_failed",
          details: {
            errorName: error instanceof Error ? error.name : "unknown"
          }
        }),
        "Failed to process transcribed voice update"
      );
      await ctx.reply("Голосовое распознал, но ответ сейчас не собрался. Попробуй ещё раз.");
    }
  });

  bot.on("message:photo", async (ctx) => {
    if (!ctx.from || !ctx.message?.photo) {
      return;
    }
    const startedAt = Date.now();
    const userId = String(ctx.from.id);
    const photo = getLargestPhoto(ctx.message.photo);
    if (!photo) {
      return;
    }

    const preflightFailure = getScreenshotPreflightFailure(photo);
    if (preflightFailure) {
      await ctx.reply(formatScreenshotPreflightFailure(preflightFailure));
      metrics.increment("updates_total");
      metrics.increment("updates_message_photo");
      logger.warn(
        toSafeLog({
          requestId: String(ctx.update.update_id),
          userHash: hashUserId(ctx.from.id),
          latencyMs: Date.now() - startedAt,
          outcome: "screenshot_rejected",
          details: {
            reason: preflightFailure
          }
        }),
        "Screenshot update rejected before recognition"
      );
      return;
    }
    if (!imageRecognizer) {
      await ctx.reply("Скриншоты сейчас недоступны: не настроено распознавание. Отправь текстом.");
      metrics.increment("updates_total");
      metrics.increment("updates_message_photo");
      logger.warn(
        toSafeLog({
          requestId: String(ctx.update.update_id),
          userHash: hashUserId(ctx.from.id),
          latencyMs: Date.now() - startedAt,
          outcome: "screenshot_recognition_unconfigured"
        }),
        "Screenshot update skipped because recognition is not configured"
      );
      return;
    }
    if (getPaidMediaPreflightFailure({
      userId,
      billingConfig,
      balanceStore,
      bypassBalanceUserIds
    })) {
      await sendMessages(ctx, [{
        text: MEDIA_PAYWALL_TEXT,
        keyboard: paywallKeyboard(billingConfig.tributeLinks)
      }]);
      metrics.increment("updates_total");
      metrics.increment("updates_message_photo");
      logger.warn(
        toSafeLog({
          requestId: String(ctx.update.update_id),
          userHash: hashUserId(ctx.from.id),
          latencyMs: Date.now() - startedAt,
          outcome: "screenshot_rejected",
          details: {
            reason: "insufficient_balance"
          }
        }),
        "Screenshot update rejected before recognition"
      );
      return;
    }
    const quota = mediaQuota.tryConsume(userId, getScreenshotMediaQuotaPoints());
    if (!quota.allowed) {
      await ctx.reply(formatMediaQuotaFailure(quota));
      metrics.increment("updates_total");
      metrics.increment("updates_message_photo");
      logger.warn(
        toSafeLog({
          requestId: String(ctx.update.update_id),
          userHash: hashUserId(ctx.from.id),
          latencyMs: Date.now() - startedAt,
          outcome: "screenshot_rejected",
          details: {
            reason: "media_quota_exceeded"
          }
        }),
        "Screenshot update rejected by media quota"
      );
      return;
    }

    let recognizedText: string;
    try {
      recognizedText = await runWithTypingIndicator(ctx, async () => {
        const telegramFile = await ctx.api.getFile(photo.file_id);
        return imageRecognizer.recognize({
          fileId: photo.file_id,
          fileUniqueId: photo.file_unique_id,
          filePath: telegramFile.file_path
        });
      });
    } catch (error) {
      metrics.increment("updates_total");
      metrics.increment("updates_message_photo");
      logger.warn(
        toSafeLog({
          requestId: String(ctx.update.update_id),
          userHash: hashUserId(ctx.from.id),
          latencyMs: Date.now() - startedAt,
          outcome: "screenshot_recognition_failed",
          details: {
            errorName: error instanceof Error ? error.name : "unknown",
            reason: error instanceof ImageRecognitionError ? error.reason : undefined
          }
        }),
        "Failed to recognize screenshot update"
      );
      await ctx.reply("Не смог разобрать скрин. Пришли чётче или отправь текстом.");
      return;
    }

    try {
      const result = await runWithTypingIndicator(ctx, () => runtime.processEvent(toScreenshotTextEvent(ctx, recognizedText)));
      await sendMessages(ctx, result.messages);

      metrics.increment("updates_total");
      metrics.increment("updates_message_photo");
      logger.info(
        toSafeLog({
          requestId: String(ctx.update.update_id),
          userHash: hashUserId(ctx.from.id),
          mode: result.llmTask?.mode,
          latencyMs: Date.now() - startedAt,
          outcome: "ok"
        }),
        "Handled screenshot update"
      );
    } catch (error) {
      metrics.increment("updates_total");
      metrics.increment("updates_message_photo");
      logger.error(
        toSafeLog({
          requestId: String(ctx.update.update_id),
          userHash: hashUserId(ctx.from.id),
          latencyMs: Date.now() - startedAt,
          outcome: "screenshot_runtime_failed",
          details: {
            errorName: error instanceof Error ? error.name : "unknown"
          }
        }),
        "Failed to process recognized screenshot update"
      );
      await ctx.reply("Скрин распознал, но ответ сейчас не собрался. Попробуй ещё раз.");
    }
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

  const webhookPort = parsePort(process.env.WEBHOOK_PORT) ?? parsePort(process.env.PORT) ?? 3100;
  webhookServer = await startWebhookServer({
    port: webhookPort,
    bot,
    billingConfig,
    balanceStore,
    analytics,
    store,
    logger,
    botUsername,
    gaMeasurementId: process.env.GA_MEASUREMENT_ID
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

async function startWebhookServer(input: {
  port: number;
  bot: Bot;
  billingConfig: BillingConfig;
  balanceStore: BalanceStore;
  analytics: AnalyticsService;
  store: SqliteStore;
  logger: ReturnType<typeof createLogger>;
  botUsername?: string;
  gaMeasurementId?: string;
}): Promise<Server> {
  const server = createServer((req, res) => {
    const urlPath = req.url?.split("?")[0];
    if (urlPath === GO_REDIRECT_PATH && req.method === "GET") {
      writeGoRedirect(res, req.url ?? GO_REDIRECT_PATH, input.botUsername, input.gaMeasurementId);
      return;
    }
    if (urlPath === TRIBUTE_WEBHOOK_PATH) {
      void handleTributeWebhookRequest(req, res, input);
      return;
    }
    if (urlPath === REMINDER_TRIGGER_PATH && req.method === "POST") {
      void handleReminderTrigger(req, res, input);
      return;
    }
    writeJson(res, 404, { error: "not found" });
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
      outcome: "webhook_server_started",
      details: {
        port: input.port
      }
    }),
    "Webhook server started"
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

async function handleReminderTrigger(
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
  const authorizationHeader = req.headers.authorization;
  const authHeader = Array.isArray(authorizationHeader) ? authorizationHeader[0] : authorizationHeader;
  const expectedToken = process.env.REMINDER_SECRET;
  if (!expectedToken || !safeCompareHeader(authHeader, `Bearer ${expectedToken}`)) {
    input.logger.warn(
      toSafeLog({
        outcome: "reminder_trigger_unauthorized"
      }),
      "Unauthorized reminder trigger attempt"
    );
    writeJson(res, 401, { error: "unauthorized" });
    return;
  }

  try {
    const result = await processReminders({
      db: input.store.getDb(),
      bot: input.bot,
      logger: input.logger
    });
    writeJson(res, 200, { ok: true, ...result });
  } catch (error) {
    input.logger.error(
      toSafeLog({
        outcome: "reminder_trigger_error",
        details: {
          error: error instanceof Error ? error.message : "unknown"
        }
      }),
      "Failed to process reminders"
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

interface GoRedirectResponse {
  statusCode: number;
  contentType: string;
  body: string;
  csp?: string;
}

export function buildGoRedirectResponse(input: {
  requestUrl: string;
  botUsername?: string;
  gaMeasurementId?: string;
}): GoRedirectResponse {
  const normalizedUsername = (input.botUsername ?? "").trim().replace(/^@/, "");
  if (normalizedUsername.length === 0) {
    return {
      statusCode: 503,
      contentType: "text/plain; charset=utf-8",
      body: "Bot not configured"
    };
  }

  const requestUrl = new URL(input.requestUrl, "http://localhost");
  const rawCampaign = requestUrl.searchParams.get("utm_campaign") ?? requestUrl.searchParams.get("campaign");
  const campaign = rawCampaign ? sanitizeCampaign(rawCampaign) : null;
  const deepLink = campaign
    ? `https://t.me/${normalizedUsername}?start=gads_${encodeURIComponent(campaign)}`
    : `https://t.me/${normalizedUsername}`;
  const escapedDeepLink = escapeHtml(deepLink);
  const gtagScript = buildGtagScript(input.gaMeasurementId);

  return {
    statusCode: 200,
    contentType: "text/html; charset=utf-8",
    csp: GO_REDIRECT_CSP,
    body:
      "<!DOCTYPE html>\n" +
      "<html><head>\n" +
      '<meta charset="utf-8">\n' +
      `<meta http-equiv="refresh" content="1;url=${escapedDeepLink}">\n` +
      "<title>Переход в бота</title>\n" +
      `${gtagScript}\n` +
      "</head><body>\n" +
      `<p>Переход в бота... <a href="${escapedDeepLink}">Открыть</a></p>\n` +
      "</body></html>"
  };
}

function writeGoRedirect(
  res: ServerResponse,
  requestUrl: string,
  botUsername: string | undefined,
  gaMeasurementId: string | undefined
): void {
  const response = buildGoRedirectResponse({
    requestUrl,
    botUsername,
    gaMeasurementId
  });
  res.statusCode = response.statusCode;
  res.setHeader("content-type", response.contentType);
  if (response.csp) {
    res.setHeader("content-security-policy", response.csp);
  }
  res.end(response.body);
}

function buildGtagScript(rawMeasurementId: string | undefined): string {
  const measurementId = sanitizeGaMeasurementId(rawMeasurementId);
  if (!measurementId) {
    return "";
  }
  const encodedId = encodeURIComponent(measurementId);
  const escapedId = escapeHtml(measurementId);
  return (
    `<script async src="https://www.googletagmanager.com/gtag/js?id=${encodedId}"></script>\n` +
    `<script>window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments);}gtag('js',new Date());gtag('config','${escapedId}');</script>`
  );
}

function sanitizeGaMeasurementId(raw: string | undefined): string | null {
  if (!raw) {
    return null;
  }
  const normalized = raw.trim().replace(/[^a-zA-Z0-9-]/g, "").slice(0, 64);
  return normalized.length > 0 ? normalized : null;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
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
    text,
    ...(isForwardedMessage(ctx.message) ? { isForwarded: true } : {})
  };
}

function toCallbackEvent(ctx: Context): IncomingEvent {
  return {
    updateId: ctx.update.update_id,
    userId: String(ctx.from?.id ?? ""),
    callbackData: ctx.callbackQuery?.data
  };
}

interface EventSourceContext {
  update: {
    update_id: number;
  };
  from?: {
    id: number | string;
  };
  message?: unknown;
}

export function toVoiceTextEvent(ctx: EventSourceContext, text: string): IncomingEvent {
  return {
    updateId: ctx.update.update_id,
    userId: String(ctx.from?.id ?? ""),
    text,
    inputSource: "voice",
    ...(isForwardedMessage(ctx.message) ? { isForwarded: true } : {})
  };
}

export function toScreenshotTextEvent(ctx: EventSourceContext, text: string): IncomingEvent {
  return {
    updateId: ctx.update.update_id,
    userId: String(ctx.from?.id ?? ""),
    text,
    inputSource: "screenshot",
    ...(isForwardedMessage(ctx.message) ? { isForwarded: true } : {})
  };
}

function isForwardedMessage(message: unknown): boolean {
  if (typeof message !== "object" || message === null) {
    return false;
  }
  return "forward_origin" in message || "forward_date" in message;
}

type VoicePreflightFailure = "too_long" | "too_large";

interface VoicePreflightInput {
  duration?: number;
  file_size?: number;
}

export function getVoicePreflightFailure(voice: VoicePreflightInput): VoicePreflightFailure | null {
  if (typeof voice.duration === "number" && voice.duration > VOICE_MAX_DURATION_SECONDS) {
    return "too_long";
  }
  if (typeof voice.file_size === "number" && voice.file_size > VOICE_MAX_FILE_SIZE_BYTES) {
    return "too_large";
  }
  return null;
}

function formatVoicePreflightFailure(reason: VoicePreflightFailure): string {
  if (reason === "too_long") {
    return "Голосовое слишком длинное. Скинь до 10 минут или отправь текстом.";
  }
  return "Голосовое слишком большое. Сожми/перезапиши короче или отправь текстом.";
}

type ScreenshotPreflightFailure = "too_large";

export interface TelegramPhotoSizeInput {
  file_id: string;
  file_unique_id?: string;
  width: number;
  height: number;
  file_size?: number;
}

export function getLargestPhoto(photos: readonly TelegramPhotoSizeInput[]): TelegramPhotoSizeInput | null {
  if (photos.length === 0) {
    return null;
  }
  return photos.reduce((largest, photo) => {
    const largestScore = largest.file_size ?? largest.width * largest.height;
    const photoScore = photo.file_size ?? photo.width * photo.height;
    return photoScore > largestScore ? photo : largest;
  });
}

export function getScreenshotPreflightFailure(photo: Pick<TelegramPhotoSizeInput, "file_size">): ScreenshotPreflightFailure | null {
  if (typeof photo.file_size === "number" && photo.file_size > SCREENSHOT_MAX_FILE_SIZE_BYTES) {
    return "too_large";
  }
  return null;
}

type PaidMediaPreflightFailure = "insufficient_balance";

interface PaidMediaPreflightInput {
  userId: string;
  billingConfig: BillingConfig;
  balanceStore: BalanceStore;
  bypassBalanceUserIds: Set<string>;
}

export function getPaidMediaPreflightFailure(input: PaidMediaPreflightInput): PaidMediaPreflightFailure | null {
  if (!input.billingConfig.isConfigured || input.bypassBalanceUserIds.has(input.userId)) {
    return null;
  }
  input.balanceStore.ensureBalance(input.userId);
  return input.balanceStore.getBalance(input.userId) < 1 ? "insufficient_balance" : null;
}

interface MediaQuotaState {
  windowStartTs: number;
  points: number;
}

export type MediaQuotaResult =
  | {
      allowed: true;
      maxPoints: number;
      usedPoints: number;
      remainingPoints: number;
    }
  | {
      allowed: false;
      maxPoints: number;
      usedPoints: number;
      requestedPoints: number;
      retryAfterMs: number;
    };

export class MediaQuota {
  private readonly states = new Map<string, MediaQuotaState>();
  private readonly windowMs: number;
  private readonly maxPoints: number;

  constructor(options: { windowMs?: number; maxPoints?: number } = {}) {
    this.windowMs = options.windowMs ?? MEDIA_QUOTA_WINDOW_MS;
    this.maxPoints = options.maxPoints ?? MEDIA_QUOTA_MAX_POINTS;
  }

  tryConsume(userId: string, points: number, now: number = Date.now()): MediaQuotaResult {
    const requestedPoints = normalizeQuotaPoints(points);
    const existing = this.states.get(userId);
    const state = existing && now - existing.windowStartTs < this.windowMs
      ? existing
      : { windowStartTs: now, points: 0 };

    if (state.points + requestedPoints > this.maxPoints) {
      this.states.set(userId, state);
      return {
        allowed: false,
        maxPoints: this.maxPoints,
        usedPoints: state.points,
        requestedPoints,
        retryAfterMs: Math.max(0, state.windowStartTs + this.windowMs - now)
      };
    }

    state.points += requestedPoints;
    this.states.set(userId, state);
    return {
      allowed: true,
      maxPoints: this.maxPoints,
      usedPoints: state.points,
      remainingPoints: Math.max(0, this.maxPoints - state.points)
    };
  }
}

export function getVoiceMediaQuotaPoints(voice: Pick<VoicePreflightInput, "duration">): number {
  const duration = typeof voice.duration === "number" && Number.isFinite(voice.duration)
    ? Math.max(1, voice.duration)
    : 1;
  return Math.max(1, Math.ceil(duration / VOICE_SECONDS_PER_MEDIA_QUOTA_POINT));
}

export function getScreenshotMediaQuotaPoints(): number {
  return 1;
}

function normalizeQuotaPoints(points: number): number {
  return Number.isFinite(points) ? Math.max(1, Math.ceil(points)) : 1;
}

function formatScreenshotPreflightFailure(reason: ScreenshotPreflightFailure): string {
  if (reason === "too_large") {
    return "Скрин слишком большой. Пришли сжатым фото или текстом.";
  }
  return "Не смог принять скрин. Пришли фото поменьше или текстом.";
}

function formatMediaQuotaFailure(result: Extract<MediaQuotaResult, { allowed: false }>): string {
  const retryMinutes = Math.max(1, Math.ceil(result.retryAfterMs / 60_000));
  return `Слишком много войсов/скринов за короткое время. Подожди ${retryMinutes} мин. или отправь текстом.`;
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

function safeCompareHeader(received: string | undefined, expected: string): boolean {
  if (!received) {
    return false;
  }
  const a = Buffer.from(received);
  const b = Buffer.from(expected);
  if (a.length !== b.length) {
    return false;
  }
  return timingSafeEqual(a, b);
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
