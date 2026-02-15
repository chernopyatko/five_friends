import { describe, expect, it } from "vitest";

import { formatSingleResponse } from "../../src/modes/single.js";
import { formatSummaryResponse } from "../../src/modes/summary.js";
import { splitMessage, validatePanelFormat } from "../../src/modes/panel.js";

describe("modes", () => {
  it("formats SINGLE with persona header", () => {
    const output = formatSingleResponse("yan", "Разложим ситуацию на шаги.");
    expect(output.startsWith("🧠 Ян — Разум")).toBe(true);
  });

  it("formats SUMMARY with Inna header", () => {
    const output = formatSummaryResponse("Итого: ...");
    expect(output.startsWith("📌 Инна — Сводка")).toBe(true);
  });

  it("validates PANEL format and header order", () => {
    const validPanel = [
      "🧠 Ян — Разум\nФакты и шаги.",
      "❤️ Наташа — Сердце\nПоддержка.",
      "🌀 Аня — Смысл\nВыбор и ценности.",
      "🧱 Макс — Реальность\nПроверка реальности.",
      "📌 Инна — Сводка\nИтого и шаги."
    ].join("\n\n");

    const result = validatePanelFormat(validPanel);
    expect(result.valid).toBe(true);
  });

  it("rejects questions in first four PANEL blocks", () => {
    const invalidPanel = [
      "🧠 Ян — Разум\nЧто делать дальше?",
      "❤️ Наташа — Сердце\nПоддержка.",
      "🌀 Аня — Смысл\nВыбор и ценности.",
      "🧱 Макс — Реальность\nПроверка реальности.",
      "📌 Инна — Сводка\nИтого и шаги."
    ].join("\n\n");
    expect(validatePanelFormat(invalidPanel).valid).toBe(false);
  });

  it("splits long messages into up to 3 parts", () => {
    const longText = "x".repeat(8200);
    const parts = splitMessage(longText, 3900);
    expect(parts.length).toBeGreaterThanOrEqual(2);
    expect(parts.length).toBeLessThanOrEqual(3);
    expect(parts.every((part) => part.length <= 3900)).toBe(true);
  });
});
