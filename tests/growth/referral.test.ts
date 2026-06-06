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

function createReferralService(): { referrals: ReferralService; store: SqliteStore } {
  const dir = mkdtempSync(join(tmpdir(), "five-friends-ref-"));
  tempDirs.push(dir);
  const store = new SqliteStore(join(dir, "bot.sqlite"));
  stores.push(store);
  return { referrals: new ReferralService(store.getDb()), store };
}

describe("referral service", () => {
  it("generates stable inviter code per user", () => {
    const { referrals } = createReferralService();
    const first = referrals.getOrCreateInviterCode("u1");
    const second = referrals.getOrCreateInviterCode("u1");
    expect(first).toBe(second);
    expect(first.length).toBeGreaterThanOrEqual(8);
  });

  it("attributes inviter only once", () => {
    const { referrals } = createReferralService();
    const inviterCode = referrals.getOrCreateInviterCode("inviter");

    const first = referrals.applyStartPayload("invitee", `ref_${inviterCode}`);
    const second = referrals.applyStartPayload("invitee", `ref_${inviterCode}`);

    expect(first.attributed).toBe(true);
    expect(second.attributed).toBe(false);
    expect(referrals.hasInviter("invitee")).toBe(true);
  });

  it("ignores self-referral", () => {
    const { referrals } = createReferralService();
    const inviterCode = referrals.getOrCreateInviterCode("u-self");

    const result = referrals.applyStartPayload("u-self", `ref_${inviterCode}`);

    expect(result.attributed).toBe(false);
    expect(referrals.hasInviter("u-self")).toBe(false);
  });

  it("sets source once and keeps campaign null semantics", () => {
    const { referrals, store } = createReferralService();
    referrals.applyStartPayload("u-source");

    referrals.setUserSource("u-source", null, null);
    referrals.setUserSource("u-source", "google_ads", "loneliness_01");
    referrals.setUserSource("u-source", "utm", "blog_post_1");

    const row = store.getDb()
      .prepare<[string], { source: string | null; campaign: string | null }>(`
        SELECT source, campaign
        FROM users
        WHERE user_id = ?
      `)
      .get("u-source");
    expect(row).toEqual({
      source: "google_ads",
      campaign: "loneliness_01"
    });

    referrals.applyStartPayload("u-empty-campaign");
    referrals.setUserSource("u-empty-campaign", "utm", "");
    const emptyCampaignRow = store.getDb()
      .prepare<[string], { campaign: string | null }>(`
        SELECT campaign
        FROM users
        WHERE user_id = ?
      `)
      .get("u-empty-campaign");
    expect(emptyCampaignRow?.campaign).toBeNull();
  });

  it("returns source breakdown with organic fallback", () => {
    const { referrals } = createReferralService();
    referrals.applyStartPayload("u1");
    referrals.applyStartPayload("u2");
    referrals.applyStartPayload("u3");
    referrals.setUserSource("u2", "google_ads", "camp");
    referrals.setUserSource("u3", "google_ads", "camp2");

    const breakdown = referrals.getSourceBreakdown();
    const asMap = new Map(breakdown.map((item) => [item.source, item.count]));
    expect(asMap.get("google_ads")).toBe(2);
    expect(asMap.get("organic")).toBe(1);
  });
});
