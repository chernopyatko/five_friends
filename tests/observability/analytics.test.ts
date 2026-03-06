import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { AnalyticsService } from "../../src/observability/analytics.js";
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

function createAnalytics() {
  const dir = mkdtempSync(join(tmpdir(), "five-friends-analytics-"));
  tempDirs.push(dir);
  const store = new SqliteStore(join(dir, "bot.sqlite"));
  stores.push(store);
  const logs: unknown[] = [];
  const logger = {
    info(payload: unknown) {
      logs.push(payload);
    },
    warn(payload: unknown) {
      logs.push(payload);
    }
  } as never;

  return {
    analytics: new AnalyticsService({
      db: store.getDb(),
      logger
    }),
    db: store.getDb(),
    logs
  };
}

describe("analytics service", () => {
  it("emits hashed user event and increments daily aggregate", () => {
    const { analytics, db, logs } = createAnalytics();
    db.prepare("INSERT INTO users (user_id, inviter_code, created_at) VALUES (?, ?, ?)").run("u1", "code_u1", Date.now());

    analytics.emitEvent({
      event: "start",
      userId: "u1",
      sessionId: "s1",
      extra: {
        has_ref_code: true
      }
    });

    const row = db
      .prepare<[string], { total: number }>("SELECT COALESCE(SUM(count), 0) AS total FROM event_daily WHERE event = ?")
      .get("start");
    expect(Number(row?.total ?? 0)).toBe(1);

    const payload = (logs[0] as { analytics_event?: { user_id_hash?: string; has_ref_code?: boolean } }).analytics_event;
    expect(payload?.user_id_hash).toBeTypeOf("string");
    expect(payload?.user_id_hash).not.toBe("u1");
    expect(payload?.has_ref_code).toBe(true);
  });

  it("logs WARN on HTTP non-OK response", async () => {
    const dir = mkdtempSync(join(tmpdir(), "five-friends-analytics-http-"));
    tempDirs.push(dir);
    const store = new SqliteStore(join(dir, "bot.sqlite"));
    stores.push(store);
    const warnings: unknown[] = [];
    const logger = {
      info() {},
      warn(payload: unknown) {
        warnings.push(payload);
      }
    } as never;

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(null, { status: 500 })
    );

    const analytics = new AnalyticsService({
      db: store.getDb(),
      logger,
      httpEndpoint: "http://mock-endpoint.test"
    });

    analytics.emitEvent({
      event: "start",
      userId: "u-http",
      sessionId: "s-http"
    });

    // Wait for the async HTTP call to complete
    await new Promise((resolve) => setTimeout(resolve, 50));
    fetchSpy.mockRestore();

    const warnEntry = warnings.find(
      (w) => (w as { outcome?: string }).outcome === "analytics_http_error"
    ) as { outcome: string; details: { status: number } } | undefined;
    expect(warnEntry).toBeDefined();
    expect(warnEntry?.details.status).toBe(500);
  });

  it("builds stats snapshot from UTC daily aggregates", () => {
    const { analytics, db } = createAnalytics();
    db.prepare("INSERT INTO event_daily (date, event, count) VALUES (?, ?, ?)").run("2026-03-01", "start", 10);
    db.prepare("INSERT INTO event_daily (date, event, count) VALUES (?, ?, ?)").run("2026-03-05", "start", 4);
    db.prepare("INSERT INTO event_daily (date, event, count) VALUES (?, ?, ?)").run("2026-03-05", "ask_all", 3);
    db.prepare("INSERT INTO event_daily (date, event, count) VALUES (?, ?, ?)").run("2026-03-05", "share_clicked", 2);

    const now = Date.UTC(2026, 2, 5, 12, 0, 0);
    const stats = analytics.getStatsSnapshot(now);

    expect(stats.todayDate).toBe("2026-03-05");
    expect(stats.today.starts).toBe(4);
    expect(stats.today.askAll).toBe(3);
    expect(stats.today.shareClicked).toBe(2);
    expect(stats.sevenDays.starts).toBe(14);
  });
});
