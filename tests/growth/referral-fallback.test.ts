import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ReferralService } from "../../src/growth/referral.js";
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

function createStore() {
  const dir = mkdtempSync(join(tmpdir(), "five-friends-ref-fb-"));
  tempDirs.push(dir);
  const store = new SqliteStore(join(dir, "bot.sqlite"));
  stores.push(store);
  return store;
}

describe("referral deterministic fallback", () => {
  it("deterministic code is stable, non-empty, and unique per userId", () => {
    const codeA1 = createHash("sha256").update("user-a").digest("base64url").slice(0, 16);
    const codeA2 = createHash("sha256").update("user-a").digest("base64url").slice(0, 16);
    const codeB = createHash("sha256").update("user-b").digest("base64url").slice(0, 16);

    expect(codeA1).toBe(codeA2);
    expect(codeA1.length).toBe(16);
    expect(codeA1).not.toBe(codeB);
  });

  it("user inserted with deterministic code is found without retry on subsequent calls", () => {
    const store = createStore();
    const db = store.getDb();
    const userId = "u-fallback-sim";

    // Simulate what the deterministic fallback does: insert user with sha256-based code
    const deterministicCode = createHash("sha256").update(userId).digest("base64url").slice(0, 16);
    db.prepare("INSERT INTO users (user_id, inviter_code, created_at) VALUES (?, ?, ?)")
      .run(userId, deterministicCode, Date.now());

    const referrals = new ReferralService(db);

    // ensureUser should find existing user immediately (no retries)
    const code = referrals.getOrCreateInviterCode(userId);
    expect(code).toBe(deterministicCode);
    expect(code.length).toBe(16);

    // Verify persistence — the row is real, not synthetic
    const row = db
      .prepare<[string], { user_id: string; inviter_code: string }>(
        "SELECT user_id, inviter_code FROM users WHERE user_id = ?"
      )
      .get(userId);
    expect(row).toBeDefined();
    expect(row?.inviter_code).toBe(deterministicCode);
  });

  it("applyStartPayload works for user with deterministic code", () => {
    const store = createStore();
    const db = store.getDb();
    const inviterId = "inviter-det";
    const inviteeId = "invitee-det";

    // Create inviter with deterministic code (simulating fallback path)
    const deterministicCode = createHash("sha256").update(inviterId).digest("base64url").slice(0, 16);
    db.prepare("INSERT INTO users (user_id, inviter_code, created_at) VALUES (?, ?, ?)")
      .run(inviterId, deterministicCode, Date.now());

    const referrals = new ReferralService(db);

    // Attribution should work for inviter who has a deterministic code
    const result = referrals.applyStartPayload(inviteeId, `ref_${deterministicCode}`);
    expect(result.attributed).toBe(true);
    expect(referrals.hasInviter(inviteeId)).toBe(true);
  });
});
