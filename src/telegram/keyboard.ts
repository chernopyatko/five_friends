import type { TributeLinks } from "../billing/config.js";

export interface InlineCallbackButton {
  text: string;
  data: string;
}

export interface InlineUrlButton {
  text: string;
  url: string;
}

export type InlineButton = InlineCallbackButton | InlineUrlButton;
export type InlineKeyboard = InlineButton[][];
export type ReplyKeyboard = string[][];

export function startKeyboard(): InlineKeyboard {
  return [
    [
      { text: "🧠 Ян", data: "choose_friend:yan" },
      { text: "❤️ Наташа", data: "choose_friend:natasha" }
    ],
    [
      { text: "🌀 Аня", data: "choose_friend:anya" },
      { text: "🎯 Макс", data: "choose_friend:max" }
    ],
    [
      { text: "🚀 Спросить всех", data: "panel_start" },
      { text: "📋 Итоги", data: "summary_now" }
    ]
  ];
}

export function coldStartKeyboard(): InlineKeyboard {
  return [
    [{ text: "🤯 Есть ситуация — нужен взгляд со стороны", data: "cs_situation" }],
    [{ text: "💬 Сложное сообщение — помоги ответить или написать", data: "cs_message" }],
    [{ text: "🙂 Просто хочу поболтать", data: "cs_chat" }]
  ];
}

export function coldStartMessageKeyboard(): InlineKeyboard {
  return [
    [{ text: "📝 Написать сообщение кому-то", data: "cs_compose" }],
    [{ text: "💬 Ответить на чужое сообщение", data: "cs_reply" }]
  ];
}

export function coldStartChatKeyboard(): InlineKeyboard {
  return [
    [
      { text: "🧠 Ян — разложит по полочкам", data: "cs_chat_yan" },
      { text: "❤️ Наташа — поддержит и поймёт", data: "cs_chat_natasha" }
    ],
    [
      { text: "🌀 Аня — задаст точный вопрос", data: "cs_chat_anya" },
      { text: "🎯 Макс — скажет как есть", data: "cs_chat_max" }
    ]
  ];
}

export function friendPickerKeyboard(): InlineKeyboard {
  return [
    [
      { text: "🧠 Ян", data: "choose_friend:yan" },
      { text: "❤️ Наташа", data: "choose_friend:natasha" }
    ],
    [
      { text: "🌀 Аня", data: "choose_friend:anya" },
      { text: "🎯 Макс", data: "choose_friend:max" }
    ]
  ];
}

export function friendsKeyboard(): InlineKeyboard {
  return [
    [
      { text: "🧠 Позвать Яна", data: "choose_friend:yan" },
      { text: "❤️ Позвать Наташу", data: "choose_friend:natasha" }
    ],
    [
      { text: "🌀 Позвать Аню", data: "choose_friend:anya" },
      { text: "🎯 Позвать Макса", data: "choose_friend:max" }
    ],
    [{ text: "🚀 Спросить всех", data: "panel_start" }]
  ];
}

export function panelAfterKeyboard(): InlineKeyboard {
  return [
    [
      { text: "🧠 Продолжить с Яном", data: "choose_friend:yan" },
      { text: "❤️ Продолжить с Наташей", data: "choose_friend:natasha" }
    ],
    [
      { text: "🌀 Продолжить с Аней", data: "choose_friend:anya" },
      { text: "🎯 Продолжить с Максом", data: "choose_friend:max" }
    ]
  ];
}

export function mainReplyKeyboard(): ReplyKeyboard {
  return [
    ["🚀 Спросить всех", "👥 Друзья"],
    ["📝 Напиши за меня", "💬 Помоги ответить"],
    ["📋 Итоги", "❓ Помощь"],
    ["⭐ Премиум", "⚙️ Настройки"]
  ];
}

export function settingsKeyboard(): InlineKeyboard {
  return [
    [{ text: "🔒 Приватность", data: "settings_privacy" }],
    [{ text: "🎭 Демо", data: "settings_demo" }],
    [{ text: "🔄 Сбросить сессию", data: "settings_reset" }],
    [{ text: "🧹 Забыть всё", data: "settings_forget" }]
  ];
}

export function settingsKeyboardWithReminders(remindersEnabled: boolean): InlineKeyboard {
  return [
    [{ text: "🔒 Приватность", data: "settings_privacy" }],
    [{ text: "🎭 Демо", data: "settings_demo" }],
    [{ text: remindersEnabled ? "🔔 Напоминания: вкл" : "🔕 Напоминания: выкл", data: "settings_toggle_reminders" }],
    [{ text: "🔄 Сбросить сессию", data: "settings_reset" }],
    [{ text: "🧹 Забыть всё", data: "settings_forget" }]
  ];
}

export function demoTryKeyboard(): InlineKeyboard {
  return [[{ text: "🚀 Попробовать тоже", data: "panel_start" }]];
}

export function forgetConfirmKeyboard(): InlineKeyboard {
  return [
    [{ text: "🧹 Да, забыть всё", data: "forget_confirm_yes" }],
    [{ text: "↩️ Нет, оставить", data: "forget_confirm_no" }]
  ];
}

export function resetConfirmKeyboard(): InlineKeyboard {
  return [
    [{ text: "🔄 Да, сбросить сессию", data: "reset_confirm_yes" }],
    [{ text: "↩️ Нет, оставить", data: "reset_confirm_no" }]
  ];
}

export function safetyKeyboard(): InlineKeyboard {
  return [
    [{ text: "Мне сейчас небезопасно", data: "safety_yes" }],
    [{ text: "Я в порядке ✅", data: "safety_no" }],
    [{ text: "Найти помощь", data: "safety_help" }]
  ];
}

export function safetyHoldKeyboard(): InlineKeyboard {
  return [[{ text: "Найти помощь", data: "safety_help" }, { text: "Я в безопасности ✅", data: "safety_resume" }]];
}

export function helpCountryKeyboard(): InlineKeyboard {
  return [[
    { text: "RU", data: "help_country:RU" },
    { text: "UA", data: "help_country:UA" },
    { text: "KZ", data: "help_country:KZ" },
    { text: "BY", data: "help_country:BY" },
    { text: "Другая", data: "help_country:OTHER" }
  ]];
}

export function shareKeyboard(link: string): InlineKeyboard {
  void link;
  return [[
    { text: "Посоветовать бота", data: "sh" }
  ]];
}

export function paywallKeyboard(links: TributeLinks): InlineKeyboard {
  return buildTributeKeyboard(links);
}

export function lowBalanceKeyboard(links: TributeLinks): InlineKeyboard {
  return buildTributeKeyboard(links);
}

export function balanceInfoKeyboard(links: TributeLinks): InlineKeyboard {
  return buildTributeKeyboard(links);
}

function buildTributeKeyboard(links: TributeLinks): InlineKeyboard {
  const rows: InlineKeyboard = [];
  if (links.small) {
    rows.push([{ text: "📦 50 сообщений — 299₽", url: links.small }]);
  }
  if (links.medium) {
    rows.push([{ text: "📦 150 сообщений — 599₽", url: links.medium }]);
  }
  if (links.large) {
    rows.push([{ text: "📦 350 сообщений — 999₽", url: links.large }]);
  }
  return rows;
}
