export type BotMode = "SINGLE" | "PANEL" | "SUMMARY" | "CRISIS";
export type Persona = "yan" | "natasha" | "anya" | "max" | "inna";

export interface PromptBuildInput {
  mode: BotMode;
  persona?: Persona | null;
  memoryBlock?: string;
  userMessage: string;
}

export const MODE_PROMPT_FILES: Record<Exclude<BotMode, "SINGLE">, string> = {
  PANEL: "mode_panel.txt",
  SUMMARY: "mode_summary.txt",
  CRISIS: "mode_crisis.txt"
};

export const SINGLE_PERSONAS: readonly Persona[] = ["yan", "natasha", "anya", "max"];

export const PERSONA_PROMPT_FILES: Record<Exclude<Persona, "inna">, string> = {
  yan: "persona_yan.txt",
  natasha: "persona_natasha.txt",
  anya: "persona_anya.txt",
  max: "persona_max.txt"
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
}
