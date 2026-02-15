import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { buildPromptInstructions, getSystemPrompt } from "../../src/llm/promptBuilder.js";

const PROMPTS_DIR = join(process.cwd(), "prompts");

describe("promptBuilder", () => {
  it("loads LLM_SYSTEM_PROMPT_RU_LONG.md 1:1", () => {
    const fileContent = readFileSync(join(PROMPTS_DIR, "LLM_SYSTEM_PROMPT_RU_LONG.md"), "utf8").trim();
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
    const globalPrompt = readFileSync(join(PROMPTS_DIR, "global_instructions.txt"), "utf8").trim();
    const personaPrompt = readFileSync(join(PROMPTS_DIR, "persona_anya.txt"), "utf8").trim();

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

    const panelPrompt = readFileSync(join(PROMPTS_DIR, "mode_panel.txt"), "utf8").trim();
    const personaPrompt = readFileSync(join(PROMPTS_DIR, "persona_anya.txt"), "utf8").trim();

    expect(instructions.includes(panelPrompt)).toBe(true);
    expect(instructions.includes(personaPrompt)).toBe(false);
  });
});
