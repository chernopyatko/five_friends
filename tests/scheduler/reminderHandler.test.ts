import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import type { Bot } from "grammy";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BalanceStore } from "../../src/billing/balanceStore.js";
import { createLogger } from "../../src/observability/logger.js";
import { processReminders, REMINDER_TEXT } from "../../src/scheduler/reminderHandler.js";
import { SqliteStore } from "../../src/state/store.js";

const HOUR_MS = 60 * 60 * 1000;
const FIXED_NOW = new Date("2026-01-12T12:00:00.000Z");

const tempDirs: string[] = [];
const stores: SqliteStore[] = [];

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(FIXED_NOW);
});

afterEach(() => {
  vi.useRealTimers();
  for (const store of stores) {
    store.close();
  }
  stores.length = 0;
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  tempDirs.length = 0;
});

function createFixture(): {
  store: SqliteStore;
  balanceStore: BalanceStore;
  sendMessage: ReturnType<typeof vi.fn>;
  bot: Bot;
} {
  const dir = mkdtempSync(join(tmpdir(), "five-friends-reminders-"));
  tempDirs.push(dir);
  const store = new SqliteStore(join(dir, "bot.sqlite"));
  stores.push(store);
  const balanceStore = new BalanceStore(store.getDb());
  const sendMessage = vi.fn().mockResolvedValue(undefined);
  const bot = {
    api: {
      sendMessage
    }
  } as unknown as Bot;

  return { store, balanceStore, sendMessage, bot };
}

function addSession(store: SqliteStore, userId: string, lastActivityAt: number): void {
  store.getDb()
    .prepare<[string, string, number, number, string]>(`
      INSERT INTO sessions (id, user_id, started_at, last_activity_at, rolling_summary)
      VALUES (?, ?, ?, ?, ?)
    `)
    .run(randomUUID(), userId, lastActivityAt - 1_000, lastActivityAt, "");
}

describe("processReminders", () => {
  it("sends reminder to inactive user", async () => {
    const { store, balanceStore, sendMessage, bot } = createFixture();
    const userId = "inactive-user";
    balanceStore.ensureBalance(userId);
    addSession(store, userId, Date.now() - (25 * HOUR_MS));

    const result = await processReminders({
      db: store.getDb(),
      bot,
      logger: createLogger("silent")
    });

    expect(sendMessage).toHaveBeenCalledWith(userId, REMINDER_TEXT);
    const row = store.getDb()
      .prepare<[string], { last_reminder_sent_at: number | null }>(`
        SELECT last_reminder_sent_at
        FROM user_balance
        WHERE user_id = ?
      `)
      .get(userId);
    expect(row?.last_reminder_sent_at).not.toBeNull();
    expect(result).toEqual({
      sent: 1,
      skipped: 0,
      failed: 0,
      disabled: 0
    });
  });

  it("skips active user", async () => {
    const { store, balanceStore, sendMessage, bot } = createFixture();
    const userId = "active-user";
    balanceStore.ensureBalance(userId);
    addSession(store, userId, Date.now() - (2 * HOUR_MS));

    const result = await processReminders({
      db: store.getDb(),
      bot,
      logger: createLogger("silent")
    });

    expect(sendMessage).not.toHaveBeenCalled();
    expect(result).toEqual({
      sent: 0,
      skipped: 0,
      failed: 0,
      disabled: 0
    });
  });

  it("skips user with reminders disabled", async () => {
    const { store, balanceStore, sendMessage, bot } = createFixture();
    const userId = "disabled-user";
    balanceStore.ensureBalance(userId);
    balanceStore.setRemindersEnabled(userId, false);
    addSession(store, userId, Date.now() - (25 * HOUR_MS));

    const result = await processReminders({
      db: store.getDb(),
      bot,
      logger: createLogger("silent")
    });

    expect(sendMessage).not.toHaveBeenCalled();
    expect(result).toEqual({
      sent: 0,
      skipped: 0,
      failed: 0,
      disabled: 0
    });
  });

  it("skips user already reminded today", async () => {
    const { store, balanceStore, sendMessage, bot } = createFixture();
    const userId = "already-reminded-user";
    balanceStore.ensureBalance(userId);
    addSession(store, userId, Date.now() - (25 * HOUR_MS));
    store.getDb()
      .prepare<[number, string]>(`
        UPDATE user_balance
        SET last_reminder_sent_at = ?
        WHERE user_id = ?
      `)
      .run(Date.now() - HOUR_MS, userId);

    const result = await processReminders({
      db: store.getDb(),
      bot,
      logger: createLogger("silent")
    });

    expect(sendMessage).not.toHaveBeenCalled();
    expect(result).toEqual({
      sent: 0,
      skipped: 0,
      failed: 0,
      disabled: 0
    });
  });

  it("disables reminders on blocked user", async () => {
    const { store, balanceStore, sendMessage, bot } = createFixture();
    const userId = "blocked-user";
    balanceStore.ensureBalance(userId);
    addSession(store, userId, Date.now() - (25 * HOUR_MS));

    const blockedError = Object.assign(new Error("Forbidden: bot was blocked by the user"), {
      description: "Forbidden: bot was blocked by the user",
      error_code: 403
    });
    sendMessage.mockRejectedValue(blockedError);

    const result = await processReminders({
      db: store.getDb(),
      bot,
      logger: createLogger("silent")
    });

    expect(balanceStore.getRemindersEnabled(userId)).toBe(false);
    expect(result).toEqual({
      sent: 0,
      skipped: 0,
      failed: 0,
      disabled: 1
    });
  });

  it("does not disable reminders on transient error", async () => {
    const { store, balanceStore, sendMessage, bot } = createFixture();
    const userId = "transient-error-user";
    balanceStore.ensureBalance(userId);
    addSession(store, userId, Date.now() - (25 * HOUR_MS));

    sendMessage.mockRejectedValue(new Error("temporary network timeout"));

    const result = await processReminders({
      db: store.getDb(),
      bot,
      logger: createLogger("silent")
    });

    expect(balanceStore.getRemindersEnabled(userId)).toBe(true);
    expect(result).toEqual({
      sent: 0,
      skipped: 0,
      failed: 1,
      disabled: 0
    });
  });
});
