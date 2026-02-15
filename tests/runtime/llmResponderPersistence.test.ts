import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { OpenAILLMResponder } from "../../src/runtime/llmResponder.js";
import { createInitialSessionState } from "../../src/state/session.js";
import { SqliteStore } from "../../src/state/store.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  tempDirs.length = 0;
});

describe("llm responder persistence", () => {
  it("persists session messages, rolling summary and long-term memory in sqlite", async () => {
    const dir = mkdtempSync(join(tmpdir(), "five-friends-responder-"));
    tempDirs.push(dir);
    const store = new SqliteStore(join(dir, "bot.sqlite"));

    const outputs = [
      JSON.stringify({
        requested_mode: "SINGLE",
        requested_persona: "yan",
        safety_class: "none",
        emotional_intensity: "low",
        needs_escalation: false,
        confidence: 0.91,
        reasons: ["DEFAULT_SINGLE"]
      }),
      "Разложим это по шагам и выберем один следующий шаг.",
      "Итого: у пользователя задача снизить тревогу и вернуть контроль.",
      JSON.stringify([
        {
          kind: "preference",
          text: "любит короткие практичные ответы",
          importance: 4,
          confidence: 0.88
        }
      ])
    ];

    const fakeClient = {
      responses: {
        async create(): Promise<unknown> {
          const next = outputs.shift();
          if (!next) {
            throw new Error("No fake output left.");
          }
          return { output_text: next };
        }
      }
    };

    const responder = new OpenAILLMResponder(fakeClient, { store });
    const state = createInitialSessionState({ sessionId: "session-1", now: 1000 });
    state.currentPersona = "yan";

    const generated = await responder.generate({
      userId: "u1",
      task: {
        mode: "SINGLE",
        persona: "yan",
        userText: "помоги собрать мысли"
      },
      state
    });

    expect(generated[0]?.text).toContain("🧠 Ян — Разум");
    expect(store.listSessionMessages("session-1", 20)).toHaveLength(2);
    expect(store.getSessionById("session-1")?.rollingSummary).toContain("Итого:");
    expect(store.listLongTermMemories("u1", 10)).toHaveLength(1);
    store.close();
  });

  it("clears long-term on /forget and session working memory on /reset", () => {
    const dir = mkdtempSync(join(tmpdir(), "five-friends-responder-"));
    tempDirs.push(dir);
    const store = new SqliteStore(join(dir, "bot.sqlite"));
    store.ensureSession({
      id: "old-session",
      userId: "u2",
      startedAt: 1000
    });
    store.appendMessage("old-session", "user", "m1", 1001);
    store.addLongTermMemory({
      userId: "u2",
      kind: "fact",
      text: "old memory",
      importance: 3,
      confidence: 0.7
    });

    const fakeClient = {
      responses: {
        async create(): Promise<unknown> {
          throw new Error("not used");
        }
      }
    };
    const responder = new OpenAILLMResponder(fakeClient, { store });

    responder.clearLongTerm("u2");
    expect(store.listLongTermMemories("u2")).toHaveLength(0);

    responder.resetSession({
      userId: "u2",
      previousSessionId: "old-session",
      newSessionId: "new-session"
    });
    expect(store.listSessionMessages("old-session")).toHaveLength(0);
    expect(store.getSessionById("new-session")).not.toBeNull();
    store.close();
  });
});
