import type { Persona } from "../llm/schemas.js";

const PERSONA_HEADERS: Record<Exclude<Persona, "inna">, string> = {
  yan: "🧠 Ян — Разум",
  natasha: "❤️ Наташа — Сердце",
  anya: "🌀 Аня — Смысл",
  max: "🧱 Макс — Реальность"
};

export function formatSingleResponse(persona: Exclude<Persona, "inna">, body: string): string {
  const header = PERSONA_HEADERS[persona];
  const normalizedBody = body.trim();
  if (!normalizedBody) {
    throw new Error("Single response body must not be empty.");
  }
  if (normalizedBody.startsWith(header)) {
    return normalizedBody;
  }
  return `${header}\n${normalizedBody}`;
}
