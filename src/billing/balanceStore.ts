import { randomUUID } from "node:crypto";

import type Database from "better-sqlite3";

export interface BalanceInfo {
  balance: number;
  totalPurchased: number;
  totalSpent: number;
}

interface BalanceRow {
  balance: number;
  total_purchased: number;
  total_spent: number;
}

export class BalanceStore {
  private readonly db: Database;

  constructor(db: Database) {
    this.db = db;
  }

  ensureBalance(userId: string, initialBalance: number = 15): void {
    assertPositiveOrZeroInteger(initialBalance, "initialBalance");

    this.db
      .prepare<[string, number, number]>(`
        INSERT OR IGNORE INTO user_balance (user_id, balance, updated_at)
        VALUES (?, ?, ?)
      `)
      .run(userId, initialBalance, Date.now());
  }

  getBalance(userId: string): number {
    const row = this.db
      .prepare<[string], { balance: number }>(`
        SELECT balance
        FROM user_balance
        WHERE user_id = ?
      `)
      .get(userId);

    return Number(row?.balance ?? 0);
  }

  deductBalance(userId: string, amount: number, reason: string): { balance: number } {
    assertPositiveInteger(amount, "amount");
    assertNonEmptyString(reason, "reason");

    this.ensureBalance(userId);

    const run = this.db.transaction(() => {
      const now = Date.now();
      const updateResult = this.db
        .prepare<[number, number, number, string, number]>(`
          UPDATE user_balance
          SET balance = balance - ?,
              total_spent = total_spent + ?,
              updated_at = ?
          WHERE user_id = ?
            AND balance >= ?
        `)
        .run(amount, amount, now, userId, amount);

      if (Number(updateResult.changes) === 0) {
        throw new Error("Insufficient balance.");
      }

      this.db
        .prepare<[string, string, number, string, string | null, number]>(`
          INSERT INTO balance_transactions (id, user_id, amount, reason, tribute_order_id, created_at)
          VALUES (?, ?, ?, ?, ?, ?)
        `)
        .run(randomUUID(), userId, -amount, reason, null, now);

      return this.getBalance(userId);
    });

    return { balance: run() };
  }

  addBalance(userId: string, amount: number, reason: string, tributeOrderId?: string): { credited: boolean; balance: number } {
    assertPositiveInteger(amount, "amount");
    assertNonEmptyString(reason, "reason");

    this.ensureBalance(userId, 0);

    const run = this.db.transaction(() => {
      const now = Date.now();
      const insertTx = this.db.prepare<[string, string, number, string, string | null, number]>(`
        INSERT INTO balance_transactions (id, user_id, amount, reason, tribute_order_id, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `);

      try {
        insertTx.run(randomUUID(), userId, amount, reason, tributeOrderId ?? null, now);
      } catch (err: unknown) {
        if (
          err instanceof Error &&
          err.message.includes("UNIQUE constraint failed: balance_transactions.tribute_order_id")
        ) {
          return { credited: false, balance: this.getBalance(userId) };
        }
        throw err;
      }

      this.db
        .prepare<[number, number, number, string]>(`
          UPDATE user_balance
          SET balance = balance + ?,
              total_purchased = total_purchased + ?,
              updated_at = ?
          WHERE user_id = ?
        `)
        .run(amount, amount, now, userId);

      return { credited: true, balance: this.getBalance(userId) };
    });

    return run();
  }

  getBalanceInfo(userId: string): BalanceInfo {
    const row = this.db
      .prepare<[string], BalanceRow>(`
        SELECT balance, total_purchased, total_spent
        FROM user_balance
        WHERE user_id = ?
      `)
      .get(userId);

    if (!row) {
      return {
        balance: 0,
        totalPurchased: 0,
        totalSpent: 0
      };
    }

    return {
      balance: Number(row.balance),
      totalPurchased: Number(row.total_purchased),
      totalSpent: Number(row.total_spent)
    };
  }
}

function assertPositiveInteger(value: number, field: string): void {
  if (!Number.isFinite(value) || value <= 0 || !Number.isInteger(value)) {
    throw new Error(`${field} must be a positive integer.`);
  }
}

function assertPositiveOrZeroInteger(value: number, field: string): void {
  if (!Number.isFinite(value) || value < 0 || !Number.isInteger(value)) {
    throw new Error(`${field} must be a non-negative integer.`);
  }
}

function assertNonEmptyString(value: string, field: string): void {
  if (value.trim().length === 0) {
    throw new Error(`${field} must be a non-empty string.`);
  }
}
