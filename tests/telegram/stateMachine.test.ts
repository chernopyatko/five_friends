import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { BalanceStore } from "../../src/billing/balanceStore.js";
import { ReferralService } from "../../src/growth/referral.js";
import { AnalyticsService } from "../../src/observability/analytics.js";
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

function createGrowthHarness(): { handlers: UXHandlers; store: SqliteStore } {
  const dir = mkdtempSync(join(tmpdir(), "five-friends-growth-sm-"));
  tempDirs.push(dir);
  const store = new SqliteStore(join(dir, "bot.sqlite"));
  stores.push(store);
  const db = store.getDb();
  const referrals = new ReferralService(db);
  const analytics = new AnalyticsService({ db });
  const handlers = new UXHandlers({
    referrals,
    analytics,
    firstPanelStateStore: store,
    adminUserIds: ["admin-user"]
  });
  return { handlers, store };
}

function createGrowthEnabledHandlers(): UXHandlers {
  return createGrowthHarness().handlers;
}

function createHandlersWithBalance(): { handlers: UXHandlers; balanceStore: BalanceStore } {
  const dir = mkdtempSync(join(tmpdir(), "five-friends-balance-sm-"));
  tempDirs.push(dir);
  const store = new SqliteStore(join(dir, "bot.sqlite"));
  stores.push(store);
  const balanceStore = new BalanceStore(store.getDb());
  return {
    handlers: new UXHandlers({ balanceStore }),
    balanceStore
  };
}

function finishConversation(handlers: UXHandlers, userId: string, updateId: number) {
  return handlers.handleEvent({ updateId, userId, callbackData: "conversation_done" });
}

