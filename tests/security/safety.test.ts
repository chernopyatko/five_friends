import { describe, expect, it } from "vitest";

import { classifySafety, getCrisisResponder, getHelpDiscovery, getSafetyCheck } from "../../src/security/safety.js";

describe("safety", () => {
  it("classifies hard safety cases", () => {
    expect(classifySafety("Я хочу покончить с собой")).toBe("hard");
  });

  it("classifies soft safety cases", () => {
    expect(classifySafety("Мне очень тяжело и я на грани")).toBe("soft");
  });

  it("returns none when no markers are present", () => {
    expect(classifySafety("Сегодня просто сложный день")).toBe("none");
  });

  it("returns fixed UX copy for safety check and crisis", () => {
    expect(getSafetyCheck().buttons).toEqual(["Мне сейчас небезопасно", "Я в порядке ✅", "Найти помощь"]);
    expect(getCrisisResponder().buttons).toEqual(["Найти помощь", "Я в безопасности ✅"]);
  });

  it("handles help discovery with unknown and known countries", () => {
    const unknown = getHelpDiscovery(null);
    expect(unknown.needsCountrySelection).toBe(true);

    const known = getHelpDiscovery("UA");
    expect(known.needsCountrySelection).toBe(false);
    expect(known.text).toContain("7333");
  });
});
