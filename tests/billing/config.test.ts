import { describe, expect, it } from "vitest";

import { loadBillingConfig } from "../../src/billing/config.js";

describe("billing config", () => {
  it("marks config as ready when all billing env vars are valid", () => {
    const config = loadBillingConfig({
      TRIBUTE_API_SECRET: "secret",
      TRIBUTE_LINK_SMALL: "https://pay.example/small",
      TRIBUTE_LINK_MEDIUM: "https://pay.example/medium",
      TRIBUTE_LINK_LARGE: "https://pay.example/large",
      TRIBUTE_PRODUCT_MAP: '{"p50":50,"p150":150,"p350":350}'
    });

    expect(config.isConfigured).toBe(true);
    expect(config.productMap).toEqual({ p50: 50, p150: 150, p350: 350 });
  });

  it("disables billing when url is invalid or map is malformed", () => {
    const invalidUrl = loadBillingConfig({
      TRIBUTE_API_SECRET: "secret",
      TRIBUTE_LINK_SMALL: "not-a-url",
      TRIBUTE_LINK_MEDIUM: "https://pay.example/medium",
      TRIBUTE_LINK_LARGE: "https://pay.example/large",
      TRIBUTE_PRODUCT_MAP: '{"p50":50}'
    });

    expect(invalidUrl.isConfigured).toBe(false);

    const invalidMap = loadBillingConfig({
      TRIBUTE_API_SECRET: "secret",
      TRIBUTE_LINK_SMALL: "https://pay.example/small",
      TRIBUTE_LINK_MEDIUM: "https://pay.example/medium",
      TRIBUTE_LINK_LARGE: "https://pay.example/large",
      TRIBUTE_PRODUCT_MAP: "broken"
    });

    expect(invalidMap.isConfigured).toBe(false);
  });

  it("does not configure billing without API secret", () => {
    const config = loadBillingConfig({
      TRIBUTE_LINK_SMALL: "https://pay.example/small",
      TRIBUTE_LINK_MEDIUM: "https://pay.example/medium",
      TRIBUTE_LINK_LARGE: "https://pay.example/large",
      TRIBUTE_PRODUCT_MAP: '{"p50":50}'
    });

    expect(config.tributeApiSecret).toBeUndefined();
    expect(config.isConfigured).toBe(false);
  });
});
