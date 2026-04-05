import type Database from "better-sqlite3";

export const SESSION_MESSAGE_RETENTION = 12;

export function initSchema(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      started_at INTEGER NOT NULL,
      last_activity_at INTEGER NOT NULL,
      rolling_summary TEXT DEFAULT ''
    );

    CREATE INDEX IF NOT EXISTS sessions_user_id_idx
      ON sessions(user_id);

    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('user', 'assistant')),
      text TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS messages_session_id_idx
      ON messages(session_id);
    CREATE INDEX IF NOT EXISTS messages_created_at_idx
      ON messages(created_at);

    CREATE TABLE IF NOT EXISTS memories (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      kind TEXT NOT NULL CHECK(kind IN ('fact', 'preference', 'thread', 'episode')),
      text TEXT NOT NULL,
      importance INTEGER NOT NULL CHECK(importance >= 1 AND importance <= 5),
      confidence REAL NOT NULL CHECK(confidence >= 0 AND confidence <= 1),
      status TEXT NOT NULL CHECK(status IN ('active', 'needs_confirmation', 'retracted')),
      source_session_id TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      last_used_at INTEGER
    );

    CREATE INDEX IF NOT EXISTS memories_user_id_idx
      ON memories(user_id);
    CREATE INDEX IF NOT EXISTS memories_user_kind_idx
      ON memories(user_id, kind);
    CREATE INDEX IF NOT EXISTS memories_user_status_idx
      ON memories(user_id, status);

    CREATE TABLE IF NOT EXISTS users (
      user_id TEXT PRIMARY KEY,
      inviter_user_id TEXT,
      inviter_code TEXT NOT NULL UNIQUE,
      created_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS users_inviter_user_id_idx
      ON users(inviter_user_id);

    CREATE TABLE IF NOT EXISTS event_daily (
      date TEXT NOT NULL,
      event TEXT NOT NULL,
      count INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (date, event)
    );

    CREATE TABLE IF NOT EXISTS user_balance (
      user_id TEXT PRIMARY KEY,
      balance INTEGER NOT NULL DEFAULT 15,
      total_purchased INTEGER NOT NULL DEFAULT 0,
      total_spent INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS balance_transactions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      amount INTEGER NOT NULL,
      reason TEXT NOT NULL,
      tribute_order_id TEXT,
      created_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS balance_tx_user_idx
      ON balance_transactions(user_id);
    CREATE INDEX IF NOT EXISTS balance_tx_created_idx
      ON balance_transactions(created_at);
    CREATE UNIQUE INDEX IF NOT EXISTS balance_tx_order_id_uniq
      ON balance_transactions(tribute_order_id)
      WHERE tribute_order_id IS NOT NULL;
  `);
}

export function pruneSessionMessages(
  db: Database,
  sessionId: string,
  keep: number = SESSION_MESSAGE_RETENTION
): number {
  const result = db
    .prepare<[string, string, number]>(`
      DELETE FROM messages
      WHERE session_id = ?
        AND id NOT IN (
          SELECT id
          FROM messages
          WHERE session_id = ?
          ORDER BY created_at DESC
          LIMIT ?
        )
    `)
    .run(sessionId, sessionId, keep);

  return Number(result.changes);
}
