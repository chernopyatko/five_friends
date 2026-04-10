import type Database from "better-sqlite3";
import type { Logger as PinoLogger } from "pino";
import { PostHog } from "posthog-node";

import { createLogger } from "./logger.js";
import { hashUserId } from "../utils/hashUserId.js";

export type AnalyticsEventName =
  | "start"
  | "choose_persona"
  | "ask_all"
  | "tool_write_for_me"
  | "tool_help_reply"
  | "tool_summary"
  | "share_clicked"
  | "model_error"
  | "safety_triggered"
  | "paywall_shown"
  | "purchase_completed";

type EventExtraValue = string | number | boolean | null | undefined;

export interface EmitEventInput {
  event: AnalyticsEventName;
  userId: string;
  sessionId: string;
  inviterPresent?: boolean;
  extra?: Record<string, EventExtraValue>;
}

export interface StatsSnapshot {
  todayDate: string;
  today: {
    starts: number;
    askAll: number;
    toolWrite: number;
    toolReply: number;
    toolSummary: number;
    shareClicked: number;
    modelError: number;
    safetyTriggered: number;
    paywallShown: number;
    purchaseCompleted: number;
  };
  sevenDays: {
    starts: number;
    askAll: number;
    shareClicked: number;
  };
}

interface AnalyticsPayload {
  event: AnalyticsEventName;
  ts: string;
  session_id: string;
  user_id_hash: string;
  inviter_present: boolean;
  [key: string]: string | number | boolean | null | undefined;
}

const RESERVED_PAYLOAD_KEYS = new Set(["event", "ts", "session_id", "user_id_hash", "inviter_present"]);

export class AnalyticsService {
  private readonly db: Database;
  private readonly logger: PinoLogger;
  private readonly posthog?: PostHog;

  constructor(input: {
    db: Database;
    logger?: PinoLogger;
    posthogApiKey?: string;
    posthogHost?: string;
  }) {
    this.db = input.db;
    this.logger = input.logger ?? createLogger();
    if (input.posthogApiKey) {
      this.posthog = new PostHog(input.posthogApiKey, {
        host: input.posthogHost ?? "https://eu.i.posthog.com"
      });
      this.posthog.on("error", (err) => {
        this.logger.warn(
          { outcome: "posthog_error", details: { error: err instanceof Error ? err.message : "unknown" } },
          "PostHog SDK error"
        );
      });
    }
  }

  emitEvent(input: EmitEventInput): void {
    const ts = new Date().toISOString();
    const payload: AnalyticsPayload = {
      event: input.event,
      ts,
      session_id: input.sessionId,
      user_id_hash: hashUserId(input.userId),
      inviter_present: input.inviterPresent ?? this.resolveInviterPresent(input.userId)
    };
    if (input.extra) {
      for (const [key, value] of Object.entries(input.extra)) {
        if (!RESERVED_PAYLOAD_KEYS.has(key)) {
          payload[key] = value;
        }
      }
    }

    this.logger.info({ analytics_event: payload }, "analytics_event");
    this.incEventDaily(input.event, ts);

    if (this.posthog) {
      const properties: Record<string, string | number | boolean | null | undefined> = {
        session_id: payload.session_id,
        inviter_present: payload.inviter_present
      };
      if (input.extra) {
        for (const [key, value] of Object.entries(input.extra)) {
          if (!RESERVED_PAYLOAD_KEYS.has(key)) {
            properties[key] = value;
          }
        }
      }
      this.posthog.capture({
        distinctId: payload.user_id_hash,
        event: input.event,
        properties
      });
    }
  }

  getStatsSnapshot(now: number = Date.now()): StatsSnapshot {
    const todayDate = toUtcDate(now);
    const from7d = toUtcDate(now - 6 * DAY_MS);

    return {
      todayDate,
      today: {
        starts: this.getEventTotalInRange("start", todayDate, todayDate),
        askAll: this.getEventTotalInRange("ask_all", todayDate, todayDate),
        toolWrite: this.getEventTotalInRange("tool_write_for_me", todayDate, todayDate),
        toolReply: this.getEventTotalInRange("tool_help_reply", todayDate, todayDate),
        toolSummary: this.getEventTotalInRange("tool_summary", todayDate, todayDate),
        shareClicked: this.getEventTotalInRange("share_clicked", todayDate, todayDate),
        modelError: this.getEventTotalInRange("model_error", todayDate, todayDate),
        safetyTriggered: this.getEventTotalInRange("safety_triggered", todayDate, todayDate),
        paywallShown: this.getEventTotalInRange("paywall_shown", todayDate, todayDate),
        purchaseCompleted: this.getEventTotalInRange("purchase_completed", todayDate, todayDate)
      },
      sevenDays: {
        starts: this.getEventTotalInRange("start", from7d, todayDate),
        askAll: this.getEventTotalInRange("ask_all", from7d, todayDate),
        shareClicked: this.getEventTotalInRange("share_clicked", from7d, todayDate)
      }
    };
  }

  private resolveInviterPresent(userId: string): boolean {
    const row = this.db
      .prepare<[string], { inviter_user_id: string | null }>(`
        SELECT inviter_user_id
        FROM users
        WHERE user_id = ?
      `)
      .get(userId);
    return Boolean(row?.inviter_user_id);
  }

  private incEventDaily(event: AnalyticsEventName, isoTs: string): void {
    const date = isoTs.slice(0, 10);
    this.db
      .prepare<[string, AnalyticsEventName]>(`
        INSERT INTO event_daily (date, event, count)
        VALUES (?, ?, 1)
        ON CONFLICT(date, event)
        DO UPDATE SET count = count + 1
      `)
      .run(date, event);
  }

  private getEventTotalInRange(event: AnalyticsEventName, fromDateUtc: string, toDateUtc: string): number {
    const row = this.db
      .prepare<[AnalyticsEventName, string, string], { total: number }>(`
        SELECT COALESCE(SUM(count), 0) AS total
        FROM event_daily
        WHERE event = ?
          AND date >= ?
          AND date <= ?
      `)
      .get(event, fromDateUtc, toDateUtc);
    return Number(row?.total ?? 0);
  }

  async shutdown(): Promise<void> {
    if (this.posthog) {
      await this.posthog.shutdown();
    }
  }
}

const DAY_MS = 24 * 60 * 60 * 1000;

function toUtcDate(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10);
}
