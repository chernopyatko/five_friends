import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { BalanceStore } from "../src/billing/balanceStore.js";
import type { BillingConfig } from "../src/billing/config.js";
import {
  buildGoRedirectResponse,
  estimatePaidMediaRequiredBalance,
  getLargestPhoto,
  getPaidMediaPreflightFailure,
  getScreenshotMediaQuotaPoints,
  getScreenshotPreflightFailure,
  getVoiceMediaQuotaPoints,
  getVoicePreflightFailure,
  MediaQuota,
  parseSupportedCommand,
  processCallbackQueryUpdate,
  runWithTypingIndicator,
  toScreenshotTextEvent,
  toVoiceTextEvent
} from "../src/index.js";
import { SqliteStore } from "../src/state/store.js";

function configuredBillingConfig(): BillingConfig {
  return {
    tributeApiSecret: "secret",
    tributeLinks: {
      small: "https://pay.example/small",
      medium: "https://pay.example/medium",
      large: "https://pay.example/large"
    },
    productMap: {
      p50: 50
    },
    isConfigured: true
  };
}

describe("index command parsing", () => {
  it("parses supported commands", () => {
    expect(parseSupportedCommand("/start")).toEqual({ command: "/start", payload: undefined });
    expect(parseSupportedCommand("/friends@mybot")).toEqual({ command: "/friends", payload: undefined });
    expect(parseSupportedCommand("/reset now")).toEqual({ command: "/reset", payload: undefined });
    expect(parseSupportedCommand("/settings")).toEqual({ command: "/settings", payload: undefined });
    expect(parseSupportedCommand("/demo")).toEqual({ command: "/demo", payload: undefined });
    expect(parseSupportedCommand("/balance")).toEqual({ command: "/balance", payload: undefined });
  });

  it("extracts /start payload for deep links", () => {
    expect(parseSupportedCommand("/start ref_abc123")).toEqual({
      command: "/start",
      payload: "ref_abc123"
    });
    expect(parseSupportedCommand("/start@mybot ref_abc123")).toEqual({
      command: "/start",
      payload: "ref_abc123"
    });
  });

  it("returns null for unsupported commands or plain text", () => {
    expect(parseSupportedCommand("hello")).toBeNull();
    expect(parseSupportedCommand("/unknown")).toBeNull();
  });

  it("maps voice transcript to a normal text event, including forwarded voices", () => {
    const event = toVoiceTextEvent({
      update: { update_id: 42 },
      from: { id: 777 },
      message: {
        voice: { file_id: "voice-file-id", file_unique_id: "voice-unique-id", duration: 12 },
        forward_origin: {
          type: "user",
          date: 1,
          sender_user: { id: 100, is_bot: false, first_name: "Ivan" }
        }
      }
    }, "пересланный голосовой текст");

    expect(event).toEqual({
      updateId: 42,
      userId: "777",
      text: "пересланный голосовой текст",
      inputSource: "voice",
      isForwarded: true
    });
  });

  it("maps screenshot recognition to a normal text event", () => {
    const event = toScreenshotTextEvent({
      update: { update_id: 43 },
      from: { id: 888 },
      message: {
        photo: [{ file_id: "photo-file-id", file_unique_id: "photo-unique-id", width: 1280, height: 720 }]
      }
    }, "текст со скриншота переписки");

    expect(event).toEqual({
      updateId: 43,
      userId: "888",
      text: "текст со скриншота переписки",
      inputSource: "screenshot"
    });
  });

  it("rejects oversized or too long voice messages before download/transcription", () => {
    expect(getVoicePreflightFailure({ duration: 601 })).toBe("too_long");
    expect(getVoicePreflightFailure({ duration: 600, file_size: 20 * 1024 * 1024 })).toBeNull();
    expect(getVoicePreflightFailure({ duration: 20, file_size: 20 * 1024 * 1024 + 1 })).toBe("too_large");
    expect(getVoicePreflightFailure({ duration: 20, file_size: 100_000 })).toBeNull();
  });

  it("selects the largest photo and rejects oversized screenshots before download", () => {
    expect(getLargestPhoto([
      { file_id: "small", width: 320, height: 240, file_size: 1000 },
      { file_id: "large", width: 1280, height: 720, file_size: 3000 },
      { file_id: "medium", width: 800, height: 600, file_size: 2000 }
    ])?.file_id).toBe("large");
    expect(getLargestPhoto([])).toBeNull();
    expect(getScreenshotPreflightFailure({ file_size: 10 * 1024 * 1024 })).toBeNull();
    expect(getScreenshotPreflightFailure({ file_size: 10 * 1024 * 1024 + 1 })).toBe("too_large");
  });

  it("limits media recognition per user by quota points", () => {
    const quota = new MediaQuota({ windowMs: 60 * 60 * 1000, maxPoints: 12 });
    const now = 1_000;

    for (let i = 0; i < 12; i += 1) {
      expect(quota.tryConsume("u-media", getScreenshotMediaQuotaPoints(), now).allowed).toBe(true);
    }

    const blocked = quota.tryConsume("u-media", getScreenshotMediaQuotaPoints(), now);
    expect(blocked).toMatchObject({
      allowed: false,
      maxPoints: 12,
      requestedPoints: 1
    });
    expect(quota.tryConsume("u-media", getScreenshotMediaQuotaPoints(), now + 60 * 60 * 1000).allowed).toBe(true);
  });

  it("refunds media quota after recognition failure", () => {
    const quota = new MediaQuota({ windowMs: 60 * 60 * 1000, maxPoints: 1 });
    const now = 1_000;

    expect(quota.tryConsume("u-media", 1, now).allowed).toBe(true);
    expect(quota.tryConsume("u-media", 1, now).allowed).toBe(false);
    quota.refund("u-media", 1);
    expect(quota.tryConsume("u-media", 1, now).allowed).toBe(true);
  });

  it("counts voice quota points by rounded-up minutes", () => {
    expect(getVoiceMediaQuotaPoints({ duration: 1 })).toBe(1);
    expect(getVoiceMediaQuotaPoints({ duration: 60 })).toBe(1);
    expect(getVoiceMediaQuotaPoints({ duration: 61 })).toBe(2);
    expect(getVoiceMediaQuotaPoints({ duration: 600 })).toBe(10);

    const quota = new MediaQuota({ windowMs: 60 * 60 * 1000, maxPoints: 24 });
    expect(quota.tryConsume("u-voice", getVoiceMediaQuotaPoints({ duration: 600 }), 1_000).allowed).toBe(true);
    expect(quota.tryConsume("u-voice", getVoiceMediaQuotaPoints({ duration: 600 }), 1_000).allowed).toBe(true);
    expect(quota.tryConsume("u-voice", getVoiceMediaQuotaPoints({ duration: 600 }), 1_000).allowed).toBe(false);
  });

  it("blocks paid media recognition when configured billing balance is empty", () => {
    const dir = mkdtempSync(join(tmpdir(), "five-friends-media-preflight-"));
    const store = new SqliteStore(join(dir, "bot.sqlite"));

    try {
      const balanceStore = new BalanceStore(store.getDb());
      const billingConfig = configuredBillingConfig();
      balanceStore.ensureBalance("u-empty", 0);
      balanceStore.ensureBalance("u-paid", 1);
      balanceStore.ensureBalance("u-panel-short", 2);
      balanceStore.ensureBalance("u-panel-ready", 3);

      expect(getPaidMediaPreflightFailure({
        userId: "u-empty",
        billingConfig,
        balanceStore,
        bypassBalanceUserIds: new Set()
      })).toBe("insufficient_balance");
      expect(getPaidMediaPreflightFailure({
        userId: "u-paid",
        billingConfig,
        balanceStore,
        bypassBalanceUserIds: new Set()
      })).toBeNull();
      expect(getPaidMediaPreflightFailure({
        userId: "u-panel-short",
        billingConfig,
        balanceStore,
        bypassBalanceUserIds: new Set(),
        requiredBalance: 3
      })).toBe("insufficient_balance");
      expect(getPaidMediaPreflightFailure({
        userId: "u-panel-ready",
        billingConfig,
        balanceStore,
        bypassBalanceUserIds: new Set(),
        requiredBalance: 3
      })).toBeNull();
      expect(getPaidMediaPreflightFailure({
        userId: "u-empty",
        billingConfig,
        balanceStore,
        bypassBalanceUserIds: new Set(["u-empty"])
      })).toBeNull();
      expect(getPaidMediaPreflightFailure({
        userId: "u-empty",
        billingConfig: { ...billingConfig, isConfigured: false },
        balanceStore,
        bypassBalanceUserIds: new Set()
      })).toBeNull();
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("estimates paid media balance by current UX state", () => {
    expect(estimatePaidMediaRequiredBalance(undefined)).toBe(3);
    expect(estimatePaidMediaRequiredBalance({
      currentPersona: null,
      pendingMode: null
    })).toBe(3);
    expect(estimatePaidMediaRequiredBalance({
      currentPersona: "yan",
      pendingMode: null
    })).toBe(1);
    expect(estimatePaidMediaRequiredBalance({
      currentPersona: "yan",
      pendingMode: "awaiting_collection_input"
    })).toBe(3);
    expect(estimatePaidMediaRequiredBalance({
      currentPersona: null,
      pendingMode: "awaiting_panel_input",
      pendingAutoPanelFromColdStart: true
    })).toBe(1);
  });

  it("builds /go redirect page with campaign payload", () => {
    const response = buildGoRedirectResponse({
      requestUrl: "/go?campaign=loneliness_01",
      botUsername: "mybot"
    });

    expect(response.statusCode).toBe(200);
    expect(response.contentType).toBe("text/html; charset=utf-8");
    expect(response.csp).toContain("default-src 'none'");
    expect(response.body).toContain("https://t.me/mybot?start=gads_loneliness_01");
  });

  it("sanitizes campaign and supports fallback without payload", () => {
    const withSanitizedCampaign = buildGoRedirectResponse({
      requestUrl: "/go?campaign=<script>alert(1)</script>",
      botUsername: "mybot"
    });
    expect(withSanitizedCampaign.body).toContain("https://t.me/mybot?start=gads_scriptalert1script");

    const withoutCampaign = buildGoRedirectResponse({
      requestUrl: "/go",
      botUsername: "mybot"
    });
    expect(withoutCampaign.body).toContain('content="1;url=https://t.me/mybot"');
    expect(withoutCampaign.body).not.toContain("?start=gads_");
  });

  it("returns 503 when bot username is missing", () => {
    const response = buildGoRedirectResponse({
      requestUrl: "/go?campaign=x"
    });
    expect(response.statusCode).toBe(503);
    expect(response.body).toContain("Bot not configured");
  });

  it("includes GA tag only when measurement id is valid", () => {
    const withGa = buildGoRedirectResponse({
      requestUrl: "/go?campaign=x",
      botUsername: "mybot",
      gaMeasurementId: "G-ABC123"
    });
    expect(withGa.body).toContain("googletagmanager.com/gtag/js?id=G-ABC123");

    const withoutGa = buildGoRedirectResponse({
      requestUrl: "/go?campaign=x",
      botUsername: "mybot",
      gaMeasurementId: "   "
    });
    expect(withoutGa.body).not.toContain("googletagmanager.com/gtag/js");
  });

  it("emits typing action for slow operations", async () => {
    const typingCalls: Array<{ chatId: number | string; action: "typing" }> = [];
    const ctx = {
      chat: { id: 42 },
      api: {
        async sendChatAction(chatId: number | string, action: "typing"): Promise<void> {
          typingCalls.push({ chatId, action });
        }
      }
    };

    const value = await runWithTypingIndicator(ctx, async () => {
      await new Promise((resolve) => setTimeout(resolve, 350));
      return "done";
    });

    expect(value).toBe("done");
    expect(typingCalls.length).toBeGreaterThan(0);
    expect(typingCalls[0]?.action).toBe("typing");
  });

  it("skips typing action when chat is missing", async () => {
    const typingCalls: Array<{ chatId: number | string; action: "typing" }> = [];
    const ctx = {
      api: {
        async sendChatAction(chatId: number | string, action: "typing"): Promise<void> {
          typingCalls.push({ chatId, action });
        }
      }
    };

    const value = await runWithTypingIndicator(ctx, async () => "ok");
    expect(value).toBe("ok");
    expect(typingCalls).toHaveLength(0);
  });

  it("answers callback queries before long processing and then sends messages", async () => {
    const calls: string[] = [];

    const result = await processCallbackQueryUpdate({
      async answerCallbackQuery() {
        calls.push("answer");
      },
      async processEvent() {
        calls.push("process");
        return {
          messages: [{ text: "ответ от модели" }],
          state: {} as never
        };
      },
      async sendMessages(messages) {
        calls.push(`send:${messages[0]?.text}`);
      }
    });

    expect(calls).toEqual(["answer", "process", "send:ответ от модели"]);
    expect(result.messages[0]?.text).toBe("ответ от модели");
  });

  it("still processes and sends callback result when callback ack fails", async () => {
    const calls: string[] = [];
    const errors: unknown[] = [];

    await processCallbackQueryUpdate({
      async answerCallbackQuery() {
        calls.push("answer");
        throw new Error("query is too old");
      },
      onAnswerCallbackError(error) {
        errors.push(error);
      },
      async processEvent() {
        calls.push("process");
        return {
          messages: [{ text: "ответ после старого callback" }],
          state: {} as never
        };
      },
      async sendMessages(messages) {
        calls.push(`send:${messages[0]?.text}`);
      }
    });

    expect(errors).toHaveLength(1);
    expect(calls).toEqual(["answer", "process", "send:ответ после старого callback"]);
  });
});
