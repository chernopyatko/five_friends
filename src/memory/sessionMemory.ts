export interface SessionTurn {
  role: "user" | "assistant";
  text: string;
}

export interface RollingSummaryInput {
  existingSummary: string;
  recentMessages: SessionTurn[];
}

export interface MiniApiClient {
  responses: {
    create(input: Record<string, unknown>): Promise<unknown>;
  };
}

export function buildRollingSummaryRequest(input: RollingSummaryInput): Record<string, unknown> {
  const messages = input.recentMessages
    .map((message) => `${message.role.toUpperCase()}: ${message.text}`)
    .join("\n");

  return {
    model: "gpt-5-mini",
    reasoning: { effort: "high" },
    instructions:
      "Обнови краткую сводку текущей сессии. Только факты и намерения пользователя. 4-8 коротких строк.",
    input: [
      {
        role: "user",
        content: [
          {
            type: "input_text",
            text:
              `CURRENT_ROLLING_SUMMARY_START\n${input.existingSummary}\nCURRENT_ROLLING_SUMMARY_END\n\n` +
              `RECENT_MESSAGES_START\n${messages}\nRECENT_MESSAGES_END`
          }
        ]
      }
    ]
  };
}

export async function updateRollingSummary(client: MiniApiClient, input: RollingSummaryInput): Promise<string> {
  const request = buildRollingSummaryRequest(input);
  const response = await client.responses.create(request);
  return extractOutputText(response);
}

function extractOutputText(response: unknown): string {
  if (!isRecord(response)) {
    throw new Error("Mini response must be object.");
  }
  const outputText = response.output_text;
  if (typeof outputText !== "string" || !outputText.trim()) {
    throw new Error("Mini response missing output_text.");
  }
  return outputText.trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
