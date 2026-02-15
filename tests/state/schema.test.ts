import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it } from "vitest";

import { SESSION_MESSAGE_RETENTION } from "../../src/state/schema.js";
import { SqliteStore } from "../../src/state/store.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  tempDirs.length = 0;
});

function createStore(): SqliteStore {
  const dir = mkdtempSync(join(tmpdir(), "five-friends-schema-"));
  tempDirs.push(dir);
  return new SqliteStore(join(dir, "test.sqlite"));
}

describe("state schema", () => {
  it("creates required tables", () => {
    const store = createStore();
    const db = store.getDb();

    const rows = db
      .prepare<[], { name: string }>(`
        SELECT name
        FROM sqlite_master
        WHERE type = 'table'
      `)
      .all();

    const tableNames = new Set(rows.map((row) => row.name));
    expect(tableNames.has("sessions")).toBe(true);
    expect(tableNames.has("messages")).toBe(true);
    expect(tableNames.has("memories")).toBe(true);

    store.close();
  });

  it("keeps only the last N session messages", () => {
    const store = createStore();
    const session = store.createSession("user-1", 1_000);

    for (let i = 0; i < SESSION_MESSAGE_RETENTION + 3; i += 1) {
      store.appendMessage(session.id, "user", `m${i}`, 2_000 + i);
    }

    const messages = store.listSessionMessages(session.id, 100);
    expect(messages).toHaveLength(SESSION_MESSAGE_RETENTION);
    expect(messages.at(0)?.text).toBe("m3");
    expect(messages.at(-1)?.text).toBe(`m${SESSION_MESSAGE_RETENTION + 2}`);

    store.close();
  });

  it("deletes long-term memories via /forget behavior", () => {
    const store = createStore();
    store.addLongTermMemory({
      userId: "user-1",
      kind: "preference",
      text: "likes concise answers",
      importance: 4,
      confidence: 0.8
    });

    expect(store.listLongTermMemories("user-1")).toHaveLength(1);
    const removed = store.deleteLongTermMemories("user-1");
    expect(removed).toBe(1);
    expect(store.listLongTermMemories("user-1")).toHaveLength(0);

    store.close();
  });

  it("ensures specific session id and replaces long-term memory snapshot", () => {
    const store = createStore();
    const ensured = store.ensureSession({
      id: "session-fixed",
      userId: "user-2",
      startedAt: 10_000
    });
    expect(ensured.id).toBe("session-fixed");
    expect(store.getSessionById("session-fixed")?.userId).toBe("user-2");

    store.addLongTermMemory({
      userId: "user-2",
      kind: "fact",
      text: "old",
      importance: 2,
      confidence: 0.4
    });
    store.replaceLongTermMemories("user-2", [
      {
        userId: "user-2",
        kind: "preference",
        text: "new",
        importance: 5,
        confidence: 0.9
      }
    ]);

    const memories = store.listLongTermMemories("user-2");
    expect(memories).toHaveLength(1);
    expect(memories[0]?.text).toBe("new");
    expect(memories[0]?.kind).toBe("preference");
    store.close();
  });
});
