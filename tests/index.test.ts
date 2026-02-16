import { describe, expect, it } from "vitest";

import { parseSupportedCommand, runWithTypingIndicator } from "../src/index.js";

describe("index command parsing", () => {
  it("parses supported commands", () => {
    expect(parseSupportedCommand("/start")).toBe("/start");
    expect(parseSupportedCommand("/friends@mybot")).toBe("/friends");
    expect(parseSupportedCommand("/reset now")).toBe("/reset");
    expect(parseSupportedCommand("/settings")).toBe("/settings");
    expect(parseSupportedCommand("/demo")).toBe("/demo");
  });

  it("returns null for unsupported commands or plain text", () => {
    expect(parseSupportedCommand("hello")).toBeNull();
    expect(parseSupportedCommand("/unknown")).toBeNull();
  });

  it("emits typing action for slow operations", async () => {
    const typingCalls: Array<{ chatId: number | string; action: "typing" }> = [];
    const ctx = {
      chat: { id: 42 },
      api: {
        async sendChatAction(chatId: number | string, action: "typing"): Promise<void> {
          typingCalls.push({ chatId, action });
        }
      }
    };

    const value = await runWithTypingIndicator(ctx, async () => {
      await new Promise((resolve) => setTimeout(resolve, 350));
      return "done";
    });

    expect(value).toBe("done");
    expect(typingCalls.length).toBeGreaterThan(0);
    expect(typingCalls[0]?.action).toBe("typing");
  });

  it("skips typing action when chat is missing", async () => {
    const typingCalls: Array<{ chatId: number | string; action: "typing" }> = [];
    const ctx = {
      api: {
        async sendChatAction(chatId: number | string, action: "typing"): Promise<void> {
          typingCalls.push({ chatId, action });
        }
      }
    };

    const value = await runWithTypingIndicator(ctx, async () => "ok");
    expect(value).toBe("ok");
    expect(typingCalls).toHaveLength(0);
  });
});
