import { describe, expect, it } from "vitest";

import { createOpenAIResponsesCompatClient } from "../../src/llm/openaiCompatClient.js";

describe("openai compat client", () => {
  it("maps responses.create input to chat.completions.create", async () => {
    const calls: Record<string, unknown>[] = [];
    const fakeClient = {
      chat: {
        completions: {
          async create(input: Record<string, unknown>): Promise<{ choices: Array<{ message: { content: string } }> }> {
            calls.push(input);
            return {
              choices: [{ message: { content: "{\"ok\":true}" } }]
            };
          }
        }
      }
    };

    const compat = createOpenAIResponsesCompatClient(fakeClient);
    const result = await compat.responses.create({
      model: "gpt-5-mini",
      instructions: "router rules",
      input: [
        {
          role: "user",
          content: [{ type: "input_text", text: "hello" }]
        }
      ],
      text: {
        format: {
          type: "json_schema",
          name: "router_decision",
          strict: true,
          schema: { type: "object" }
        }
      }
    });

    expect(result.output_text).toBe("{\"ok\":true}");
    expect(calls).toHaveLength(1);
    expect((calls[0]?.messages as Array<{ role: string; content: string }>)[1]?.content).toBe("hello");
    expect((calls[0]?.response_format as { type: string }).type).toBe("json_schema");
  });

  it("keeps chat.completions.create bound to client context", async () => {
    const completions = {
      calls: [] as Record<string, unknown>[],
      marker: "bound",
      async create(this: { calls: Record<string, unknown>[]; marker: string }, input: Record<string, unknown>) {
        if (this.marker !== "bound") {
          throw new Error("create called without bound context");
        }
        this.calls.push(input);
        return {
          choices: [{ message: { content: "ok" } }]
        };
      }
    };

    const fakeClient = {
      chat: {
        completions
      }
    };

    const compat = createOpenAIResponsesCompatClient(fakeClient);
    const result = await compat.responses.create({
      model: "gpt-5-mini",
      input: [{ role: "user", content: [{ type: "input_text", text: "hello" }] }]
    });

    expect(result.output_text).toBe("ok");
    expect(completions.calls).toHaveLength(1);
  });
});
