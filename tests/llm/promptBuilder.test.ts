import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { buildPromptInstructions, getSystemPrompt } from "../../src/llm/promptBuilder.js";

const PROMPTS_DIR = join(process.cwd(), "prompts");

function readPrompt(name: string): string {
  return readFileSync(join(PROMPTS_DIR, name), "utf8").trim();
}

describe("promptBuilder", () => {
  it("loads LLM_SYSTEM_PROMPT_RU_LONG.md 1:1", () => {
    const fileContent = readPrompt("LLM_SYSTEM_PROMPT_RU_LONG.md");
    expect(getSystemPrompt()).toBe(fileContent);
  });

  it("builds SINGLE prompt with correct order and delimiters", () => {
    const instructions = buildPromptInstructions({
      mode: "SINGLE",
      persona: "anya",
      memoryBlock: "thread=conflict",
      userMessage: "хочу понять, что делать дальше"
    });

    const systemPrompt = getSystemPrompt();
    const globalPrompt = readPrompt("global_instructions.txt");
    const personaPrompt = readPrompt("persona_anya.txt");

    expect(instructions.startsWith(systemPrompt)).toBe(true);
    expect(instructions.includes(globalPrompt)).toBe(true);
    expect(instructions.includes(personaPrompt)).toBe(true);
    expect(instructions.includes("MEMORY_START\nthread=conflict\nMEMORY_END")).toBe(true);
    expect(
      instructions.includes("USER_MESSAGE_START\nхочу понять, что делать дальше\nUSER_MESSAGE_END")
    ).toBe(true);
  });

  it("uses mode prompt for PANEL and skips persona prompt", () => {
    const instructions = buildPromptInstructions({
      mode: "PANEL",
      userMessage: "все сразу"
    });

    const panelPrompt = readPrompt("mode_panel.txt");
    const personaPrompt = readPrompt("persona_anya.txt");

    expect(instructions.includes(panelPrompt)).toBe(true);
    expect(instructions.includes(personaPrompt)).toBe(false);
  });

  it("includes tool prompt for PANEL scenario", () => {
    const instructions = buildPromptInstructions({
      mode: "PANEL",
      toolScenario: "reply",
      userMessage: "Разберите это входящее"
    });

    const panelPrompt = readPrompt("mode_panel.txt");
    const toolPrompt = readPrompt("scenario_reply.txt");

    expect(instructions.includes(panelPrompt)).toBe(true);
    expect(instructions.includes(toolPrompt)).toBe(true);
  });

  it("keeps therapeutic method anchors in every active persona prompt", () => {
    expect(readPrompt("persona_yan.txt")).toEqual(expect.stringContaining("process-based CBT"));
    expect(readPrompt("persona_yan.txt")).toEqual(expect.stringContaining("Metacognitive Therapy"));
    expect(readPrompt("persona_natasha.txt")).toEqual(expect.stringContaining("Emotion-Focused Therapy"));
    expect(readPrompt("persona_natasha.txt")).toEqual(expect.stringContaining("реляционный гештальт"));
    expect(readPrompt("persona_anya.txt")).toEqual(expect.stringContaining("meaning-centered / existential therapy"));
    expect(readPrompt("persona_anya.txt")).toEqual(expect.stringContaining("ACT-подход к ценностям"));
    expect(readPrompt("persona_max.txt")).toEqual(expect.stringContaining("REBT"));
    expect(readPrompt("persona_max.txt")).toEqual(expect.stringContaining("CBT-коучинг"));
  });

  it("prevents Max from using fixed opener examples as persona shortcuts", () => {
    const maxPrompt = readPrompt("persona_max.txt");

    expect(maxPrompt).toEqual(expect.stringContaining("Не используй постоянные входные фразы"));
    expect(maxPrompt).not.toContain("Можешь начать с");
    expect(maxPrompt).not.toContain("Секунду.");
    expect(maxPrompt).not.toContain("Слушай,");
    expect(maxPrompt).not.toContain("Ну вот смотри,");
  });

  it("keeps PANEL anti-repetition constraints for gpt-5.5 ask-all", () => {
    const panelPrompt = readPrompt("mode_panel.txt");

    expect(panelPrompt).toEqual(expect.stringContaining("Макс не использует постоянные входные фразы"));
    expect(panelPrompt).toEqual(expect.stringContaining("не четыре пересказа одной мысли"));
    expect(panelPrompt).toEqual(expect.stringContaining("пересланные тексты, голосовые расшифровки и скриншоты"));
  });

  it("documents collected forwarded inputs in the gpt-5.5 ask-all test prompt", () => {
    const testPrompt = readPrompt("ask_all_gpt55_test_prompt.md");

    expect(testPrompt).toEqual(expect.stringContaining("forwarded text"));
    expect(testPrompt).toEqual(expect.stringContaining("voice transcript"));
    expect(testPrompt).toEqual(expect.stringContaining("screenshot recognition"));
    expect(testPrompt).toEqual(expect.stringContaining("Max must not use a fixed opener"));
  });

  it("treats live phrase examples as tone calibration rather than reusable copy", () => {
    const globalPrompt = readPrompt("global_instructions.txt");

    expect(globalPrompt).toEqual(expect.stringContaining("Примеры живых фраз — калибровка тона"));
    expect(globalPrompt).toEqual(expect.stringContaining("Не копируй их дословно"));
    expect(globalPrompt).toEqual(expect.stringContaining("придумывай свои формулировки"));
  });
});
