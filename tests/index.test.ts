import { describe, expect, it } from "vitest";

import { parseSupportedCommand, runWithTypingIndicator } from "../src/index.js";

describe("index command parsing", () => {
  it("parses supported commands", () => {
    expect(parseSupportedCommand("/start")).toEqual({ command: "/start", payload: undefined });
    expect(parseSupportedCommand("/friends@mybot")).toEqual({ command: "/friends", payload: undefined });
    expect(parseSupportedCommand("/reset now")).toEqual({ command: "/reset", payload: undefined });
    expect(parseSupportedCommand("/settings")).toEqual({ command: "/settings", payload: undefined });
    expect(parseSupportedCommand("/demo")).toEqual({ command: "/demo", payload: undefined });
    expect(parseSupportedCommand("/balance")).toEqual({ command: "/balance", payload: undefined });
  });

  it("extracts /start payload for deep links", () => {
    expect(parseSupportedCommand("/start ref_abc123")).toEqual({
      command: "/start",
      payload: "ref_abc123"
    });
    expect(parseSupportedCommand("/start@mybot ref_abc123")).toEqual({
      command: "/start",
      payload: "ref_abc123"
    });
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
