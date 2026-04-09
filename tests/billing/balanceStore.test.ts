import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { BalanceStore } from "../../src/billing/balanceStore.js";
import { SqliteStore } from "../../src/state/store.js";

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

function createBalanceStore(): BalanceStore {
  const dir = mkdtempSync(join(tmpdir(), "five-friends-balance-"));
  tempDirs.push(dir);
  const store = new SqliteStore(join(dir, "bot.sqlite"));
  stores.push(store);
  return new BalanceStore(store.getDb());
}

describe("balance store", () => {
  it("initializes trial balance and tracks spend/purchase totals", () => {
    const balanceStore = createBalanceStore();

    balanceStore.ensureBalance("u1");
    expect(balanceStore.getBalance("u1")).toBe(15);

    balanceStore.deductBalance("u1", 3, "PANEL");
    expect(balanceStore.getBalance("u1")).toBe(12);

    const credited = balanceStore.addBalance("u1", 50, "tribute_purchase", "order-1");
    expect(credited.credited).toBe(true);
    expect(credited.balance).toBe(62);

    const info = balanceStore.getBalanceInfo("u1");
    expect(info.balance).toBe(62);
    expect(info.totalSpent).toBe(3);
    expect(info.totalPurchased).toBe(50);
  });

  it("is idempotent by tribute_order_id", () => {
    const balanceStore = createBalanceStore();

    const first = balanceStore.addBalance("u2", 50, "tribute_purchase", "duplicate-order");
    const second = balanceStore.addBalance("u2", 50, "tribute_purchase", "duplicate-order");

    expect(first.credited).toBe(true);
    expect(second.credited).toBe(false);
    expect(balanceStore.getBalance("u2")).toBe(50);
  });

  it("rejects non-positive amounts", () => {
    const balanceStore = createBalanceStore();

    expect(() => balanceStore.deductBalance("u3", 0, "SINGLE")).toThrowError(/amount/i);
    expect(() => balanceStore.addBalance("u3", -1, "tribute_purchase")).toThrowError(/amount/i);
  });

  it("gets and sets reminders enabled flag", () => {
    const balanceStore = createBalanceStore();
    const userId = "reminder-user";

    balanceStore.ensureBalance(userId);
    expect(balanceStore.getRemindersEnabled(userId)).toBe(true);

    balanceStore.setRemindersEnabled(userId, false);
    expect(balanceStore.getRemindersEnabled(userId)).toBe(false);

    balanceStore.setRemindersEnabled(userId, true);
    expect(balanceStore.getRemindersEnabled(userId)).toBe(true);
  });
});
