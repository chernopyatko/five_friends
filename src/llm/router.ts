import { parseRouterDecision, ROUTER_DECISION_SCHEMA, type RouterDecision } from "./routerSchema.js";

export interface RouterRequestInput {
  model: string;
  instructions: string;
  userText: string;
}

export interface RouterApiClient {
  responses: {
    create(input: Record<string, unknown>): Promise<unknown>;
  };
}

export function buildRouterRequest(input: RouterRequestInput): Record<string, unknown> {
  return {
    model: input.model,
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
    ],
    text: {
      format: {
        type: "json_schema",
        name: "router_decision",
        schema: ROUTER_DECISION_SCHEMA,
        strict: true
      }
    }
  };
}

export function extractRouterJson(response: unknown): string {
  if (!isRecord(response)) {
    throw new Error("Router response must be object.");
  }

  const outputText = response.output_text;
  if (typeof outputText !== "string" || !outputText.trim()) {
    throw new Error("Router response does not contain output_text JSON.");
  }

  return outputText;
}

export async function runRouter(
  client: RouterApiClient,
  input: RouterRequestInput
): Promise<RouterDecision> {
  const request = buildRouterRequest(input);
  const response = await client.responses.create(request);
  const rawJson = extractRouterJson(response);
  const parsed = JSON.parse(rawJson) as unknown;
  return parseRouterDecision(parsed);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