describe("stateMachine", () => {
  it("collects a forwarded message pack before asking who should answer", () => {
    const handlers = new UXHandlers();
    const userId = "u-forward-pack";
    let result = handlers.handleEvent({
      updateId: 1,
      userId,
      text: "Форвард 1: привет",
      now: 1000
    });

    expect(result.llmTask).toBeUndefined();
    expect(result.messages[0]?.text).toContain("Принял 1");
    expect(result.messages[0]?.text).not.toContain("Кого позвать");

    for (let i = 2; i <= 12; i += 1) {
      result = handlers.handleEvent({
        updateId: i,
        userId,
        text: `Форвард ${i}: часть переписки`,
        now: 1000
      });
      expect(result.llmTask).toBeUndefined();
      expect(result.messages[0]?.text).toContain(`Принял ${i}`);
      expect(result.messages[0]?.text).not.toContain("Слишком быстро");
      expect(result.messages[0]?.text).not.toContain("Кого позвать");
    }

    const done = handlers.handleEvent({
      updateId: 13,
      userId,
      callbackData: "conversation_done",
      now: 1000
    });

    expect(done.llmTask).toBeUndefined();
    expect(done.messages[0]?.text).toContain("Кого позвать");

    const withPersona = handlers.handleEvent({
      updateId: 14,
      userId,
      callbackData: "choose_friend:yan",
      now: 1000
    });

    expect(withPersona.llmTask?.mode).toBe("SINGLE");
    expect(withPersona.llmTask?.persona).toBe("yan");
    expect(withPersona.llmTask?.userText).toContain("Форвард 1: привет");
    expect(withPersona.llmTask?.userText).toContain("Форвард 12: часть переписки");
  });

  it("collects forwarded messages even when a friend is already selected", () => {
    const handlers = new UXHandlers();
    const userId = "u-forward-with-persona";
    handlers.handleEvent({
      updateId: 1,
      userId,
      callbackData: "choose_friend:max",
      now: 0
    });

    const first = handlers.handleEvent({
      updateId: 2,
      userId,
      text: "Переслано 1: привет",
      isForwarded: true,
      now: 1000
    });
    expect(first.llmTask).toBeUndefined();
    expect(first.messages[0]?.text).toContain("Принял 1");

    const second = handlers.handleEvent({
      updateId: 3,
      userId,
      text: "Переслано 2: а почему ты молчишь?",
      isForwarded: true,
      now: 1000
    });
    expect(second.llmTask).toBeUndefined();
    expect(second.messages[0]?.text).toContain("Принял 2");

    const done = finishConversation(handlers, userId, 4);
    expect(done.llmTask?.mode).toBe("SINGLE");
    expect(done.llmTask?.persona).toBe("max");
    expect(done.llmTask?.userText).toContain("Переслано 1: привет");
    expect(done.llmTask?.userText).toContain("Переслано 2: а почему ты молчишь?");
  });

  it("collects panel input fragments and runs ask-all only after Done", () => {
    const { handlers } = createGrowthHarness();
    const userId = "u-panel-pack";

    const pending = handlers.handleEvent({
      updateId: 1,
      userId,
      callbackData: "cs_situation"
    });
    expect(pending.state.pendingMode).toBe("awaiting_panel_input");

    const first = handlers.handleEvent({
      updateId: 2,
      userId,
      text: "Первый кусок: мы поссорились"
    });
    expect(first.llmTask).toBeUndefined();
    expect(first.messages[0]?.text).toContain("Принял 1");

    const second = handlers.handleEvent({
      updateId: 3,
      userId,
      text: "Второй кусок: он потом прислал голосовое"
    });
    expect(second.llmTask).toBeUndefined();
    expect(second.messages[0]?.text).toContain("Принял 2");

    const done = handlers.handleEvent({
      updateId: 4,
      userId,
      callbackData: "conversation_done"
    });
    expect(done.llmTask?.mode).toBe("PANEL");
    expect(done.llmTask?.forceFree).toBe(true);
    expect(done.analyticsContext?.askAllOrigin).toBe("auto_cs_situation");
    expect(done.llmTask?.userText).toContain("Первый кусок: мы поссорились");
    expect(done.llmTask?.userText).toContain("Второй кусок: он потом прислал голосовое");
  });

  it("collects pending text when no friend selected", () => {
    const handlers = new UXHandlers();
    const result = handlers.handleEvent({
      updateId: 1,
      userId: "u1",
      text: "привет"
    });

    expect(result.messages[0]?.text).toContain("Принял 1");
    expect(result.messages[0]?.text).not.toContain("Кого позвать");
    expect(result.state.pendingUserText).toBeNull();
    expect(result.state.pendingConversationParts).toEqual([{ source: "text", text: "привет" }]);
  });

  it("sets cold start text, inline keyboard and persistent main menu on /start", () => {
    const handlers = new UXHandlers();
    const result = handlers.handleEvent({
      updateId: 1,
      userId: "u-start",
      command: "/start"
    });

    expect(result.messages[0]?.text).toContain("Привет 👋 Мы на связи.");
    expect(result.messages[0]?.text).toContain("🧠 Ян: Рассказывай");
    expect(result.messages[0]?.text).toContain("🎯 Макс: Короче, выкладывай.");
    expect(result.state.pendingMode).toBe("awaiting_panel_input");
    expect(result.state.pendingPanelScenario).toBeNull();
    expect(result.messages[0]?.replyKeyboard?.[0]?.[0]).toBe("🚀 Спросить всех");
    expect(result.messages[0]?.replyKeyboard?.[0]?.[1]).toBe("👥 Друзья");
    expect(result.messages[0]?.replyKeyboard?.[2]?.[0]).toBe("📋 Итоги");
    const helpStart = result.messages[0]?.keyboard?.[0]?.[0];
    expect(helpStart && "data" in helpStart ? helpStart.data : null).toBe("cs_help_start");
  });

  it("runs first text after /start as forceFree panel after Done", () => {
    const { handlers } = createGrowthHarness();
    const start = handlers.handleEvent({
      updateId: 1,
      userId: "u-start-panel",
      command: "/start"
    });
    expect(start.state.pendingAutoPanelFromColdStart).toBe(true);

    const run = handlers.handleEvent({
      updateId: 2,
      userId: "u-start-panel",
      text: "Он написал: «я не уверен, что хочу продолжать». Что ответить?"
    });
    expect(run.llmTask).toBeUndefined();

    const done = finishConversation(handlers, "u-start-panel", 3);

    expect(done.llmTask?.mode).toBe("PANEL");
    expect(done.llmTask?.forceFree).toBe(true);
    expect(done.analyticsContext?.askAllOrigin).toBe("auto_cs_situation");
  });

  it("treats /friends as alias to /help", () => {
    const handlers = new UXHandlers();
    const result = handlers.handleEvent({
      updateId: 1,
      userId: "u-friends-alias",
      command: "/friends"
    });

    expect(result.messages[0]?.text).toContain("❓ Как тут всё устроено");
  });

  it("processes pending text after friend selection", () => {
    const handlers = new UXHandlers();
    handlers.handleEvent({ updateId: 1, userId: "u1", text: "нужна поддержка" });
    const result = handlers.handleEvent({
      updateId: 2,
      userId: "u1",
      callbackData: "choose_friend:yan"
    });

    expect(result.messages.length).toBeGreaterThanOrEqual(1);
    expect(result.messages[0]?.text).toContain("Сейчас с тобой Ян");
    expect(result.state.pendingUserText).toBeNull();
    expect(result.llmTask).toBeDefined();
    expect(result.llmTask?.mode).toBe("SINGLE");
    expect(result.llmTask?.userText).toContain("нужна поддержка");
  });

  it("rejects duplicate updates by idempotency rule", () => {
    const handlers = new UXHandlers();
    handlers.handleEvent({ updateId: 3, userId: "u1", text: "a" });
    const duplicate = handlers.handleEvent({ updateId: 3, userId: "u1", text: "b" });
    expect(duplicate.messages[0]?.text).toContain("устарела");
  });

  it("toggles reminders via settings callback", () => {
    const { handlers, balanceStore } = createHandlersWithBalance();
    const userId = "u-reminder-toggle";
    balanceStore.ensureBalance(userId);

    const disabled = handlers.handleEvent({
      updateId: 1,
      userId,
      callbackData: "settings_toggle_reminders"
    });
    expect(disabled.messages[0]?.text).toContain("отключены");
    expect(balanceStore.getRemindersEnabled(userId)).toBe(false);

    const enabled = handlers.handleEvent({
      updateId: 2,
      userId,
      callbackData: "settings_toggle_reminders"
    });
    expect(enabled.messages[0]?.text).toContain("включены");
    expect(balanceStore.getRemindersEnabled(userId)).toBe(true);
  });

  it("handles panel pending flow", () => {
    const handlers = new UXHandlers();
    handlers.handleEvent({ updateId: 1, userId: "u1", callbackData: "choose_friend:anya" });
    handlers.handleEvent({ updateId: 2, userId: "u1", text: "все сразу" });
    const collected = handlers.handleEvent({ updateId: 3, userId: "u1", text: "ситуация" });
    expect(collected.llmTask).toBeUndefined();

    const result = finishConversation(handlers, "u1", 4);

    expect(result.messages[0]?.text).toContain("Собираю разбор от всех друзей");
    expect(result.state.pendingMode).toBeNull();
  });

  it("sets panel pending mode via cs_situation callback", () => {
    const handlers = new UXHandlers();
    const result = handlers.handleEvent({
      updateId: 1,
      userId: "u-cs-situation",
      callbackData: "cs_situation"
    });

    expect(result.state.pendingMode).toBe("awaiting_panel_input");
    expect(result.state.pendingPanelScenario).toBeNull();
    expect(result.messages[0]?.text).toContain("Расскажи что случилось");
  });

  it("runs first cs_situation panel as forceFree with auto origin after Done", () => {
    const { handlers } = createGrowthHarness();

    const pending = handlers.handleEvent({
      updateId: 1,
      userId: "u-auto-panel",
      callbackData: "cs_situation"
    });
    expect(pending.state.pendingAutoPanelFromColdStart).toBe(true);

    const run = handlers.handleEvent({
      updateId: 2,
      userId: "u-auto-panel",
      text: "Мы с партнером снова поссорились и не разговариваем."
    });
    expect(run.llmTask).toBeUndefined();

    const done = finishConversation(handlers, "u-auto-panel", 3);

    expect(done.llmTask?.mode).toBe("PANEL");
    expect(done.llmTask?.forceFree).toBe(true);
    expect(done.analyticsContext?.askAllOrigin).toBe("auto_cs_situation");
    expect(done.state.pendingAutoPanelFromColdStart).toBe(false);
  });

  it("disables auto cs_situation panel after first panel has been marked", () => {
    const { handlers, store } = createGrowthHarness();
    store.markFirstPanelSeen("u-seen");

    const pending = handlers.handleEvent({
      updateId: 1,
      userId: "u-seen",
      callbackData: "cs_situation"
    });
    expect(pending.state.pendingAutoPanelFromColdStart).toBe(false);

    const run = handlers.handleEvent({
      updateId: 2,
      userId: "u-seen",
      text: "Хочу обсудить конфликт на работе."
    });
    expect(run.llmTask).toBeUndefined();

    const done = finishConversation(handlers, "u-seen", 3);

    expect(done.llmTask?.mode).toBe("PANEL");
    expect(done.llmTask?.forceFree).toBeUndefined();
    expect(done.analyticsContext?.askAllOrigin).toBe("manual");
  });

  it("opens message submenu via cs_message callback", () => {
    const { handlers } = createGrowthHarness();
    const result = handlers.handleEvent({
      updateId: 1,
      userId: "u-cs-message",
      callbackData: "cs_message"
    });

    expect(result.messages[0]?.text).toBe("Что нужно?");
    expect(result.state.pendingAutoPanelFromColdStart).toBe(false);
    const compose = result.messages[0]?.keyboard?.[0]?.[0];
    const reply = result.messages[0]?.keyboard?.[1]?.[0];
    expect(compose && "data" in compose ? compose.data : null).toBe("cs_compose");
    expect(reply && "data" in reply ? reply.data : null).toBe("cs_reply");
  });

  it("starts compose panel from cs_compose without friend selection", () => {
    const { handlers } = createGrowthHarness();
    const pending = handlers.handleEvent({
      updateId: 1,
      userId: "u-cs-compose-no-persona",
      callbackData: "cs_compose"
    });

    expect(pending.state.pendingMode).toBe("awaiting_panel_input");
    expect(pending.state.pendingPanelScenario).toBe("compose");
    expect(pending.state.pendingAutoPanelFromColdStart).toBe(true);
    expect(pending.messages[0]?.text).toContain("Опиши, кому и что нужно написать");

    const run = handlers.handleEvent({
      updateId: 2,
      userId: "u-cs-compose-no-persona",
      text: "Напиши бывшему, что я не хочу ругаться."
    });
    expect(run.llmTask).toBeUndefined();

    const done = finishConversation(handlers, "u-cs-compose-no-persona", 3);

    expect(done.llmTask?.mode).toBe("PANEL");
    expect(done.llmTask?.scenario).toBe("compose");
    expect(done.llmTask?.forceFree).toBe(true);
  });

  it("starts compose panel from cs_compose when friend already selected", () => {
    const handlers = new UXHandlers();
    handlers.handleEvent({
      updateId: 1,
      userId: "u-cs-compose-persona",
      callbackData: "choose_friend:yan"
    });

    const withPersona = handlers.handleEvent({
      updateId: 2,
      userId: "u-cs-compose-persona",
      callbackData: "cs_compose"
    });

    expect(withPersona.state.pendingMode).toBe("awaiting_panel_input");
    expect(withPersona.state.pendingPanelScenario).toBe("compose");
    expect(withPersona.messages[0]?.text).toContain("Опиши, кому и что нужно написать");
  });

  it("starts reply panel from cs_reply without friend selection", () => {
    const { handlers } = createGrowthHarness();
    const pending = handlers.handleEvent({
      updateId: 1,
      userId: "u-cs-reply-no-persona",
      callbackData: "cs_reply"
    });

    expect(pending.state.pendingMode).toBe("awaiting_panel_input");
    expect(pending.state.pendingPanelScenario).toBe("reply");
    expect(pending.state.pendingAutoPanelFromColdStart).toBe(true);
    expect(pending.messages[0]?.text).toContain("Вставь сообщение, на которое нужно ответить");

    const run = handlers.handleEvent({
      updateId: 2,
      userId: "u-cs-reply-no-persona",
      text: "Он написал: «ты слишком драматизируешь»."
    });
    expect(run.llmTask).toBeUndefined();

    const done = finishConversation(handlers, "u-cs-reply-no-persona", 3);

    expect(done.llmTask?.mode).toBe("PANEL");
    expect(done.llmTask?.scenario).toBe("reply");
    expect(done.llmTask?.forceFree).toBe(true);
  });

  it("starts reply panel from cs_reply when friend already selected", () => {
    const handlers = new UXHandlers();
    handlers.handleEvent({
      updateId: 1,
      userId: "u-cs-reply-persona",
      callbackData: "choose_friend:max"
    });

    const withPersona = handlers.handleEvent({
      updateId: 2,
      userId: "u-cs-reply-persona",
      callbackData: "cs_reply"
    });

    expect(withPersona.state.pendingMode).toBe("awaiting_panel_input");
    expect(withPersona.state.pendingPanelScenario).toBe("reply");
    expect(withPersona.messages[0]?.text).toContain("Вставь сообщение, на которое нужно ответить");
  });

  it("opens chat friend picker via cs_chat callback", () => {
    const { handlers } = createGrowthHarness();
    const result = handlers.handleEvent({
      updateId: 1,
      userId: "u-cs-chat",
      callbackData: "cs_chat"
    });

    expect(result.messages[0]?.text).toBe("С кем хочешь поговорить?");
    expect(result.state.pendingAutoPanelFromColdStart).toBe(false);
    const yan = result.messages[0]?.keyboard?.[0]?.[0];
    const natasha = result.messages[0]?.keyboard?.[0]?.[1];
    const anya = result.messages[0]?.keyboard?.[1]?.[0];
    const max = result.messages[0]?.keyboard?.[1]?.[1];
    expect(yan && "data" in yan ? yan.data : null).toBe("cs_chat_yan");
    expect(natasha && "data" in natasha ? natasha.data : null).toBe("cs_chat_natasha");
    expect(anya && "data" in anya ? anya.data : null).toBe("cs_chat_anya");
    expect(max && "data" in max ? max.data : null).toBe("cs_chat_max");
  });

  it("emits cold_start_click analytics for cold start entry buttons", () => {
    const recorded: Array<{ event: string; extra?: Record<string, unknown> }> = [];
    const analyticsSpy = {
      emitEvent(input: { event: string; extra?: Record<string, unknown> }) {
        recorded.push(input);
      }
    } as unknown as AnalyticsService;
    const dir = mkdtempSync(join(tmpdir(), "five-friends-cold-start-analytics-"));
    tempDirs.push(dir);
    const store = new SqliteStore(join(dir, "bot.sqlite"));
    stores.push(store);
    const handlers = new UXHandlers({
      analytics: analyticsSpy,
      firstPanelStateStore: store
    });

    handlers.handleEvent({ updateId: 1, userId: "u-cold-a", callbackData: "cs_situation" });
    handlers.handleEvent({ updateId: 2, userId: "u-cold-b", callbackData: "cs_message" });
    handlers.handleEvent({ updateId: 3, userId: "u-cold-c", callbackData: "cs_chat" });

    expect(recorded).toHaveLength(3);
    expect(recorded[0]).toMatchObject({ event: "cold_start_click", extra: { entry: "situation" } });
    expect(recorded[1]).toMatchObject({ event: "cold_start_click", extra: { entry: "message" } });
    expect(recorded[2]).toMatchObject({ event: "cold_start_click", extra: { entry: "chat" } });
  });

  it("selects persona and starts forceFree chat via cs_chat_yan", () => {
    const handlers = new UXHandlers();
    const result = handlers.handleEvent({
      updateId: 1,
      userId: "u-cs-chat-yan",
      callbackData: "cs_chat_yan"
    });

    expect(result.state.currentPersona).toBe("yan");
    expect(result.state.pendingMode).toBeNull();
    expect(result.messages[0]?.text).toContain("Сейчас с тобой Ян");
    expect(result.llmTask?.mode).toBe("SINGLE");
    expect(result.llmTask?.persona).toBe("yan");
    expect(result.llmTask?.forceFree).toBe(true);
  });

  it("accepts legacy trigger text for panel mode", () => {
    const handlers = new UXHandlers();
    const result = handlers.handleEvent({
      updateId: 1,
      userId: "u-legacy-panel",
      text: "совет всех"
    });

    expect(result.state.pendingMode).toBe("awaiting_panel_input");
    expect(result.messages[0]?.text).toContain("Кидай ситуацию, переписку");
  });

  it("routes Inna to summary even when panel input is pending", () => {
    const handlers = new UXHandlers();
    handlers.handleEvent({
      updateId: 1,
      userId: "u-pending-inna",
      text: "все сразу"
    });

    const result = handlers.handleEvent({
      updateId: 2,
      userId: "u-pending-inna",
      text: "📌 Инна о чем мы говорили в последний раз?"
    });

    expect(result.llmTask?.mode).toBe("SUMMARY");
    expect(result.state.pendingMode).toBeNull();
    expect(result.messages[0]?.text).toContain("Собираю сводку");
    expect(result.messages[0]?.text).not.toContain("Собираю разбор");
  });

  it("opens friend picker from panel pending flow", () => {
    const handlers = new UXHandlers();
    handlers.handleEvent({ updateId: 1, userId: "u1", callbackData: "panel_start" });
    const result = handlers.handleEvent({
      updateId: 2,
      userId: "u1",
      callbackData: "friends_info"
    });

    expect(result.messages[0]?.text).toContain("Выбери, кого позвать");
    expect(result.messages[0]?.keyboard?.[0]?.[0]?.text).toContain("Позвать");
    expect(result.state.pendingMode).toBeNull();
  });

  it("cancels panel pending when friend is selected", () => {
    const handlers = new UXHandlers();
    handlers.handleEvent({ updateId: 1, userId: "u1", callbackData: "panel_start" });
    const result = handlers.handleEvent({
      updateId: 2,
      userId: "u1",
      callbackData: "choose_friend:yan"
    });

    expect(result.messages[0]?.text).toContain("Ок, отменил режим 🤝");
    expect(result.state.pendingMode).toBeNull();
    expect(result.state.currentPersona).toBe("yan");
  });

  it("runs summary immediately from summary inline button", () => {
    const handlers = new UXHandlers();
    const result = handlers.handleEvent({
      updateId: 1,
      userId: "u-summary",
      callbackData: "summary_now"
    });

    expect(result.llmTask?.mode).toBe("SUMMARY");
    expect(result.state.pendingMode).toBeNull();
    expect(result.messages[0]?.text).toContain("Собираю сводку");
  });

  it("runs summary immediately from legacy Inna quick action", () => {
    const handlers = new UXHandlers();
    const result = handlers.handleEvent({
      updateId: 1,
      userId: "u-summary-quick",
      text: "📌 Инна"
    });

    expect(result.llmTask?.mode).toBe("SUMMARY");
    expect(result.state.pendingMode).toBeNull();
    expect(result.messages[0]?.text).toContain("Собираю сводку");
  });

  it("blocks non-safety callbacks during safety hold and allows safety callbacks", () => {
    const handlers = new UXHandlers();
    const entered = handlers.handleEvent({
      updateId: 1,
      userId: "u-safety-callbacks",
      callbackData: "safety_yes"
    });
    expect(entered.state.safetyHold).toBe(true);

    const blocked = handlers.handleEvent({
      updateId: 2,
      userId: "u-safety-callbacks",
      callbackData: "panel_start"
    });
    expect(blocked.messages[0]?.text).toContain("Мне очень жаль");
    expect(blocked.state.pendingMode).toBeNull();

    const help = handlers.handleEvent({
      updateId: 3,
      userId: "u-safety-callbacks",
      callbackData: "safety_help"
    });
    expect(help.messages[0]?.text).toContain("Выбери страну");

    const resumed = handlers.handleEvent({
      updateId: 4,
      userId: "u-safety-callbacks",
      callbackData: "safety_resume"
    });
    expect(resumed.messages[0]?.text).toContain("Ок. Продолжим.");
    expect(resumed.state.safetyHold).toBe(false);
  });

  it("enters compose pending mode and triggers SINGLE scenario", () => {
    const handlers = new UXHandlers();
    handlers.handleEvent({
      updateId: 1,
      userId: "u-compose",
      callbackData: "choose_friend:yan"
    });

    const pending = handlers.handleEvent({
      updateId: 2,
      userId: "u-compose",
      text: "📝 Сформулируй"
    });
    expect(pending.state.pendingMode).toBe("awaiting_compose_input");

    const collected = handlers.handleEvent({
      updateId: 3,
      userId: "u-compose",
      text: "Нужно написать маме, что не приеду на выходных."
    });
    expect(collected.llmTask).toBeUndefined();

    const run = finishConversation(handlers, "u-compose", 4);
    expect(run.llmTask?.mode).toBe("SINGLE");
    expect(run.llmTask?.persona).toBe("yan");
    expect(run.llmTask?.scenario).toBe("compose");
    expect(run.state.pendingMode).toBeNull();
  });

  it("switches compose pending to reply pending on quick action text", () => {
    const handlers = new UXHandlers();
    handlers.handleEvent({
      updateId: 1,
      userId: "u-compose-to-reply",
      callbackData: "choose_friend:yan"
    });

    const composePending = handlers.handleEvent({
      updateId: 2,
      userId: "u-compose-to-reply",
      text: "Напиши за меня"
    });
    expect(composePending.state.pendingMode).toBe("awaiting_compose_input");

    const switched = handlers.handleEvent({
      updateId: 3,
      userId: "u-compose-to-reply",
      text: "Помоги ответить"
    });
    expect(switched.state.pendingMode).toBe("awaiting_reply_input");
    expect(switched.llmTask).toBeUndefined();
    expect(switched.messages[0]?.text).toContain("Переключил");

    const replyCollected = handlers.handleEvent({
      updateId: 4,
      userId: "u-compose-to-reply",
      text: "Она пишет: \"ты меня игнорируешь\"."
    });
    expect(replyCollected.llmTask).toBeUndefined();

    const runReply = finishConversation(handlers, "u-compose-to-reply", 5);
    expect(runReply.llmTask?.mode).toBe("SINGLE");
    expect(runReply.llmTask?.persona).toBe("yan");
    expect(runReply.llmTask?.scenario).toBe("reply");
    expect(runReply.state.pendingMode).toBeNull();
  });

  it("switches reply pending to compose pending on quick action text", () => {
    const handlers = new UXHandlers();
    handlers.handleEvent({
      updateId: 1,
      userId: "u-reply-to-compose",
      callbackData: "choose_friend:max"
    });

    const replyPending = handlers.handleEvent({
      updateId: 2,
      userId: "u-reply-to-compose",
      text: "💬 Ответь"
    });
    expect(replyPending.state.pendingMode).toBe("awaiting_reply_input");

    const switched = handlers.handleEvent({
      updateId: 3,
      userId: "u-reply-to-compose",
      text: "📝 Сформулируй"
    });
    expect(switched.state.pendingMode).toBe("awaiting_compose_input");
    expect(switched.llmTask).toBeUndefined();
    expect(switched.messages[0]?.text).toContain("Переключил");

    const composeCollected = handlers.handleEvent({
      updateId: 4,
      userId: "u-reply-to-compose",
      text: "Напиши менеджеру, что дедлайн сдвигается на два дня."
    });
    expect(composeCollected.llmTask).toBeUndefined();

    const runCompose = finishConversation(handlers, "u-reply-to-compose", 5);
    expect(runCompose.llmTask?.mode).toBe("SINGLE");
    expect(runCompose.llmTask?.persona).toBe("max");
    expect(runCompose.llmTask?.scenario).toBe("compose");
    expect(runCompose.state.pendingMode).toBeNull();
  });

  it("keeps reply tool scenario when switching to ask-all flow", () => {
    const handlers = new UXHandlers();
    handlers.handleEvent({
      updateId: 1,
      userId: "u-reply-to-panel",
      callbackData: "choose_friend:max"
    });

    const replyPending = handlers.handleEvent({
      updateId: 2,
      userId: "u-reply-to-panel",
      text: "💬 Ответь"
    });
    expect(replyPending.state.pendingMode).toBe("awaiting_reply_input");

    const switched = handlers.handleEvent({
      updateId: 3,
      userId: "u-reply-to-panel",
      text: "🚀 Спросить всех"
    });
    expect(switched.state.pendingMode).toBe("awaiting_panel_input");
    expect(switched.state.pendingPanelScenario).toBe("reply");
    expect(switched.llmTask).toBeUndefined();

    const panelReplyCollected = handlers.handleEvent({
      updateId: 4,
      userId: "u-reply-to-panel",
      text: "Он пишет: «ты опять пропал, мне это не ок»."
    });
    expect(panelReplyCollected.llmTask).toBeUndefined();

    const runPanelReply = finishConversation(handlers, "u-reply-to-panel", 5);
    expect(runPanelReply.llmTask?.mode).toBe("PANEL");
    expect(runPanelReply.llmTask?.scenario).toBe("reply");
    expect(runPanelReply.state.pendingMode).toBeNull();
    expect(runPanelReply.state.pendingPanelScenario).toBeNull();
  });

  it("keeps compose tool scenario when switching to ask-all flow", () => {
    const handlers = new UXHandlers();
    handlers.handleEvent({
      updateId: 1,
      userId: "u-compose-to-panel",
      callbackData: "choose_friend:yan"
    });

    const composePending = handlers.handleEvent({
      updateId: 2,
      userId: "u-compose-to-panel",
      text: "📝 Сформулируй"
    });
    expect(composePending.state.pendingMode).toBe("awaiting_compose_input");

    const switched = handlers.handleEvent({
      updateId: 3,
      userId: "u-compose-to-panel",
      text: "🚀 Спросить всех"
    });
    expect(switched.state.pendingMode).toBe("awaiting_panel_input");
    expect(switched.state.pendingPanelScenario).toBe("compose");
    expect(switched.llmTask).toBeUndefined();

    const panelComposeCollected = handlers.handleEvent({
      updateId: 4,
      userId: "u-compose-to-panel",
      text: "Напиши бывшему, что я не хочу продолжать общение."
    });
    expect(panelComposeCollected.llmTask).toBeUndefined();

    const runPanelCompose = finishConversation(handlers, "u-compose-to-panel", 5);
    expect(runPanelCompose.llmTask?.mode).toBe("PANEL");
    expect(runPanelCompose.llmTask?.scenario).toBe("compose");
    expect(runPanelCompose.state.pendingMode).toBeNull();
    expect(runPanelCompose.state.pendingPanelScenario).toBeNull();
  });

  it("keeps reply scenario when ask-all is started via panel_start callback", () => {
    const handlers = new UXHandlers();
    handlers.handleEvent({
      updateId: 1,
      userId: "u-reply-callback-panel",
      callbackData: "choose_friend:max"
    });
    handlers.handleEvent({
      updateId: 2,
      userId: "u-reply-callback-panel",
      text: "💬 Помоги ответить"
    });

    const switched = handlers.handleEvent({
      updateId: 3,
      userId: "u-reply-callback-panel",
      callbackData: "panel_start"
    });
    expect(switched.state.pendingMode).toBe("awaiting_panel_input");
    expect(switched.state.pendingPanelScenario).toBe("reply");

    const collected = handlers.handleEvent({
      updateId: 4,
      userId: "u-reply-callback-panel",
      text: "Он написал: «Ты ведешь себя непрофессионально»."
    });
    expect(collected.llmTask).toBeUndefined();

    const run = finishConversation(handlers, "u-reply-callback-panel", 5);
    expect(run.llmTask?.mode).toBe("PANEL");
    expect(run.llmTask?.scenario).toBe("reply");
  });

  it("isolates pending modes and scenarios between different users", () => {
    const handlers = new UXHandlers();

    handlers.handleEvent({
      updateId: 1,
      userId: "u-a",
      callbackData: "choose_friend:yan"
    });
    handlers.handleEvent({
      updateId: 1,
      userId: "u-b",
      callbackData: "choose_friend:max"
    });

    handlers.handleEvent({
      updateId: 2,
      userId: "u-a",
      text: "💬 Помоги ответить"
    });
    handlers.handleEvent({
      updateId: 2,
      userId: "u-b",
      text: "🚀 Спросить всех"
    });

    const collectedA = handlers.handleEvent({
      updateId: 3,
      userId: "u-a",
      text: "Она пишет: «где дедлайн?»"
    });
    expect(collectedA.llmTask).toBeUndefined();

    const runA = finishConversation(handlers, "u-a", 4);
    expect(runA.llmTask?.mode).toBe("SINGLE");
    expect(runA.llmTask?.scenario).toBe("reply");

    const collectedB = handlers.handleEvent({
      updateId: 3,
      userId: "u-b",
      text: "Я не понимаю, как выйти из конфликта."
    });
    expect(collectedB.llmTask).toBeUndefined();

    const runB = finishConversation(handlers, "u-b", 4);
    expect(runB.llmTask?.mode).toBe("PANEL");
    expect(runB.llmTask?.scenario).toBeNull();
  });

  it("enters reply pending mode and triggers SINGLE scenario", () => {
    const handlers = new UXHandlers();
    handlers.handleEvent({
      updateId: 1,
      userId: "u-reply",
      callbackData: "choose_friend:max"
    });

    const pending = handlers.handleEvent({
      updateId: 2,
      userId: "u-reply",
      text: "💬 Ответь"
    });
    expect(pending.state.pendingMode).toBe("awaiting_reply_input");

    const collected = handlers.handleEvent({
      updateId: 3,
      userId: "u-reply",
      text: "Он пишет: «ты меня игнорируешь»."
    });
    expect(collected.llmTask).toBeUndefined();

    const run = finishConversation(handlers, "u-reply", 4);
    expect(run.llmTask?.mode).toBe("SINGLE");
    expect(run.llmTask?.persona).toBe("max");
    expect(run.llmTask?.scenario).toBe("reply");
    expect(run.state.pendingMode).toBeNull();
  });

  it("shows try button under /demo and routes to panel mode", () => {
    const handlers = new UXHandlers();
    const demo = handlers.handleEvent({
      updateId: 1,
      userId: "u-demo",
      command: "/demo"
    });

    expect(demo.messages[0]?.keyboard?.[0]?.[0]?.text).toBe("🚀 Попробовать тоже");
    const demoTry = demo.messages[0]?.keyboard?.[0]?.[0];
    expect(demoTry && "data" in demoTry ? demoTry.data : null).toBe("panel_start");
    expect(demo.messages[0]?.text).toContain("Пользователь (пример):");
  });

  it("shows demo from settings inline button", () => {
    const handlers = new UXHandlers();
    const settings = handlers.handleEvent({
      updateId: 1,
      userId: "u-settings-demo",
      command: "/settings"
    });
    const settingsDemo = settings.messages[0]?.keyboard?.[1]?.[0];
    expect(settingsDemo && "data" in settingsDemo ? settingsDemo.data : null).toBe("settings_demo");

    const demo = handlers.handleEvent({
      updateId: 2,
      userId: "u-settings-demo",
      callbackData: "settings_demo"
    });
    expect(demo.messages[0]?.text).toContain("Пользователь (пример):");
    const demoTry = demo.messages[0]?.keyboard?.[0]?.[0];
    expect(demoTry && "data" in demoTry ? demoTry.data : null).toBe("panel_start");
  });

  it("enforces per-user queue in bot runtime", async () => {
    const bot = new BotRuntime(new UXHandlers(), {
      async generate({ task }) {
        if (task.mode === "SINGLE" && task.persona === "yan") {
          return { messages: [{ text: `(Ян) ${task.userText}` }], billable: true };
        }
        return { messages: [{ text: "ok" }], billable: true };
      }
    });
    const promises = [
      bot.processEvent({ updateId: 1, userId: "u1", callbackData: "choose_friend:yan" }),
      bot.processEvent({ updateId: 2, userId: "u1", text: "two" })
    ];

    const results = await Promise.all(promises);
    expect(results[0].messages[0]?.text).toContain("Сейчас с тобой Ян");
    expect(results[1].messages[0]?.text).toContain("(Ян) two");
  });

  it("rate limits too many events in short window", () => {
    const handlers = new UXHandlers();
    handlers.handleEvent({ updateId: 1, userId: "u1", callbackData: "choose_friend:yan", now: 0 });
    const now = 5000;
    for (let i = 2; i <= 6; i += 1) {
      handlers.handleEvent({ updateId: i, userId: "u1", text: "ok", now });
    }
    const blocked = handlers.handleEvent({
      updateId: 7,
      userId: "u1",
      text: "blocked",
      now
    });
    expect(blocked.messages[0]?.text).toContain("Слишком быстро");
  });

  it("switches persona via main reply keyboard text", () => {
    const handlers = new UXHandlers();
    const result = handlers.handleEvent({
      updateId: 1,
      userId: "u2",
      text: "🧠 Ян"
    });

    expect(result.state.currentPersona).toBe("yan");
    expect(result.messages[0]?.text).toContain("Сейчас с тобой Ян");
  });

  it("requires /forget confirmation before deletion", () => {
    const handlers = new UXHandlers();
    const ask = handlers.handleEvent({
      updateId: 1,
      userId: "u3",
      command: "/forget"
    });
    expect(ask.messages[0]?.text).toContain("Подтверди удаление");

    const confirm = handlers.handleEvent({
      updateId: 2,
      userId: "u3",
      callbackData: "forget_confirm_yes"
    });
    expect(confirm.clearLongTerm).toBe(true);
    expect(confirm.messages[0]?.text).toContain("Долгая память удалена");
  });

  it("requires /reset confirmation before session reset", () => {
    const handlers = new UXHandlers();
    const ask = handlers.handleEvent({
      updateId: 1,
      userId: "u4",
      command: "/reset"
    });
    expect(ask.messages[0]?.text).toContain("Подтверди сброс");

    const cancel = handlers.handleEvent({
      updateId: 2,
      userId: "u4",
      callbackData: "reset_confirm_no"
    });
    expect(cancel.sessionReset).toBeUndefined();
    expect(cancel.messages[0]?.text).toContain("сессию не сбрасываю");

    const askAgain = handlers.handleEvent({
      updateId: 3,
      userId: "u4",
      command: "/reset"
    });
    expect(askAgain.messages[0]?.text).toContain("Подтверди сброс");

    const confirm = handlers.handleEvent({
      updateId: 4,
      userId: "u4",
      callbackData: "reset_confirm_yes"
    });
    expect(confirm.sessionReset).toBeDefined();
    expect(confirm.messages[0]?.text).toContain("начнём заново");
  });

  it("accepts /start payload and attributes inviter once", () => {
    const handlers = createGrowthEnabledHandlers();

    handlers.handleEvent({
      updateId: 1,
      userId: "inviter",
      command: "/start"
    });
    const inviterShare = handlers.handleEvent({
      updateId: 2,
      userId: "inviter",
      callbackData: "sh"
    });
    const link = inviterShare.messages[0]?.text.split("\n")[1] ?? "";
    const refCode = (link.match(/start=ref_([^&\s]+)/)?.[1] ?? "").trim();
    expect(refCode.length).toBeGreaterThan(0);

    const first = handlers.handleEvent({
      updateId: 3,
      userId: "invitee",
      command: "/start",
      commandPayload: `ref_${refCode}`
    });
    expect(first.messages[0]?.text).toContain("Привет 👋 Мы на связи.");

    const second = handlers.handleEvent({
      updateId: 4,
      userId: "invitee",
      command: "/start",
      commandPayload: `ref_${refCode}`
    });
    expect(second.messages[0]?.text).toContain("Привет 👋 Мы на связи.");
  });

  it("stores ad source only once and allows late attribution from null source", () => {
    const { handlers, store } = createGrowthHarness();
    const db = store.getDb();

    handlers.handleEvent({
      updateId: 1,
      userId: "u-ads",
      command: "/start"
    });
    const firstVisit = db
      .prepare<[string], { source: string | null; campaign: string | null }>(`
        SELECT source, campaign
        FROM users
        WHERE user_id = ?
      `)
      .get("u-ads");
    expect(firstVisit).toEqual({ source: null, campaign: null });

    handlers.handleEvent({
      updateId: 2,
      userId: "u-ads",
      command: "/start",
      commandPayload: "gads_loneliness_01"
    });
    const attributed = db
      .prepare<[string], { source: string | null; campaign: string | null }>(`
        SELECT source, campaign
        FROM users
        WHERE user_id = ?
      `)
      .get("u-ads");
    expect(attributed).toEqual({ source: "google_ads", campaign: "loneliness_01" });

    handlers.handleEvent({
      updateId: 3,
      userId: "u-ads",
      command: "/start",
      commandPayload: "tgads_compose_a"
    });
    const afterSecondSource = db
      .prepare<[string], { source: string | null; campaign: string | null }>(`
        SELECT source, campaign
        FROM users
        WHERE user_id = ?
      `)
      .get("u-ads");
    expect(afterSecondSource).toEqual({ source: "google_ads", campaign: "loneliness_01" });

    handlers.handleEvent({
      updateId: 4,
      userId: "u-utm",
      command: "/start",
      commandPayload: "utm_blog_post_1"
    });
    const utmRow = db
      .prepare<[string], { source: string | null; campaign: string | null }>(`
        SELECT source, campaign
        FROM users
        WHERE user_id = ?
      `)
      .get("u-utm");
    expect(utmRow).toEqual({ source: "utm", campaign: "blog_post_1" });
  });

  it("enriches start analytics with source and optional campaign", () => {
    const recordedEvents: Array<{ extra?: Record<string, unknown> }> = [];
    const analyticsSpy = {
      emitEvent(input: { extra?: Record<string, unknown> }) {
        recordedEvents.push(input);
      }
    } as unknown as AnalyticsService;
    const dir = mkdtempSync(join(tmpdir(), "five-friends-growth-sm-analytics-"));
    tempDirs.push(dir);
    const store = new SqliteStore(join(dir, "bot.sqlite"));
    stores.push(store);
    const referrals = new ReferralService(store.getDb());
    const handlers = new UXHandlers({
      referrals,
      analytics: analyticsSpy
    });

    handlers.handleEvent({
      updateId: 1,
      userId: "u-analytics-ads",
      command: "/start",
      commandPayload: "gads_loneliness_01"
    });
    handlers.handleEvent({
      updateId: 2,
      userId: "u-analytics-organic",
      command: "/start"
    });

    expect(recordedEvents[0]?.extra?.source).toBe("google_ads");
    expect(recordedEvents[0]?.extra?.campaign).toBe("loneliness_01");
    expect(recordedEvents[1]?.extra?.source).toBe("organic");
    expect(recordedEvents[1]?.extra).not.toHaveProperty("campaign");
  });

  it("restricts /stats to admins", () => {
    const handlers = createGrowthEnabledHandlers();

    const denied = handlers.handleEvent({
      updateId: 1,
      userId: "not-admin",
      command: "/stats"
    });
    expect(denied.messages[0]?.text).toContain("Недостаточно прав");

    const allowed = handlers.handleEvent({
      updateId: 2,
      userId: "admin-user",
      command: "/stats"
    });
    expect(allowed.messages[0]?.text).toContain("📊 Статистика");
    expect(allowed.messages[0]?.text).toContain("Конверсии");
    expect(allowed.messages[0]?.text).toContain("Источники");
  });
});
