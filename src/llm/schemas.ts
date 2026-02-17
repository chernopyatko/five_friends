export type BotMode = "SINGLE" | "PANEL" | "SUMMARY" | "CRISIS";
export type Persona = "yan" | "natasha" | "anya" | "max";
export type ToolScenario = "compose" | "reply";

export interface PromptBuildInput {
  mode: BotMode;
  persona?: Persona | null;
  toolScenario?: ToolScenario | null;
  memoryBlock?: string;
  userMessage: string;
}

export const MODE_PROMPT_FILES: Record<Exclude<BotMode, "SINGLE">, string> = {
  PANEL: "mode_panel.txt",
  SUMMARY: "mode_summary.txt",
  CRISIS: "mode_crisis.txt"
};

export const SINGLE_PERSONAS: readonly Persona[] = ["yan", "natasha", "anya", "max"];

export const PERSONA_PROMPT_FILES: Record<Persona, string> = {
  yan: "persona_yan.txt",
  natasha: "persona_natasha.txt",
  anya: "persona_anya.txt",
  max: "persona_max.txt"
};

export const TOOL_PROMPT_FILES: Record<ToolScenario, string> = {
  compose: "scenario_compose.txt",
  reply: "scenario_reply.txt"
};

export function assertPromptInput(input: PromptBuildInput): void {
  if (!input.userMessage.trim()) {
    throw new Error("PromptBuildInput.userMessage must be a non-empty string.");
  }

  if (input.mode === "SINGLE") {
    const persona = input.persona ?? null;
    if (persona === null || !SINGLE_PERSONAS.includes(persona)) {
      throw new Error("SINGLE mode requires persona one of: yan|natasha|anya|max.");
    }
  }

  if (input.mode !== "SINGLE" && input.toolScenario) {
    throw new Error("toolScenario can be used only in SINGLE mode.");
  }
}
