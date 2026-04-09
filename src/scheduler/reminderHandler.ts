import type Database from "better-sqlite3";
import type { Bot } from "grammy";

import { createLogger, toSafeLog } from "../observability/logger.js";
import { hashUserId } from "../utils/hashUserId.js";

const DEFAULT_INACTIVITY_THRESHOLD_MS = 24 * 60 * 60 * 1000;
const SEND_INTERVAL_MS = 50;

export const REMINDER_TEXT = "Есть что обсудить? Друзья ждут — просто напиши 💬\n\nОтключить напоминания: /settings";

export interface ReminderHandlerDeps {
  db: Database;
  bot: Bot;
  logger: ReturnType<typeof createLogger>;
  inactivityThresholdMs?: number;
}

export interface ReminderResult {
  sent: number;
  skipped: number;
  failed: number;
  disabled: number;
}

interface InactiveUserRow {
  user_id: string;
}

export async function processReminders(deps: ReminderHandlerDeps): Promise<ReminderResult> {
  const now = Date.now();
  const inactivityThresholdMs = deps.inactivityThresholdMs ?? DEFAULT_INACTIVITY_THRESHOLD_MS;
  const inactiveBefore = now - inactivityThresholdMs;
  const utcDayStart = new Date(now).setUTCHours(0, 0, 0, 0);
  const result: ReminderResult = {
    sent: 0,
    skipped: 0,
    failed: 0,
    disabled: 0
  };

  deps.logger.info(
    toSafeLog({
      outcome: "reminder_check_started",
      details: {
        timestamp: now
      }
    }),
    "Daily reminder check started"
  );

  const users = deps.db
    .prepare<[number, number], InactiveUserRow>(`
      SELECT ub.user_id
      FROM user_balance ub
      JOIN (
        SELECT user_id, MAX(last_activity_at) AS last_active
        FROM sessions
        GROUP BY user_id
      ) s ON s.user_id = ub.user_id
      WHERE s.last_active < ?
        AND ub.reminders_enabled = 1
        AND (ub.last_reminder_sent_at IS NULL OR ub.last_reminder_sent_at < ?)
    `)
    .all(inactiveBefore, utcDayStart);

  for (let i = 0; i < users.length; i += 1) {
    const userId = users[i]!.user_id;
    try {
      await deps.bot.api.sendMessage(userId, REMINDER_TEXT);
      deps.db
        .prepare<[number, string]>(`
          UPDATE user_balance
          SET last_reminder_sent_at = ?
          WHERE user_id = ?
        `)
        .run(Date.now(), userId);
      result.sent += 1;
    } catch (error) {
      const message = getReminderErrorMessage(error);
      deps.logger.warn(
        toSafeLog({
          outcome: "reminder_send_failed",
          userHash: hashUserId(userId),
          details: {
            error: message
          }
        }),
        "Failed to send daily reminder"
      );

      if (shouldDisableReminders(error, message)) {
        deps.db
          .prepare<[number, number, string]>(`
            UPDATE user_balance
            SET reminders_enabled = ?,
                updated_at = ?
            WHERE user_id = ?
          `)
          .run(0, Date.now(), userId);
        result.disabled += 1;
      } else {
        result.failed += 1;
      }
    }

    if (i < users.length - 1) {
      await sleep(SEND_INTERVAL_MS);
    }
  }

  deps.logger.info(
    toSafeLog({
      outcome: "reminder_check_completed",
      details: {
        sent: result.sent,
        skipped: result.skipped,
        failed: result.failed,
        disabled: result.disabled
      }
    }),
    "Daily reminder check completed"
  );

  return result;
}

function shouldDisableReminders(error: unknown, message: string): boolean {
  const normalized = message.toLowerCase();
  if (
    normalized.includes("bot was blocked") ||
    normalized.includes("user is deactivated") ||
    normalized.includes("chat not found")
  ) {
    return true;
  }

  const candidate = error as {
    error_code?: number;
    status?: number;
    statusCode?: number;
    response?: { error_code?: number; status?: number; statusCode?: number };
  };

  return (
    candidate.error_code === 403 ||
    candidate.status === 403 ||
    candidate.statusCode === 403 ||
    candidate.response?.error_code === 403 ||
    candidate.response?.status === 403 ||
    candidate.response?.statusCode === 403
  );
}

function getReminderErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  const candidate = error as {
    description?: string;
    message?: string;
    response?: { description?: string };
  };
  return candidate.description ?? candidate.response?.description ?? candidate.message ?? "unknown";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
