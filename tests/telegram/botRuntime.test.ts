import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { BalanceStore } from "../../src/billing/balanceStore.js";
import type { BillingConfig } from "../../src/billing/config.js";
import { ReferralService } from "../../src/growth/referral.js";
import { AnalyticsService } from "../../src/observability/analytics.js";
import { createInitialSessionState } from "../../src/state/session.js";
import { SqliteStore } from "../../src/state/store.js";
import { BotRuntime } from "../../src/telegram/bot.js";
import { UXHandlers } from "../../src/telegram/uxHandlers.js";

const tempDirs: string[] = [];
const stores: SqliteStore[] = [];

afterEach(() => {
  for (const store of stores) {
    store.close();
  }
  stores.length = 0;
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  tempDirs.length = 0;
});

function createGrowthDeps() {
  const dir = mkdtempSync(join(tmpdir(), "five-friends-botruntime-"));
  tempDirs.push(dir);
  const store = new SqliteStore(join(dir, "bot.sqlite"));
  stores.push(store);
  const db = store.getDb();
  return {
    store,
    referrals: new ReferralService(db),
    analytics: new AnalyticsService({ db })
  };
}

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

describe("bot runtime hooks", () => {
  it("calls clearLongTerm only after forget confirmation", async () => {
    const calls: string[] = [];
    const runtime = new BotRuntime(new UXHandlers(), {
      async generate() {
        return { messages: [], billable: false };
      },
      clearLongTerm(userId: string) {
        calls.push(`forget:${userId}`);
      }
    });

    await runtime.processEvent({
      updateId: 1,
      userId: "u1",
      command: "/forget"
    });

    expect(calls).toHaveLength(0);

    await runtime.processEvent({
      updateId: 2,
      userId: "u1",
      callbackData: "forget_confirm_yes"
    });

    expect(calls).toContain("forget:u1");
  });

  it("calls resetSession only after reset confirmation", async () => {
    const calls: Array<{ userId: string; previousSessionId: string; newSessionId: string }> = [];
    const runtime = new BotRuntime(new UXHandlers(), {
      async generate() {
        return { messages: [], billable: false };
      },
      resetSession(input) {
        calls.push(input);
      }
    });

    await runtime.processEvent({
      updateId: 1,
      userId: "u2",
      command: "/reset"
    });

    expect(calls).toHaveLength(0);

    await runtime.processEvent({
      updateId: 2,
      userId: "u2",
      callbackData: "reset_confirm_yes"
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.userId).toBe("u2");
    expect(calls[0]?.previousSessionId).not.toBe(calls[0]?.newSessionId);
  });

  it("shows explicit GPT failure message instead of panel placeholder", async () => {
    const runtime = new BotRuntime(new UXHandlers(), {
      async generate() {
        throw new Error("network down");
      }
    });

    await runtime.processEvent({
      updateId: 1,
      userId: "u3",
      text: "все сразу"
    });

    const collected = await runtime.processEvent({
      updateId: 2,
      userId: "u3",
      text: "моя ситуация"
    });
    expect(collected.messages[0]?.text).toContain("Принял 1");

    const result = await runtime.processEvent({
      updateId: 3,
      userId: "u3",
      callbackData: "conversation_done"
    });

    expect(result.messages[0]?.text).toContain("Что-то пошло не так");
    expect(result.messages[0]?.text).not.toContain("Собираю разбор");
  });

  it("does not add post-panel follow-up messages on success", async () => {
    const runtime = new BotRuntime(new UXHandlers(), {
      async generate() {
        return {
          messages: [{ text: "🧠 Ян — Разум\n...\n📌 Инна — Сводка\n..." }],
          billable: true
        };
      }
    });

    await runtime.processEvent({
      updateId: 1,
      userId: "u4",
      text: "все сразу"
    });

    const collected = await runtime.processEvent({
      updateId: 2,
      userId: "u4",
      text: "моя ситуация"
    });
    expect(collected.messages[0]?.text).toContain("Принял 1");

    const result = await runtime.processEvent({
      updateId: 3,
      userId: "u4",
      callbackData: "conversation_done"
    });

    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]?.text).toContain("📌 Инна — Сводка");
  });

  it("returns generated SINGLE reply without echo placeholder", async () => {
    const runtime = new BotRuntime(new UXHandlers(), {
      async generate() {
        return {
          messages: [{ text: "🧠 Ян — Разум\nГотовый ответ от модели." }],
          billable: true
        };
      }
    });

    await runtime.processEvent({
      updateId: 1,
      userId: "u5",
      callbackData: "choose_friend:yan"
    });

    const result = await runtime.processEvent({
      updateId: 2,
      userId: "u5",
      text: "мне тревожно"
    });

    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]?.text).toContain("Готовый ответ от модели");
    expect(result.messages[0]?.text).not.toContain("(Ян)");
  });

  it("appends share prompt after compose flow", async () => {
    const deps = createGrowthDeps();
    const runtime = new BotRuntime(
      new UXHandlers({
        referrals: deps.referrals,
        analytics: deps.analytics
      }),
      {
        async generate() {
          return {
            messages: [{ text: "🧠 Ян — Разум\nЧерновик готов." }],
            billable: true
          };
        }
      },
      {
        referrals: deps.referrals,
        analytics: deps.analytics,
        botUsername: "my_test_bot"
      }
    );

    await runtime.processEvent({
      updateId: 1,
      userId: "u-share",
      callbackData: "choose_friend:yan"
    });
    await runtime.processEvent({
      updateId: 2,
      userId: "u-share",
      text: "Напиши за меня"
    });

    const collected = await runtime.processEvent({
      updateId: 3,
      userId: "u-share",
      text: "Нужно написать коллеге про перенос встречи."
    });
    expect(collected.messages[0]?.text).toContain("Принял 1");

    const result = await runtime.processEvent({
      updateId: 4,
      userId: "u-share",
      callbackData: "conversation_done"
    });

    expect(result.messages).toHaveLength(2);
    expect(result.messages[1]?.text).toBe("Что дальше?");
    expect(result.messages[1]?.keyboard?.[0]?.[0]).toMatchObject({
      text: "Посоветовать бота",
      data: "sh"
    });
  });

  it("shows hard paywall when balance is insufficient before generation", async () => {
    const deps = createGrowthDeps();
    const balanceStore = new BalanceStore(deps.store.getDb());
    const userId = "u-paywall";
    balanceStore.ensureBalance(userId, 0);
    let generateCalls = 0;

    const runtime = new BotRuntime(
      new UXHandlers({
        analytics: deps.analytics
      }),
      {
        async generate() {
          generateCalls += 1;
          return {
            messages: [{ text: "should not happen" }],
            billable: true
          };
        }
      },
      {
        analytics: deps.analytics,
        balanceStore,
        firstPanelStateStore: deps.store,
        bypassBalanceUserIds: new Set(),
        billingConfig: configuredBillingConfig()
      }
    );

    await runtime.processEvent({
      updateId: 1,
      userId,
      callbackData: "choose_friend:yan"
    });

    const result = await runtime.processEvent({
      updateId: 2,
      userId,
      text: "помоги с текстом"
    });

    expect(generateCalls).toBe(0);
    expect(result.messages[0]?.text).toBe(
      "Друзья на паузе ☕\n\nБесплатные разговоры закончились. Пополни баланс, чтобы продолжить — ребята ждут."
    );
    expect(result.messages[0]?.keyboard).toHaveLength(3);

    const row = deps.store
      .getDb()
      .prepare<[string], { total: number }>("SELECT COALESCE(SUM(count), 0) AS total FROM event_daily WHERE event = ?")
      .get("paywall_shown");
    expect(Number(row?.total ?? 0)).toBe(1);

    const beforeFirstPanel = deps.store
      .getDb()
      .prepare<[string], { total: number }>("SELECT COALESCE(SUM(count), 0) AS total FROM event_daily WHERE event = ?")
      .get("paywall_before_first_panel");
    expect(Number(beforeFirstPanel?.total ?? 0)).toBe(1);
  });

  it("does not emit before-first-panel paywall analytics when no first panel store is configured", async () => {
    const deps = createGrowthDeps();
    const balanceStore = new BalanceStore(deps.store.getDb());
    const userId = "u-paywall-no-panel-store";
    balanceStore.ensureBalance(userId, 0);

    const runtime = new BotRuntime(
      new UXHandlers({
        analytics: deps.analytics
      }),
      {
        async generate() {
          return { messages: [{ text: "should not happen" }], billable: true };
        }
      },
      {
        analytics: deps.analytics,
        balanceStore,
        bypassBalanceUserIds: new Set(),
        billingConfig: configuredBillingConfig()
      }
    );

    await runtime.processEvent({
      updateId: 1,
      userId,
      callbackData: "choose_friend:yan"
    });

    await runtime.processEvent({
      updateId: 2,
      userId,
      text: "помоги с текстом"
    });

    const beforeFirstPanel = deps.store
      .getDb()
      .prepare<[string], { total: number }>("SELECT COALESCE(SUM(count), 0) AS total FROM event_daily WHERE event = ?")
      .get("paywall_before_first_panel");
    expect(Number(beforeFirstPanel?.total ?? 0)).toBe(0);
  });

  it("returns crisis responder instead of paywall for hard safety message at zero balance", async () => {
    const deps = createGrowthDeps();
    const balanceStore = new BalanceStore(deps.store.getDb());
    const userId = "u-paywall-hard-safety";
    balanceStore.ensureBalance(userId, 0);
    let generateCalls = 0;

    const runtime = new BotRuntime(
      new UXHandlers({
        analytics: deps.analytics
      }),
      {
        async generate() {
          generateCalls += 1;
          return { messages: [{ text: "should not happen" }], billable: true };
        }
      },
      {
        analytics: deps.analytics,
        balanceStore,
        firstPanelStateStore: deps.store,
        bypassBalanceUserIds: new Set(),
        billingConfig: configuredBillingConfig()
      }
    );

    await runtime.processEvent({
      updateId: 1,
      userId,
      callbackData: "choose_friend:yan"
    });

    const result = await runtime.processEvent({
      updateId: 2,
      userId,
      text: "Я хочу умереть."
    });

    expect(generateCalls).toBe(0);
    expect(result.messages[0]?.text).toContain("Мне очень жаль");
    expect(result.messages[0]?.text).not.toContain("Друзья на паузе");
  });

  it("returns soft safety check instead of paywall for soft safety message at zero balance", async () => {
    const deps = createGrowthDeps();
    const balanceStore = new BalanceStore(deps.store.getDb());
    const userId = "u-paywall-soft-safety";
    balanceStore.ensureBalance(userId, 0);
    let generateCalls = 0;

    const runtime = new BotRuntime(
      new UXHandlers({
        analytics: deps.analytics
      }),
      {
        async generate() {
          generateCalls += 1;
          return { messages: [{ text: "should not happen" }], billable: true };
        }
      },
      {
        analytics: deps.analytics,
        balanceStore,
        firstPanelStateStore: deps.store,
        bypassBalanceUserIds: new Set(),
        billingConfig: configuredBillingConfig()
      }
    );

    await runtime.processEvent({
      updateId: 1,
      userId,
      callbackData: "choose_friend:yan"
    });

    const result = await runtime.processEvent({
      updateId: 2,
      userId,
      text: "Я не хочу жить."
    });

    expect(generateCalls).toBe(0);
    expect(result.messages[0]?.text).toContain("Это про реальную опасность");
    expect(result.messages[0]?.text).not.toContain("Друзья на паузе");
  });

  it("adds grace message when deduction brings balance to zero", async () => {
    const deps = createGrowthDeps();
    const balanceStore = new BalanceStore(deps.store.getDb());
    const userId = "u-grace";
    balanceStore.ensureBalance(userId, 1);

    const runtime = new BotRuntime(
      new UXHandlers(),
      {
        async generate() {
          return {
            messages: [{ text: "🧠 Ян — Разум\nОтвет." }],
            billable: true
          };
        }
      },
      {
        balanceStore,
        bypassBalanceUserIds: new Set(),
        billingConfig: configuredBillingConfig()
      }
    );

    await runtime.processEvent({
      updateId: 1,
      userId,
      callbackData: "choose_friend:yan"
    });

    const result = await runtime.processEvent({
      updateId: 2,
      userId,
      text: "что делать?"
    });

    expect(result.messages).toHaveLength(2);
    expect(result.messages[1]?.text).toBe(
      "💬 Это было последнее сообщение. Чтобы продолжить разбираться вместе — пополни баланс:"
    );
    expect(result.messages[1]?.keyboard).toHaveLength(3);
    expect(balanceStore.getBalance(userId)).toBe(0);
  });

  it("does not deduct or append share for billable:false generation", async () => {
    const deps = createGrowthDeps();
    const balanceStore = new BalanceStore(deps.store.getDb());
    const userId = "u-non-billable";
    balanceStore.ensureBalance(userId, 5);

    const runtime = new BotRuntime(
      new UXHandlers({
        referrals: deps.referrals,
        analytics: deps.analytics
      }),
      {
        async generate() {
          return {
            messages: [{ text: "safety response" }],
            billable: false
          };
        }
      },
      {
        referrals: deps.referrals,
        analytics: deps.analytics,
        botUsername: "my_test_bot",
        balanceStore,
        bypassBalanceUserIds: new Set(),
        billingConfig: configuredBillingConfig()
      }
    );

    await runtime.processEvent({
      updateId: 1,
      userId,
      callbackData: "choose_friend:yan"
    });
    await runtime.processEvent({
      updateId: 2,
      userId,
      text: "Напиши за меня"
    });

    const result = await runtime.processEvent({
      updateId: 3,
      userId,
      text: "тут могла быть billable задача"
    });

    expect(result.messages).toHaveLength(1);
    expect(balanceStore.getBalance(userId)).toBe(5);
    const toolWrite = deps.store
      .getDb()
      .prepare<[string], { total: number }>("SELECT COALESCE(SUM(count), 0) AS total FROM event_daily WHERE event = ?")
      .get("tool_write_for_me");
    expect(Number(toolWrite?.total ?? 0)).toBe(0);
  });

  it("bypasses billing, share and billable analytics for forceFree llm tasks", async () => {
    const deps = createGrowthDeps();
    const balanceStore = new BalanceStore(deps.store.getDb());
    const userId = "u-force-free";
    balanceStore.ensureBalance(userId, 0);

    const state = createInitialSessionState({
      sessionId: "force-free-session",
      now: 1_000
    });

    const handlers = {
      handleEvent: vi.fn(() => ({
        messages: [{ text: "preface" }],
        state,
        llmTask: {
          mode: "SINGLE",
          persona: "yan",
          scenario: "compose",
          userText: "Сформулируй сообщение коллеге",
          forceFree: true
        }
      }))
    } as unknown as UXHandlers;

    const generate = vi.fn(async () => ({
      messages: [{ text: "🧠 Ян — Разум\nПривет, давай начнем с малого шага." }],
      billable: true
    }));

    const runtime = new BotRuntime(
      handlers,
      { generate },
      {
        referrals: deps.referrals,
        analytics: deps.analytics,
        botUsername: "my_test_bot",
        balanceStore,
        bypassBalanceUserIds: new Set(),
        billingConfig: configuredBillingConfig()
      }
    );

    const result = await runtime.processEvent({
      updateId: 1,
      userId,
      text: "любой вход"
    });

    expect(generate).toHaveBeenCalledTimes(1);
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]?.text).toContain("Привет, давай начнем");
    expect(result.messages[0]?.text).not.toBe("Что дальше?");
    expect(balanceStore.getBalance(userId)).toBe(0);

    const paywallShown = deps.store
      .getDb()
      .prepare<[string], { total: number }>("SELECT COALESCE(SUM(count), 0) AS total FROM event_daily WHERE event = ?")
      .get("paywall_shown");
    expect(Number(paywallShown?.total ?? 0)).toBe(0);

    const toolWrite = deps.store
      .getDb()
      .prepare<[string], { total: number }>("SELECT COALESCE(SUM(count), 0) AS total FROM event_daily WHERE event = ?")
      .get("tool_write_for_me");
    expect(Number(toolWrite?.total ?? 0)).toBe(0);
  });

  it("emits ask_all event for forceFree panel and marks first panel as seen", async () => {
    const deps = createGrowthDeps();
    const userId = "u-forcefree-panel";

    const state = createInitialSessionState({
      sessionId: "forcefree-panel-session",
      now: 1_000
    });

    const handlers = {
      handleEvent: vi.fn(() => ({
        messages: [{ text: "preface" }],
        state,
        llmTask: {
          mode: "PANEL",
          userText: "Разберите ситуацию",
          forceFree: true
        },
        analyticsContext: {
          askAllOrigin: "auto_cs_situation"
        }
      }))
    } as unknown as UXHandlers;

    const runtime = new BotRuntime(
      handlers,
      {
        async generate() {
          return {
            messages: [{ text: "🧠 Ян — Разум\n...\n❤️ Наташа — Сердце\n...\n🌀 Аня — Смысл\n...\n🎯 Макс — Реальность\n..." }],
            billable: true
          };
        }
      },
      {
        analytics: deps.analytics,
        firstPanelStateStore: deps.store
      }
    );

    const result = await runtime.processEvent({
      updateId: 1,
      userId,
      text: "любой вход"
    });

    expect(result.messages).toHaveLength(1);
    const askAll = deps.store
      .getDb()
      .prepare<[string], { total: number }>("SELECT COALESCE(SUM(count), 0) AS total FROM event_daily WHERE event = ?")
      .get("ask_all");
    expect(Number(askAll?.total ?? 0)).toBe(1);
    expect(deps.store.hasSeenFirstPanel(userId)).toBe(true);
  });

  it("returns generated response even if balance deduction fails", async () => {
    const deps = createGrowthDeps();
    const userId = "u-deduct-fail";
    const failingBalanceStore = {
      ensureBalance() {},
      getBalance() {
        return 10;
      },
      deductBalance() {
        throw new Error("disk full");
      },
      addBalance() {
        return { credited: true, balance: 10 };
      },
      getBalanceInfo() {
        return { balance: 10, totalPurchased: 0, totalSpent: 0 };
      }
    } as unknown as BalanceStore;

    const runtime = new BotRuntime(
      new UXHandlers({
        analytics: deps.analytics
      }),
      {
        async generate() {
          return {
            messages: [{ text: "🧠 Ян — Разум\nОтвет от модели." }],
            billable: true
          };
        }
      },
      {
        analytics: deps.analytics,
        balanceStore: failingBalanceStore,
        bypassBalanceUserIds: new Set(),
        billingConfig: configuredBillingConfig()
      }
    );

    await runtime.processEvent({
      updateId: 1,
      userId,
      callbackData: "choose_friend:yan"
    });

    const result = await runtime.processEvent({
      updateId: 2,
      userId,
      text: "нужен ответ"
    });

    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]?.text).toContain("Ответ от модели.");
    expect(result.messages[0]?.text).not.toContain("Что-то пошло не так");
  });
});
