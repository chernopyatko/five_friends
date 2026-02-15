import { describe, expect, it } from "vitest";

import { toSafeLog } from "../../src/observability/logger.js";
import { MetricsCollector } from "../../src/observability/metrics.js";

describe("observability", () => {
  it("removes raw text fields from safe logs", () => {
    const payload = toSafeLog({
      requestId: "r1",
      details: {
        text: "secret",
        userText: "secret2",
        mode_hint: "single"
      }
    });

    expect(payload.details).toEqual({ mode_hint: "single" });
  });

  it("records metrics only when enabled", () => {
    const enabled = new MetricsCollector(true);
    enabled.increment("requests_total");
    enabled.record({ name: "requests_total", value: 2 });
    expect(enabled.get("requests_total")).toBe(3);

    const disabled = new MetricsCollector(false);
    disabled.increment("requests_total");
    expect(disabled.get("requests_total")).toBe(0);
  });
});
