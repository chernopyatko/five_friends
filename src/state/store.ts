import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

import Database from "better-sqlite3";

import { initSchema, pruneSessionMessages, SESSION_MESSAGE_RETENTION } from "./schema.js";

export type MessageRole = "user" | "assistant";
export type MemoryKind = "fact" | "preference" | "thread" | "episode";
export type MemoryStatus = "active" | "needs_confirmation" | "retracted";

export interface SessionRecord {
  id: string;
  userId: string;
  startedAt: number;
  lastActivityAt: number;
  rollingSummary: string;
}

export interface MessageRecord {
  id: string;
  sessionId: string;
  role: MessageRole;
  text: string;
  createdAt: number;
}

export interface MemoryRecord {
  id: string;
  userId: string;
  kind: MemoryKind;
  text: string;
  importance: number;
  confidence: number;
  status: MemoryStatus;
  sourceSessionId: string | null;
  createdAt: number;
  updatedAt: number;
  lastUsedAt: number | null;
}

export interface NewMemoryInput {
  userId: string;
  kind: MemoryKind;
  text: string;
  importance: number;
  confidence: number;
  status?: MemoryStatus;
  sourceSessionId?: string | null;
}

export interface EnsureSessionInput {
  id: string;
  userId: string;
  startedAt: number;
  lastActivityAt?: number;
  rollingSummary?: string;
}

interface SessionRow {
  id: string;
  user_id: string;
  started_at: number;
  last_activity_at: number;
  rolling_summary: string;
}

interface MessageRow {
  id: string;
  session_id: string;
  role: MessageRole;
  text: string;
  created_at: number;
}

interface MemoryRow {
  id: string;
  user_id: string;
  kind: MemoryKind;
  text: string;
  importance: number;
  confidence: number;
  status: MemoryStatus;
  source_session_id: string | null;
  created_at: number;
  updated_at: number;
  last_used_at: number | null;
}

export class SqliteStore {
  private readonly db: Database;

  constructor(dbPath: string = "data/bot.sqlite") {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    initSchema(this.db);
  }

  getDb(): Database {
    return this.db;
  }

  close(): void {
    this.db.close();
  }

  createSession(userId: string, now: number = Date.now()): SessionRecord {
    const session: SessionRecord = {
      id: randomUUID(),
      userId,
      startedAt: now,
      lastActivityAt: now,
      rollingSummary: ""
    };

    this.db
      .prepare<[string, string, number, number, string]>(`
        INSERT INTO sessions (id, user_id, started_at, last_activity_at, rolling_summary)
        VALUES (?, ?, ?, ?, ?)
      `)
      .run(
        session.id,
        session.userId,
        session.startedAt,
        session.lastActivityAt,
        session.rollingSummary
      );

    return session;
  }

  ensureSession(input: EnsureSessionInput): SessionRecord {
    const existing = this.getSessionById(input.id);
    if (existing) {
      if (input.lastActivityAt && input.lastActivityAt > existing.lastActivityAt) {
        this.touchSession(input.id, input.lastActivityAt);
      }
      return this.getSessionById(input.id) ?? existing;
    }

    const session: SessionRecord = {
      id: input.id,
      userId: input.userId,
      startedAt: input.startedAt,
      lastActivityAt: input.lastActivityAt ?? input.startedAt,
      rollingSummary: input.rollingSummary ?? ""
    };

    this.db
      .prepare<[string, string, number, number, string]>(`
        INSERT INTO sessions (id, user_id, started_at, last_activity_at, rolling_summary)
        VALUES (?, ?, ?, ?, ?)
      `)
      .run(
        session.id,
        session.userId,
        session.startedAt,
        session.lastActivityAt,
        session.rollingSummary
      );

    return session;
  }

  getSessionById(sessionId: string): SessionRecord | null {
    const row = this.db
      .prepare<[string], SessionRow>(`
        SELECT id, user_id, started_at, last_activity_at, rolling_summary
        FROM sessions
        WHERE id = ?
      `)
      .get(sessionId);

    return row ? mapSessionRow(row) : null;
  }

  getLatestSessionForUser(userId: string): SessionRecord | null {
    const row = this.db
      .prepare<[string], SessionRow>(`
        SELECT id, user_id, started_at, last_activity_at, rolling_summary
        FROM sessions
        WHERE user_id = ?
        ORDER BY last_activity_at DESC
        LIMIT 1
      `)
      .get(userId);

    return row ? mapSessionRow(row) : null;
  }

  touchSession(sessionId: string, at: number = Date.now()): void {
    this.db
      .prepare<[number, string]>(`
        UPDATE sessions
        SET last_activity_at = ?
        WHERE id = ?
      `)
      .run(at, sessionId);
  }

