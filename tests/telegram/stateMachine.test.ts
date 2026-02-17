import { describe, expect, it } from "vitest";

import { BotRuntime } from "../../src/telegram/bot.js";
import { UXHandlers } from "../../src/telegram/uxHandlers.js";

describe("stateMachine", () => {
  it("stores pending text when no friend selected", () => {
    const handlers = new UXHandlers();
    const result = handlers.handleEvent({
      updateId: 1,
      userId: "u1",
      text: "привет"
    });

    expect(result.messages[0]?.text).toContain("Кого позвать");
    expect(result.state.pendingUserText).toBe("привет");
  });

  it("sets persistent main menu on /start", () => {
    const handlers = new UXHandlers();
    const result = handlers.handleEvent({
      updateId: 1,
      userId: "u-start",
      command: "/start"
    });

    expect(result.messages[0]?.replyKeyboard?.[0]?.[0]).toBe("🚀 Все взгляды");
    expect(result.messages[0]?.replyKeyboard?.[0]?.[1]).toBe("👥 Друзья");
    expect(result.messages[0]?.replyKeyboard?.[2]?.[0]).toBe("📋 Сводка");
    expect(result.messages[0]?.keyboard).toBeUndefined();
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

    expect(result.messages.length).toBeGreaterThanOrEqual(2);
    expect(result.messages[0]?.text).toContain("Сейчас с тобой Ян");
    expect(result.state.pendingUserText).toBeNull();
  });

  it("rejects duplicate updates by idempotency rule", () => {
    const handlers = new UXHandlers();
    handlers.handleEvent({ updateId: 3, userId: "u1", text: "a" });
    const duplicate = handlers.handleEvent({ updateId: 3, userId: "u1", text: "b" });
    expect(duplicate.messages[0]?.text).toContain("устарела");
  });

  it("handles panel pending flow", () => {
    const handlers = new UXHandlers();
    handlers.handleEvent({ updateId: 1, userId: "u1", callbackData: "choose_friend:anya" });
    handlers.handleEvent({ updateId: 2, userId: "u1", text: "все сразу" });
    const result = handlers.handleEvent({ updateId: 3, userId: "u1", text: "ситуация" });

    expect(result.messages[0]?.text).toContain("Собираю разбор от всех друзей");
    expect(result.state.pendingMode).toBeNull();
  });

  it("accepts legacy trigger text for panel mode", () => {
    const handlers = new UXHandlers();
    const result = handlers.handleEvent({
      updateId: 1,
      userId: "u-legacy-panel",
      text: "совет всех"
    });

    expect(result.state.pendingMode).toBe("awaiting_panel_input");
    expect(result.messages[0]?.text).toContain("Следующее сообщение разберём вместе");
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

    const run = handlers.handleEvent({
      updateId: 3,
      userId: "u-compose",
      text: "Нужно написать маме, что не приеду на выходных."
    });
    expect(run.llmTask?.mode).toBe("SINGLE");
    expect(run.llmTask?.persona).toBe("yan");
    expect(run.llmTask?.scenario).toBe("compose");
    expect(run.state.pendingMode).toBeNull();
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

    const run = handlers.handleEvent({
      updateId: 3,
      userId: "u-reply",
      text: "Он пишет: «ты меня игнорируешь»."
    });
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

    expect(demo.messages[0]?.keyboard?.[0]?.[0]?.text).toBe("🚀 Попробовать также");
    expect(demo.messages[0]?.keyboard?.[0]?.[0]?.data).toBe("panel_start");
    expect(demo.messages[0]?.text).toContain("Пользователь (пример):");
  });

  it("shows demo from settings inline button", () => {
    const handlers = new UXHandlers();
    const settings = handlers.handleEvent({
      updateId: 1,
      userId: "u-settings-demo",
      command: "/settings"
    });
    expect(settings.messages[0]?.keyboard?.[1]?.[0]?.data).toBe("settings_demo");

    const demo = handlers.handleEvent({
      updateId: 2,
      userId: "u-settings-demo",
      callbackData: "settings_demo"
    });
    expect(demo.messages[0]?.text).toContain("Пользователь (пример):");
    expect(demo.messages[0]?.keyboard?.[0]?.[0]?.data).toBe("panel_start");
  });

  it("enforces per-user queue in bot runtime", async () => {
    const bot = new BotRuntime(new UXHandlers(), {
      async generate({ task }) {
        if (task.mode === "SINGLE" && task.persona === "yan") {
          return [{ text: `(Ян) ${task.userText}` }];
        }
        return [{ text: "ok" }];
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
    const now = 1000;
    for (let i = 1; i <= 5; i += 1) {
      handlers.handleEvent({ updateId: i, userId: "u1", text: "ok", now });
    }
    const blocked = handlers.handleEvent({
      updateId: 6,
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
});
