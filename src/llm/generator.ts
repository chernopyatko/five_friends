import type { BotMode } from "./schemas.js";
import { MODEL_ROUTES, type TextGenerationModel } from "./modelRouting.js";

export interface GeneratorApiClient {
  responses: {
    create(input: Record<string, unknown>): Promise<unknown>;
  };
}

export interface GeneratorInput {
  mode: BotMode;
  instructions: string;
  userText: string;
  escalateSingle?: boolean;
}

export type GeneratorModel = TextGenerationModel;

export function selectGeneratorModel(input: { mode: BotMode; escalateSingle?: boolean }): GeneratorModel {
  switch (input.mode) {
    case "PANEL":
      return MODEL_ROUTES.askAll;
    case "SUMMARY":
      return MODEL_ROUTES.summary;
    case "SINGLE":
      return input.escalateSingle ? MODEL_ROUTES.singleEscalated : MODEL_ROUTES.single;
    case "CRISIS":
      throw new Error("CRISIS mode must use fixed response and must not call generator.");
    default:
      throw new Error("Unsupported mode.");
  }
}

export function buildGeneratorRequest(input: GeneratorInput): Record<string, unknown> {
  const model = selectGeneratorModel({
    mode: input.mode,
    escalateSingle: input.escalateSingle
  });

  return {
    model,
    instructions: input.instructions,
    reasoning: {
      effort: "high"
    },
    input: [
      {
        role: "user",
        content: [
          {
            type: "input_text",
            text: input.userText
          }
        ]
      }
    ]
  };
}

export async function runGenerator(
  client: GeneratorApiClient,
  input: GeneratorInput
): Promise<{ model: GeneratorModel; text: string }> {
  const model = selectGeneratorModel({
    mode: input.mode,
    escalateSingle: input.escalateSingle
  });
  const request = buildGeneratorRequest(input);
  const response = await client.responses.create(request);
  const text = extractText(response);
  return { model, text };
}

function extractText(response: unknown): string {
  if (!isRecord(response)) {
    throw new Error("Generator response must be object.");
  }
  const outputText = response.output_text;
  if (typeof outputText !== "string" || !outputText.trim()) {
    throw new Error("Generator response does not contain output_text.");
  }
  return outputText.trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