  updateRollingSummary(sessionId: string, rollingSummary: string): void {
    this.db
      .prepare<[string, string]>(`
        UPDATE sessions
        SET rolling_summary = ?
        WHERE id = ?
      `)
      .run(rollingSummary, sessionId);
  }

  appendMessage(
    sessionId: string,
    role: MessageRole,
    text: string,
    createdAt: number = Date.now()
  ): MessageRecord {
    const message: MessageRecord = {
      id: randomUUID(),
      sessionId,
      role,
      text,
      createdAt
    };

    this.db
      .prepare<[string, string, MessageRole, string, number]>(`
        INSERT INTO messages (id, session_id, role, text, created_at)
        VALUES (?, ?, ?, ?, ?)
      `)
      .run(message.id, message.sessionId, message.role, message.text, message.createdAt);

    pruneSessionMessages(this.db, sessionId, SESSION_MESSAGE_RETENTION);
    this.touchSession(sessionId, createdAt);

    return message;
  }

  listSessionMessages(sessionId: string, limit: number = SESSION_MESSAGE_RETENTION): MessageRecord[] {
    const rows = this.db
      .prepare<[string, number], MessageRow>(`
        SELECT id, session_id, role, text, created_at
        FROM messages
        WHERE session_id = ?
        ORDER BY created_at ASC
        LIMIT ?
      `)
      .all(sessionId, limit);

    return rows.map(mapMessageRow);
  }

  clearSessionWorkingMemory(sessionId: string): void {
    this.db.prepare<[string]>("DELETE FROM messages WHERE session_id = ?").run(sessionId);
    this.updateRollingSummary(sessionId, "");
  }

  addLongTermMemory(input: NewMemoryInput, now: number = Date.now()): MemoryRecord {
    const memory: MemoryRecord = {
      id: randomUUID(),
      userId: input.userId,
      kind: input.kind,
      text: input.text,
      importance: input.importance,
      confidence: input.confidence,
      status: input.status ?? "active",
      sourceSessionId: input.sourceSessionId ?? null,
      createdAt: now,
      updatedAt: now,
      lastUsedAt: null
    };

    this.db
      .prepare<
        [string, string, MemoryKind, string, number, number, MemoryStatus, string | null, number, number, number | null]
      >(`
        INSERT INTO memories (
          id, user_id, kind, text, importance, confidence, status, source_session_id, created_at, updated_at, last_used_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        memory.id,
        memory.userId,
        memory.kind,
        memory.text,
        memory.importance,
        memory.confidence,
        memory.status,
        memory.sourceSessionId,
        memory.createdAt,
        memory.updatedAt,
        memory.lastUsedAt
      );

    return memory;
  }

  listLongTermMemories(userId: string, limit: number = 50): MemoryRecord[] {
    const rows = this.db
      .prepare<[string, number], MemoryRow>(`
        SELECT id, user_id, kind, text, importance, confidence, status, source_session_id, created_at, updated_at, last_used_at
        FROM memories
        WHERE user_id = ?
        ORDER BY updated_at DESC
        LIMIT ?
      `)
      .all(userId, limit);

    return rows.map(mapMemoryRow);
  }

  deleteLongTermMemories(userId: string): number {
    const result = this.db.prepare<[string]>("DELETE FROM memories WHERE user_id = ?").run(userId);
    return Number(result.changes);
  }

  replaceLongTermMemories(userId: string, memories: NewMemoryInput[], now: number = Date.now()): number {
    const transaction = this.db.transaction((items: NewMemoryInput[]) => {
      this.deleteLongTermMemories(userId);
      for (const item of items) {
        this.addLongTermMemory(
          {
            ...item,
            userId
          },
          now
        );
      }
      return items.length;
    });

    return transaction(memories);
  }
}

function mapSessionRow(row: SessionRow): SessionRecord {
  return {
    id: row.id,
    userId: row.user_id,
    startedAt: row.started_at,
    lastActivityAt: row.last_activity_at,
    rollingSummary: row.rolling_summary
  };
}

function mapMessageRow(row: MessageRow): MessageRecord {
  return {
    id: row.id,
    sessionId: row.session_id,
    role: row.role,
    text: row.text,
    createdAt: row.created_at
  };
}

function mapMemoryRow(row: MemoryRow): MemoryRecord {
  return {
    id: row.id,
    userId: row.user_id,
    kind: row.kind,
    text: row.text,
    importance: row.importance,
    confidence: row.confidence,
    status: row.status,
    sourceSessionId: row.source_session_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastUsedAt: row.last_used_at
  };
}
