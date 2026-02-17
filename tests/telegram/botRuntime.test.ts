import { describe, expect, it } from "vitest";

import { BotRuntime } from "../../src/telegram/bot.js";
import { UXHandlers } from "../../src/telegram/uxHandlers.js";

describe("bot runtime hooks", () => {
  it("calls clearLongTerm only after forget confirmation", async () => {
    const calls: string[] = [];
    const runtime = new BotRuntime(new UXHandlers(), {
      async generate() {
        return [];
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
        return [];
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

    const result = await runtime.processEvent({
      updateId: 2,
      userId: "u3",
      text: "моя ситуация"
    });

    expect(result.messages[0]?.text).toContain("Не удалось получить ответ от GPT");
    expect(result.messages[0]?.text).not.toContain("Собираю разбор");
  });

  it("does not add post-panel follow-up messages on success", async () => {
    const runtime = new BotRuntime(new UXHandlers(), {
      async generate() {
        return [{ text: "🧠 Ян — Разум\n...\n📌 Инна — Сводка\n..." }];
      }
    });

    await runtime.processEvent({
      updateId: 1,
      userId: "u4",
      text: "все сразу"
    });

    const result = await runtime.processEvent({
      updateId: 2,
      userId: "u4",
      text: "моя ситуация"
    });

    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]?.text).toContain("📌 Инна — Сводка");
  });

  it("returns generated SINGLE reply without echo placeholder", async () => {
    const runtime = new BotRuntime(new UXHandlers(), {
      async generate() {
        return [{ text: "🧠 Ян — Разум\nГотовый ответ от модели." }];
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
});
