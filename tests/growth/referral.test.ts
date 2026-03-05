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

function createReferralService(): ReferralService {
  const dir = mkdtempSync(join(tmpdir(), "five-friends-ref-"));
  tempDirs.push(dir);
  const store = new SqliteStore(join(dir, "bot.sqlite"));
  stores.push(store);
  return new ReferralService(store.getDb());
}

describe("referral service", () => {
  it("generates stable inviter code per user", () => {
    const referrals = createReferralService();
    const first = referrals.getOrCreateInviterCode("u1");
    const second = referrals.getOrCreateInviterCode("u1");
    expect(first).toBe(second);
    expect(first.length).toBeGreaterThanOrEqual(8);
  });

  it("attributes inviter only once", () => {
    const referrals = createReferralService();
    const inviterCode = referrals.getOrCreateInviterCode("inviter");

    const first = referrals.applyStartPayload("invitee", `ref_${inviterCode}`);
    const second = referrals.applyStartPayload("invitee", `ref_${inviterCode}`);

    expect(first.attributed).toBe(true);
    expect(second.attributed).toBe(false);
    expect(referrals.hasInviter("invitee")).toBe(true);
  });

  it("ignores self-referral", () => {
    const referrals = createReferralService();
    const inviterCode = referrals.getOrCreateInviterCode("u-self");

    const result = referrals.applyStartPayload("u-self", `ref_${inviterCode}`);

    expect(result.attributed).toBe(false);
    expect(referrals.hasInviter("u-self")).toBe(false);
  });
});
