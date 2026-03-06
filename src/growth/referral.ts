import { createHash, randomBytes } from "node:crypto";

import type Database from "better-sqlite3";
import type { Logger as PinoLogger } from "pino";

import { hashUserId } from "../utils/hashUserId.js";

const INVITER_CODE_LENGTH = 10;
const MAX_CODE_RETRIES = 5;

interface UserRow {
  user_id: string;
  inviter_user_id: string | null;
  inviter_code: string;
  created_at: number;
}

export interface ReferralAttributionResult {
  attributed: boolean;
  inviterUserId: string | null;
  code: string | null;
}

export class ReferralService {
  private readonly db: Database;
  private readonly logger?: PinoLogger;

  constructor(db: Database, logger?: PinoLogger) {
    this.db = db;
    this.logger = logger;
  }

  ensureUser(userId: string, now: number = Date.now()): UserRow {
    const existing = this.getUser(userId);
    if (existing) {
      return existing;
    }

    for (let attempt = 0; attempt < MAX_CODE_RETRIES; attempt += 1) {
      const inviterCode = generateInviterCode();
      try {
        this.db
          .prepare<[string, string, number]>(`
            INSERT INTO users (user_id, inviter_code, created_at)
            VALUES (?, ?, ?)
          `)
          .run(userId, inviterCode, now);
        const created = this.getUser(userId);
        if (created) {
          return created;
        }
      } catch (error) {
        if (isUserAlreadyExistsError(error)) {
          const existingUser = this.getUser(userId);
          if (existingUser) {
            return existingUser;
          }
        }
        if (isInviterCodeCollision(error)) {
          continue;
        }
        throw error;
      }
    }

    this.logger?.warn(
      {
        outcome: "referral_code_retry_exhausted",
        details: {
          retries: MAX_CODE_RETRIES
        }
      },
      "Inviter code collision retries exhausted, switching to fallback strategy"
    );

    for (let attempt = 0; attempt < 20; attempt += 1) {
      const inviterCode = generateFallbackInviterCode();
      try {
        this.db
          .prepare<[string, string, number]>(`
            INSERT INTO users (user_id, inviter_code, created_at)
            VALUES (?, ?, ?)
          `)
          .run(userId, inviterCode, now);
        const created = this.getUser(userId);
        if (created) {
          return created;
        }
      } catch (error) {
        if (isUserAlreadyExistsError(error)) {
          const existingUser = this.getUser(userId);
          if (existingUser) {
            return existingUser;
          }
        }
        if (isInviterCodeCollision(error)) {
          continue;
        }
        throw error;
      }
    }

    this.logger?.warn(
      {
        outcome: "referral_code_fallback_exhausted",
        details: {
          user_id_hash: hashUserId(userId)
        }
      },
      "Random inviter code retries exhausted, using deterministic fallback from userId"
    );
    // Deterministic code derived from userId — unique because user_id is unique.
    const deterministicCode = createHash("sha256").update(userId).digest("base64url").slice(0, 16);
    try {
      this.db
        .prepare<[string, string, number]>(`
          INSERT INTO users (user_id, inviter_code, created_at)
          VALUES (?, ?, ?)
        `)
        .run(userId, deterministicCode, now);
      const created = this.getUser(userId);
      if (created) {
        return created;
      }
    } catch (error) {
      if (isUserAlreadyExistsError(error)) {
        const existingUser = this.getUser(userId);
        if (existingUser) {
          return existingUser;
        }
      }
      if (isInviterCodeCollision(error)) {
        // Even the deterministic code collided — theoretically impossible
        // since user_id is unique, but handle gracefully.
        this.logger?.error(
          { outcome: "deterministic_code_collision", details: { user_id_hash: hashUserId(userId) } },
          "Deterministic inviter code collided — this should never happen"
        );
      }
      throw error;
    }
    throw new Error(`Failed to persist user ${hashUserId(userId)} after deterministic fallback`);
  }

  getOrCreateInviterCode(userId: string): string {
    return this.ensureUser(userId).inviter_code;
  }

  hasInviter(userId: string): boolean {
    const row = this.db
      .prepare<[string], { inviter_user_id: string | null }>(`
        SELECT inviter_user_id
        FROM users
        WHERE user_id = ?
      `)
      .get(userId);
    return Boolean(row?.inviter_user_id);
  }

  countInvitedUsers(): number {
    const row = this.db
      .prepare<[], { total: number }>(`
        SELECT COUNT(*) AS total
        FROM users
        WHERE inviter_user_id IS NOT NULL
      `)
      .get();
    return Number(row?.total ?? 0);
  }

  applyStartPayload(userId: string, payload?: string | null): ReferralAttributionResult {
    this.ensureUser(userId);
    const code = extractReferralCodeFromStartPayload(payload);
    if (!code) {
      return { attributed: false, inviterUserId: null, code: null };
    }

    const inviter = this.db
      .prepare<[string], { user_id: string }>(`
        SELECT user_id
        FROM users
        WHERE inviter_code = ?
      `)
      .get(code);

    if (!inviter || inviter.user_id === userId) {
      return { attributed: false, inviterUserId: inviter?.user_id ?? null, code };
    }

    const update = this.db
      .prepare<[string, string]>(`
        UPDATE users
        SET inviter_user_id = ?
        WHERE user_id = ?
          AND inviter_user_id IS NULL
      `)
      .run(inviter.user_id, userId);

    return {
      attributed: Number(update.changes) > 0,
      inviterUserId: inviter.user_id,
      code
    };
  }

  private getUser(userId: string): UserRow | null {
    const row = this.db
      .prepare<[string], UserRow>(`
        SELECT user_id, inviter_user_id, inviter_code, created_at
        FROM users
        WHERE user_id = ?
      `)
      .get(userId);
    return row ?? null;
  }
}

export function extractReferralCodeFromStartPayload(payload?: string | null): string | null {
  if (!payload) {
    return null;
  }
  const trimmed = payload.trim();
  if (!trimmed.startsWith("ref_")) {
    return null;
  }
  const code = trimmed.slice(4).trim();
  return code.length > 0 ? code : null;
}

function generateInviterCode(): string {
  return randomBytes(8).toString("base64url").slice(0, INVITER_CODE_LENGTH);
}

function generateFallbackInviterCode(): string {
  return randomBytes(12).toString("base64url").slice(0, 12);
}

function isInviterCodeCollision(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.message.includes("UNIQUE constraint failed: users.inviter_code")
  );
}

function isUserAlreadyExistsError(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.message.includes("UNIQUE constraint failed: users.user_id")
  );
}
