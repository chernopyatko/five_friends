import { describe, expect, it } from "vitest";

import { MODEL_ROUTES, resolveModelOverride } from "../../src/llm/modelRouting.js";

describe("modelRouting", () => {
  it("centralizes text, voice, and image recognition routes", () => {
    expect(MODEL_ROUTES.askAll).toBe("gpt-5.5");
    expect(MODEL_ROUTES.single).toBe("gpt-5.4");
    expect(MODEL_ROUTES.summary).toBe("gpt-5-mini");
    expect(MODEL_ROUTES.router).toBe("gpt-5-mini");
    expect(MODEL_ROUTES.memory).toBe("gpt-5-mini");
    expect(MODEL_ROUTES.voiceTranscription).toBe("gpt-4o-mini-transcribe");
    expect(MODEL_ROUTES.imageRecognition).toBe("gpt-4o-mini");
  });

  it("keeps env overrides explicit", () => {
    expect(resolveModelOverride(undefined, MODEL_ROUTES.imageRecognition)).toBe("gpt-4o-mini");
    expect(resolveModelOverride(" custom-model ", MODEL_ROUTES.imageRecognition)).toBe("custom-model");
  });
});
