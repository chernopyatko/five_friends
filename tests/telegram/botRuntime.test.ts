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

function createGrowthDeps() {
  const dir = mkdtempSync(join(tmpdir(), "five-friends-botruntime-"));
  tempDirs.push(dir);
  const store = new SqliteStore(join(dir, "bot.sqlite"));
  stores.push(store);
  const db = store.getDb();
  return {
    referrals: new ReferralService(db),
    analytics: new AnalyticsService({ db })
  };
}

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

  it("appends share prompt after compose flow", async () => {
    const deps = createGrowthDeps();
    const runtime = new BotRuntime(
      new UXHandlers({
        referrals: deps.referrals,
        analytics: deps.analytics
      }),
      {
        async generate() {
          return [{ text: "🧠 Ян — Разум\nЧерновик готов." }];
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

    const result = await runtime.processEvent({
      updateId: 3,
      userId: "u-share",
      text: "Нужно написать коллеге про перенос встречи."
    });

    expect(result.messages).toHaveLength(2);
    expect(result.messages[1]?.text).toBe("Что дальше?");
    expect(result.messages[1]?.keyboard?.[0]?.[0]).toMatchObject({
      text: "Поделиться ботом"
    });
    expect(result.messages[1]?.keyboard?.[0]?.[1]).toMatchObject({
      data: "sh"
    });
  });
});
