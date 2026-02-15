import { describe, expect, it } from "vitest";

import { buildGeneratorRequest, runGenerator, selectGeneratorModel } from "../../src/llm/generator.js";

describe("generator", () => {
  it("selects fixed models per mode", () => {
    expect(selectGeneratorModel({ mode: "PANEL" })).toBe("gpt-5.2");
    expect(selectGeneratorModel({ mode: "SUMMARY" })).toBe("gpt-5-mini");
    expect(selectGeneratorModel({ mode: "SINGLE", escalateSingle: false })).toBe("gpt-5.1");
    expect(selectGeneratorModel({ mode: "SINGLE", escalateSingle: true })).toBe("gpt-5.2");
  });

  it("throws when CRISIS is passed to generator", () => {
    expect(() => selectGeneratorModel({ mode: "CRISIS" })).toThrow("must not call generator");
  });

  it("builds request with instructions and reasoning", () => {
    const request = buildGeneratorRequest({
      mode: "SINGLE",
      instructions: "instr",
      userText: "hello"
    });
    expect(request.model).toBe("gpt-5.1");
    expect(request.instructions).toBe("instr");
    expect(request.reasoning).toEqual({ effort: "high" });
  });

  it("returns output text from API response", async () => {
    const fakeClient = {
      responses: {
        async create(): Promise<unknown> {
          return { output_text: "готово" };
        }
      }
    };

    const result = await runGenerator(fakeClient, {
      mode: "SINGLE",
      instructions: "instr",
      userText: "test"
    });

    expect(result.model).toBe("gpt-5.1");
    expect(result.text).toBe("готово");
  });
});
