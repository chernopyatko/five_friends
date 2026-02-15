import OpenAI from "openai";

interface ChatCompletionMessage {
  content?: string | null;
}

interface ChatCompletionChoice {
  message?: ChatCompletionMessage;
}

interface ChatCompletionResponse {
  choices?: ChatCompletionChoice[];
}

interface ChatCompletionClient {
  chat: {
    completions: {
      create(input: Record<string, unknown>): Promise<ChatCompletionResponse>;
    };
  };
}

export interface ResponsesCompatClient {
  responses: {
    create(input: Record<string, unknown>): Promise<{ output_text: string }>;
  };
}

export function createOpenAIResponsesCompatClient(
  client: OpenAI | ChatCompletionClient
): ResponsesCompatClient {
  return {
    responses: {
      async create(input: Record<string, unknown>): Promise<{ output_text: string }> {
        const model = asString(input.model, "gpt-4o-mini");
        const instructions = asString(input.instructions, "");
        const userText = extractUserText(input.input);

        const request: Record<string, unknown> = {
          model,
          messages: [
            ...(instructions ? [{ role: "system", content: instructions }] : []),
            { role: "user", content: userText }
          ]
        };

        const maybeFormat = extractJsonSchemaResponseFormat(input.text);
        if (maybeFormat) {
          request.response_format = maybeFormat;
        }

        const createCompletion = client.chat.completions.create as unknown as (
          this: unknown,
          input: Record<string, unknown>
        ) => Promise<ChatCompletionResponse>;
        const completion = await createCompletion.call(client.chat.completions, request);
        const outputText = completion.choices?.[0]?.message?.content;
        return { output_text: typeof outputText === "string" ? outputText : "" };
      }
    }
  };
}

function extractUserText(input: unknown): string {
  if (!Array.isArray(input)) {
    return "";
  }
  const first = input[0];
  if (!isRecord(first)) {
    return "";
  }
  const content = first.content;
  if (!Array.isArray(content)) {
    return "";
  }
  const firstPart = content[0];
  if (!isRecord(firstPart)) {
    return "";
  }
  return asString(firstPart.text, "");
}

function extractJsonSchemaResponseFormat(textField: unknown): Record<string, unknown> | null {
  if (!isRecord(textField)) {
    return null;
  }
  const format = textField.format;
  if (!isRecord(format) || format.type !== "json_schema") {
    return null;
  }
  const name = asString(format.name, "response_json");
  const schema = isRecord(format.schema) ? format.schema : { type: "object" };
  const strict = Boolean(format.strict);

  return {
    type: "json_schema",
    json_schema: {
      name,
      strict,
      schema
    }
  };
}

function asString(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
