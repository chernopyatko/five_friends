import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

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

function createGrowthEnabledHandlers(): UXHandlers {
  const dir = mkdtempSync(join(tmpdir(), "five-friends-growth-sm-"));
  tempDirs.push(dir);
  const store = new SqliteStore(join(dir, "bot.sqlite"));
  stores.push(store);
  const db = store.getDb();
  const referrals = new ReferralService(db);
  const analytics = new AnalyticsService({ db });
  return new UXHandlers({
    referrals,
    analytics,
    adminUserIds: ["admin-user"]
  });
}

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

    expect(result.messages[0]?.replyKeyboard?.[0]?.[0]).toBe("🚀 Спросить всех");
    expect(result.messages[0]?.replyKeyboard?.[0]?.[1]).toBe("👥 Друзья");
    expect(result.messages[0]?.replyKeyboard?.[2]?.[0]).toBe("📋 Итоги");
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

    expect(result.messages.length).toBeGreaterThanOrEqual(1);
    expect(result.messages[0]?.text).toContain("Сейчас с тобой Ян");
    expect(result.state.pendingUserText).toBeNull();
    expect(result.llmTask).toBeDefined();
    expect(result.llmTask?.mode).toBe("SINGLE");
    expect(result.llmTask?.userText).toBe("нужна поддержка");
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

    const runReply = handlers.handleEvent({
      updateId: 4,
      userId: "u-compose-to-reply",
      text: "Она пишет: \"ты меня игнорируешь\"."
    });
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

    const runCompose = handlers.handleEvent({
      updateId: 4,
      userId: "u-reply-to-compose",
      text: "Напиши менеджеру, что дедлайн сдвигается на два дня."
    });
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

    const runPanelReply = handlers.handleEvent({
      updateId: 4,
      userId: "u-reply-to-panel",
      text: "Он пишет: «ты опять пропал, мне это не ок»."
    });
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

    const runPanelCompose = handlers.handleEvent({
      updateId: 4,
      userId: "u-compose-to-panel",
      text: "Напиши бывшему, что я не хочу продолжать общение."
    });
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

    const run = handlers.handleEvent({
      updateId: 4,
      userId: "u-reply-callback-panel",
      text: "Он написал: «Ты ведешь себя непрофессионально»."
    });
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

    const runA = handlers.handleEvent({
      updateId: 3,
      userId: "u-a",
      text: "Она пишет: «где дедлайн?»"
    });
    expect(runA.llmTask?.mode).toBe("SINGLE");
    expect(runA.llmTask?.scenario).toBe("reply");

    const runB = handlers.handleEvent({
      updateId: 3,
      userId: "u-b",
      text: "Я не понимаю, как выйти из конфликта."
    });
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
    expect(first.messages[0]?.text).toContain("Привет! Здесь живут 4 друга");

    const second = handlers.handleEvent({
      updateId: 4,
      userId: "invitee",
      command: "/start",
      commandPayload: `ref_${refCode}`
    });
    expect(second.messages[0]?.text).toContain("Привет! Здесь живут 4 друга");
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
  });
});
