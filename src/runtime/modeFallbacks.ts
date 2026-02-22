import type { Persona } from "../state/session.js";

export function formatSingleFallback(persona: Persona): string {
  const header = personaHeader(persona);
  return `${header}\nСлышу тебя. Давай начнём с одного маленького шага, который реально сделать сегодня.`;
}

export function formatSummaryFallback(): string {
  return "📋 Сводка\nИтого: давай коротко зафиксируем главное.\n- что произошло\n- что ты хочешь решить\nШаги: один простой шаг на сегодня.";
}

export function formatPanelFallback(): string {
  return [
    "🧠 Ян — Разум",
    "Соберём факты и один следующий шаг без перегруза.",
    "",
    "❤️ Наташа — Сердце",
    "Тебе правда непросто, это нормально. Сейчас важна опора и бережность к себе.",
    "",
    "🌀 Аня — Смысл",
    "Выбери, что для тебя важнее в этой ситуации, и от этого строй решение.",
    "",
    "🎯 Макс — Реальность",
    "Отделим факты от догадок и сделаем один проверяемый шаг.",
  ].join("\n");
}

function personaHeader(persona: Persona): string {
  switch (persona) {
    case "yan":
      return "🧠 Ян — Разум";
    case "natasha":
      return "❤️ Наташа — Сердце";
    case "anya":
      return "🌀 Аня — Смысл";
    case "max":
      return "🎯 Макс — Реальность";
    default:
      return "🧠 Ян — Разум";
  }
}
