import type { SafetyClass } from "../llm/routerSchema.js";

export const SAFETY_CHECK_TEXT =
  "Сейчас звучит очень остро. Это про реальную опасность прямо сейчас?";

export const CRISIS_RESPONDER_TEXT = `Мне очень жаль, что тебе сейчас так больно. Я не могу обсуждать способы причинить вред себе или кому-то ещё.
Пожалуйста, прямо сейчас свяжись с близким человеком или взрослым, которому доверяешь, и попроси быть с тобой.
Если есть риск прямо сейчас — обратись в экстренные службы в твоей стране.
Нажми «Найти помощь» — дам контакты. Если страна неизвестна, предложу выбрать.`;

export const CRISIS_RESUME_TEXT = "Ок. Продолжим.";

export type HelpCountryCode = "RU" | "UA" | "KZ" | "BY" | "OTHER";

export interface HelpDiscoveryResponse {
  text: string;
  needsCountrySelection: boolean;
}

const HARD_MARKERS = [
  "хочу умереть",
  "покончить с собой",
  "суицид",
  "самоубий",
  "убить себя",
  "причинить себе вред",
  "навредить себе",
  "убить его",
  "убить ее",
  "убить их"
];

const SOFT_MARKERS = [
  "мне очень тяжело",
  "я на грани",
  "не вижу смысла",
  "мне страшно",
  "мне небезопасно",
  "не хочу жить",
  "не вывожу"
];

export function classifySafety(text: string): SafetyClass {
  const normalized = normalize(text);
  if (containsAny(normalized, HARD_MARKERS)) {
    return "hard";
  }
  if (containsAny(normalized, SOFT_MARKERS)) {
    return "soft";
  }
  return "none";
}

export function getSafetyCheck(): { text: string; buttons: string[] } {
  return {
    text: SAFETY_CHECK_TEXT,
    buttons: ["Мне сейчас небезопасно", "Я в порядке ✅", "Найти помощь"]
  };
}

export function getCrisisResponder(): { text: string; buttons: string[] } {
  return {
    text: CRISIS_RESPONDER_TEXT,
    buttons: ["Найти помощь", "Я в безопасности ✅"]
  };
}

export function getHelpDiscovery(countryCode: HelpCountryCode | null): HelpDiscoveryResponse {
  if (countryCode === null) {
    return {
      text: "Выбери страну, чтобы я дал контакты помощи.",
      needsCountrySelection: true
    };
  }

  switch (countryCode) {
    case "RU":
      return {
        text: "Экстренная психологическая помощь МЧС России: 8 (495) 989-50-50 (круглосуточно).",
        needsCountrySelection: false
      };
    case "UA":
      return {
        text: "Lifeline Ukraine: 7333 (24/7).",
        needsCountrySelection: false
      };
    case "KZ":
      return {
        text: "1414 — контакт-центр; через него доступна психологическая помощь.",
        needsCountrySelection: false
      };
    case "BY":
      return {
        text:
          "Дети/подростки: 8 801 100 16 11; +375 (17) 263-03-03 (круглосуточно).\n" +
          "Взрослые: +375 (17) 352-44-44; +375 (17) 304-43-70 (круглосуточно).",
        needsCountrySelection: false
      };
    case "OTHER":
    default:
      return {
        text: "Можешь обратиться в экстренные службы в своей стране или к близким.",
        needsCountrySelection: false
      };
  }
}

function normalize(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

function containsAny(text: string, markers: readonly string[]): boolean {
  return markers.some((marker) => text.includes(marker));
}
