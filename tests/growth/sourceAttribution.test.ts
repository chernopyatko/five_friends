import { describe, expect, it } from "vitest";

import { parseStartPayload, sanitizeCampaign } from "../../src/growth/sourceAttribution.js";

describe("source attribution", () => {
  it("returns null attribution for empty payload", () => {
    expect(parseStartPayload()).toEqual({
      source: null,
      campaign: null,
      rawPayload: null
    });
    expect(parseStartPayload("   ")).toEqual({
      source: null,
      campaign: null,
      rawPayload: null
    });
  });

  it("parses referral payload", () => {
    expect(parseStartPayload("ref_abc123")).toEqual({
      source: "referral",
      campaign: null,
      rawPayload: "ref_abc123"
    });
  });

  it("parses ads payloads", () => {
    expect(parseStartPayload("gads_loneliness_01")).toEqual({
      source: "google_ads",
      campaign: "loneliness_01",
      rawPayload: "gads_loneliness_01"
    });
    expect(parseStartPayload("tgads_compose_a")).toEqual({
      source: "telegram_ads",
      campaign: "compose_a",
      rawPayload: "tgads_compose_a"
    });
    expect(parseStartPayload("utm_blog_post_1")).toEqual({
      source: "utm",
      campaign: "blog_post_1",
      rawPayload: "utm_blog_post_1"
    });
  });

  it("treats unknown payloads as organic", () => {
    expect(parseStartPayload("foo_bar")).toEqual({
      source: null,
      campaign: null,
      rawPayload: "foo_bar"
    });
  });

  it("sanitizes campaign and keeps null when empty", () => {
    expect(parseStartPayload("gads_")).toEqual({
      source: "google_ads",
      campaign: null,
      rawPayload: "gads_"
    });
    expect(parseStartPayload("gads_<script>alert(1)</script>")).toEqual({
      source: "google_ads",
      campaign: "scriptalert1script",
      rawPayload: "gads_<script>alert(1)</script>"
    });
    expect(sanitizeCampaign("###")).toBeNull();
  });
});
