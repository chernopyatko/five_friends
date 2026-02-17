import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  assertPromptInput,
  MODE_PROMPT_FILES,
  PERSONA_PROMPT_FILES,
  TOOL_PROMPT_FILES,
  type BotMode,
  type Persona,
  type PromptBuildInput,
  type ToolScenario
} from "./schemas.js";

const PROMPTS_DIR = join(process.cwd(), "prompts");
const PROMPT_CACHE = new Map<string, string>();

const SYSTEM_PROMPT_FILE = "LLM_SYSTEM_PROMPT_RU_LONG.md";
const GLOBAL_INSTRUCTIONS_FILE = "global_instructions.txt";

export function readPromptFile(fileName: string): string {
  const cacheKey = fileName;
  const cached = PROMPT_CACHE.get(cacheKey);
  if (cached) {
    return cached;
  }

  const content = readFileSync(join(PROMPTS_DIR, fileName), "utf8").trim();
  PROMPT_CACHE.set(cacheKey, content);
  return content;
}

export function clearPromptCache(): void {
  PROMPT_CACHE.clear();
}

export function getSystemPrompt(): string {
  return readPromptFile(SYSTEM_PROMPT_FILE);
}

export function getGlobalInstructions(): string {
  return readPromptFile(GLOBAL_INSTRUCTIONS_FILE);
}

export function getModePrompt(mode: Exclude<BotMode, "SINGLE">): string {
  return readPromptFile(MODE_PROMPT_FILES[mode]);
}

export function getPersonaPrompt(persona: Persona): string {
  return readPromptFile(PERSONA_PROMPT_FILES[persona]);
}

export function getToolPrompt(scenario: ToolScenario): string {
  return readPromptFile(TOOL_PROMPT_FILES[scenario]);
}

export function buildPromptInstructions(input: PromptBuildInput): string {
  assertPromptInput(input);

  const chunks: string[] = [];

  // 1) Base system layer from source-of-truth file.
  chunks.push(getSystemPrompt());

  // 2) Global shared behavior constraints.
  chunks.push(getGlobalInstructions());

  // 3) Mode layer (for non-SINGLE modes).
  if (input.mode !== "SINGLE") {
    chunks.push(getModePrompt(input.mode));
  }

  // 4) Persona layer (only SINGLE).
  if (input.mode === "SINGLE" && input.persona) {
    chunks.push(getPersonaPrompt(input.persona));
  }

  // 5) Tool layer for scenario-driven SINGLE flows.
  if (input.mode === "SINGLE" && input.toolScenario) {
    chunks.push(getToolPrompt(input.toolScenario));
  }

  // 6) Untrusted data delimiters.
  const memory = (input.memoryBlock ?? "").trim();
  chunks.push(`MEMORY_START\n${memory}\nMEMORY_END`);
  chunks.push(`USER_MESSAGE_START\n${input.userMessage.trim()}\nUSER_MESSAGE_END`);

  return chunks.join("\n\n");
}
