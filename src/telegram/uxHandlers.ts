import { randomUUID } from "node:crypto";

import {
  demoTryKeyboard,
  forgetConfirmKeyboard,
  friendsKeyboard,
  mainReplyKeyboard,
  safetyHoldKeyboard,
  settingsKeyboard,
  startKeyboard,
  type InlineKeyboard,
  type ReplyKeyboard
} from "./keyboard.js";
import { CRISIS_RESUME_TEXT, getCrisisResponder, getHelpDiscovery, getSafetyCheck, type HelpCountryCode } from "../security/safety.js";
import { createInitialSessionState, type Persona, type UserSessionState } from "../state/session.js";
import type { BotMode } from "../llm/schemas.js";

const RATE_LIMIT_WINDOW_MS = 2000;
const RATE_LIMIT_MAX_MESSAGES = 5;
const START_TEXT =
  "Пять AI-друзей с разными характерами: эмоционально поддержат, посмотрят на ситуацию с разных сторон и помогут найти опору, когда тяжело и не с кем поговорить.\n" +
  "Главная фишка: 🚀 Все сразу — один запрос, четыре взгляда и короткий итог от Инны.\n" +
  "Кого позвать?";
const HELP_TEXT =
  "❓ Как тут всё устроено\n" +
  "Здесь тебя слышат. Это чат, где рядом пять друзей — и каждый отвечает по-своему. Ты выбираешь, кого позвать, и пишешь как обычно, одним сообщением.\n\n" +
  "🚀 Все сразу — главный режим\n" +
  "Если нужна максимальная польза за один заход: нажми 🚀 Все сразу → следующее твоё сообщение разберут четверо, а Инна соберёт итог и 1–3 шага. После этого можно продолжить с тем, кто “попал” лучше.\n\n" +
  "⸻\n\n" +
  "👥 Друзья — кто есть кто\n\n" +
  "🧠 Ян — рациональный друг.\n" +
  "Он превращает хаос в структуру: отделяет факты от мыслей, показывает, где мозг накручивает, и в конце даёт 1–3 маленьких шага на ближайшие день-два. Хорош, когда нужно решить, выбрать, начать.\n\n" +
  "❤️ Наташа — бережная подруга.\n" +
  "Она помогает выдохнуть: называет то, что с тобой происходит, делает это нормальным и находит опору, чтобы ты не оставался один на один с эмоциями.\n\n" +
  "🌀 Аня — смысловой компас.\n" +
  "Она помогает увидеть, что для тебя правда важно в этой ситуации, где ты застрял между “так надо” и “так хочется”, и какую цену ты платишь действием или бездействием. Её ответы дают ощущение “я понял, про что это” — и куда я на самом деле двигаюсь.\n\n" +
  "🧱 Макс — добрый реалист с иронией.\n" +
  "Он возвращает на землю: помогает отличить “что реально произошло” от того, что мозг дорисовал, снимает лишний накал и предлагает один простой следующий шаг. Может шутить над тем, как мозг раздувает драму, но не над тобой. Хорош, когда хочется рубануть с плеча, сорваться, или когда всё кажется “концом света”.\n\n" +
  "📌 Инна — собранная “редакторка смысла”.\n" +
  "Она делает сводку текущей сессии: что главное, что пока неясно, и 1–3 следующих шага. Если голова кипит — Инна превращает это в короткий список и план.\n\n" +
  "⸻\n\n" +
  "Если ты написал без выбора\n" +
  "Ничего страшного: бот спросит “кого позвать?” — выберешь, и он ответит.\n\n" +
  "⚙️ Настройки\n" +
  "Там можно сбросить текущую сессию, управлять тем, что бот помнит, и удалить сохранённое.";
const PRIVACY_TEXT =
  "Храним текущую сессию и долгую память без сырых прод-логов. /reset сбрасывает сессию, /forget удаляет долгую память.";
const SETTINGS_TEXT = "⚙️ Настройки\nВыбери действие:";
const FORGET_CONFIRM_TEXT =
  "🧹 Подтверди удаление долгой памяти.\nБот забудет всё, о чём вы говорили ранее (long-term память).";
const DEMO_TEXT =
  "Пользователь (пример):\n" +
  "«Мне 29. Год тяну с увольнением: платят хорошо, но я выгорел, начальник токсичный, утром ком в животе. Хочу переезд в другую страну, но страшно. Девушка устала от моей “я решусь потом”. Я мечусь: уйти страшно, остаться тоже. Как принять решение и не развалиться?»\n\n" +
  "Пять друзей:\n" +
  "🧠 Ян — Разум\n" +
  "Ты застрял в петле: стресс -> мысль “я не справлюсь” -> откладывание -> ещё больше усталости и стыда. Сейчас не надо решать “всю жизнь”, надо сделать выбор управляемым. Разведи две задачи: работа на ближайшие 4-6 недель и переезд как план на 6-12 месяцев. Сделай 3 сценария (остаться / уйти с переходом / уйти сразу) и для каждого выпиши, что делает его безопасным. На 1-3 дня выбери один конкретный шаг: обновить резюме или откликнуться на 3 вакансии.\n\n" +
  "❤️ Наташа — Сердце\n" +
  "Похоже, ты долго держишься в месте, которое тебя давит, и поэтому внутри уже нет сил “собраться”. В такой ситуации легко себя гнобить, но твоё “мне плохо” — не каприз. И девушку я понимаю: она устала не от тебя, а от подвешенности. Сейчас тебе важно дать себе чуть-чуть воздуха: сон, еда, прогулка, короткий вечер без обсуждения “судьбы”. Когда тело перестаёт трясти, решения принимаются легче.\n\n" +
  "🌀 Аня — Смысл\n" +
  "Это про то, кем ты хочешь быть: человеком, который выбирает свою жизнь, или человеком, который терпит ради “так надо”. Цена остаться — продолжать терять себя по чуть-чуть. Цена уйти — неопределённость, но шанс вернуть себе уважение и направление. Тебе не нужно прыгать с обрыва; тебе нужно начать строить мост: маленькими шагами, но в сторону своей жизни.\n\n" +
  "🧱 Макс — Реальность\n" +
  "Ты пытаешься выиграть в игру “чтобы не было риска и страха”. Так не бывает. Можно выбрать только, какой риск ты берёшь: уйти или продолжать умирать по утрам. Деньги — аргумент, но не повод жить в клетке. Сделай “план выхода без героизма”: подушка, сроки, варианты. И с девушкой обсуждай не “когда-нибудь”, а конкретику: что ты делаешь на этой неделе.\n\n" +
  "📌 Инна — Сводка\n" +
  "Итого: ты не “не умеешь решать”, ты завис в петле откладывания, и она бьёт по здоровью и отношениям.\n" +
  "Главное:\n" +
  "• Раздели работу (короткий горизонт) и переезд (длинный план).\n" +
  "• Телесный сигнал (“ком в животе”) — маркер, что цена “терпеть” уже высокая.\n" +
  "• Вам с девушкой нужны не бесконечные разговоры, а видимые шаги и сроки.\n\n" +
  "На ближайшие 72 часа:\n" +
  "1. Выпиши 3 сценария (остаться / уйти с переходом / уйти сразу) и по каждому: подушка, сроки, первый шаг.\n" +
  "2. Сделай один реальный шаг: резюме + 3 отклика/сообщения знакомым.\n" +
  "3. Договор с девушкой: “на этой неделе я делаю X и Y, в воскресенье сверяемся”, без драм и ультиматумов.";

export interface IncomingEvent {
  updateId: number;
  userId: string;
  text?: string;
  command?: "/start" | "/help" | "/friends" | "/reset" | "/privacy" | "/forget" | "/settings" | "/demo";
  callbackData?: string;
  now?: number;
}

export interface OutgoingMessage {
  text: string;
  keyboard?: InlineKeyboard;
  replyKeyboard?: ReplyKeyboard;
}

export interface HandleResult {
  messages: OutgoingMessage[];
  state: UserSessionState;
  llmTask?: LLMTask;
  clearLongTerm?: boolean;
  sessionReset?: {
    previousSessionId: string;
  };
}

export interface LLMTask {
  mode: Extract<BotMode, "SINGLE" | "PANEL" | "SUMMARY">;
  persona?: Persona;
  userText: string;
}

export class UXHandlers {
  private readonly states = new Map<string, UserSessionState>();

  handleEvent(event: IncomingEvent): HandleResult {
    const now = event.now ?? Date.now();
    const state = this.getOrCreateState(event.userId, now);

    if (state.lastProcessedUpdateId !== null && event.updateId <= state.lastProcessedUpdateId) {
      return {
        messages: [{ text: "Эта кнопка устарела. Выбери ещё раз." }],
        state
      };
    }
    state.lastProcessedUpdateId = event.updateId;

    if (isRateLimited(state, now)) {
      return {
        messages: [{ text: "Слишком быстро. Подожди пару секунд и напиши ещё раз." }],
        state
      };
    }

    if (event.command) {
      const commandResult = this.handleCommand(event.command, state);
      state.lastActivityTs = now;
      return {
        messages: commandResult.messages,
        state,
        llmTask: commandResult.llmTask,
        sessionReset: commandResult.sessionReset,
        clearLongTerm: commandResult.clearLongTerm
      };
    }

    if (event.callbackData) {
      const callbackResult = this.handleCallback(event.callbackData, state);
      state.lastActivityTs = now;
      return {
        messages: callbackResult.messages,
        state,
        llmTask: callbackResult.llmTask,
        sessionReset: callbackResult.sessionReset,
        clearLongTerm: callbackResult.clearLongTerm
      };
    }

    if (event.text !== undefined) {
      const messages = this.handleText(event.text, state);
      state.lastActivityTs = now;
      return {
        messages: messages.messages,
        state,
        llmTask: messages.llmTask
      };
    }

    return { messages: [], state };
  }

  getState(userId: string): UserSessionState | undefined {
    return this.states.get(userId);
  }

  private handleCommand(
    command: IncomingEvent["command"],
    state: UserSessionState
  ): {
    messages: OutgoingMessage[];
    llmTask?: LLMTask;
    clearLongTerm?: boolean;
    sessionReset?: {
      previousSessionId: string;
    };
  } {
    switch (command) {
      case "/start":
        return {
          messages: [
            {
              text: START_TEXT,
              replyKeyboard: mainReplyKeyboard()
            }
          ]
        };
      case "/help":
        return {
          messages: [
            {
              text: HELP_TEXT,
              replyKeyboard: mainReplyKeyboard()
            }
          ]
        };
      case "/friends":
        return {
          messages: [{ text: "Кто в чате: 🧠 Ян, ❤️ Наташа, 🌀 Аня, 🧱 Макс, 📌 Инна.", replyKeyboard: mainReplyKeyboard() }]
        };
      case "/privacy":
        return {
          messages: [
            {
              text: PRIVACY_TEXT,
              replyKeyboard: mainReplyKeyboard()
            }
          ]
        };
      case "/forget":
        state.pendingForgetConfirmation = true;
        return {
          messages: [{ text: FORGET_CONFIRM_TEXT, keyboard: forgetConfirmKeyboard(), replyKeyboard: mainReplyKeyboard() }]
        };
      case "/settings":
        return {
          messages: [{ text: SETTINGS_TEXT, keyboard: settingsKeyboard(), replyKeyboard: mainReplyKeyboard() }]
        };
      case "/demo":
        return {
          messages: [{ text: DEMO_TEXT, keyboard: demoTryKeyboard() }]
        };
      case "/reset": {
        const previousSessionId = state.sessionId;
        this.resetSession(state);
        return {
          messages: [
            {
              text: state.currentPersona
                ? `Ок, начнём заново. Продолжаем с ${personaLabel(state.currentPersona)}.`
                : "Ок, начнём заново. Кого позвать?",
              replyKeyboard: mainReplyKeyboard()
            }
          ],
          sessionReset: {
            previousSessionId
          }
        };
      }
      default:
        return { messages: [] };
    }
  }

  private handleCallback(callbackData: string, state: UserSessionState): {
    messages: OutgoingMessage[];
    llmTask?: LLMTask;
    clearLongTerm?: boolean;
    sessionReset?: {
      previousSessionId: string;
    };
  } {
    if (callbackData.startsWith("choose_friend:")) {
      const persona = callbackData.split(":")[1] as Persona | undefined;
      if (!persona || !["yan", "natasha", "anya", "max"].includes(persona)) {
        return { messages: [{ text: "Не понял выбор. Попробуй ещё раз." }] };
      }
      return { messages: this.selectPersona(state, persona) };
    }

    if (callbackData === "panel_start") {
      if (state.pendingMode === "awaiting_panel_input") {
        return { messages: [{ text: "Я уже жду сообщение для всех друзей.", replyKeyboard: mainReplyKeyboard() }] };
      }
      state.lastPersonaBeforePanel = state.currentPersona;
      state.pendingMode = "awaiting_panel_input";
      state.pendingForgetConfirmation = false;
      return {
        messages: [{ text: "🤝 Ок. Следующее сообщение разберём вместе. Опиши ситуацию одним сообщением.", replyKeyboard: mainReplyKeyboard() }]
      };
    }

    if (callbackData === "panel_cancel") {
      state.pendingMode = null;
      return { messages: [{ text: "Отменил режим 🤝. Продолжаем.", replyKeyboard: mainReplyKeyboard() }] };
    }

    if (callbackData === "friends_info") {
      state.pendingMode = null;
      return { messages: [{ text: "Выбери, кого позвать.", keyboard: friendsKeyboard(), replyKeyboard: mainReplyKeyboard() }] };
    }

    if (callbackData === "settings_privacy") {
      return { messages: [{ text: PRIVACY_TEXT, replyKeyboard: mainReplyKeyboard() }] };
    }

    if (callbackData === "settings_reset") {
      const previousSessionId = state.sessionId;
      this.resetSession(state);
      return {
        messages: [
          {
            text: state.currentPersona
              ? `Ок, начнём заново. Продолжаем с ${personaLabel(state.currentPersona)}.`
              : "Ок, начнём заново. Кого позвать?",
            replyKeyboard: mainReplyKeyboard()
          }
        ],
        sessionReset: {
          previousSessionId
        }
      };
    }

    if (callbackData === "summary_now") {
      state.pendingMode = null;
      state.pendingForgetConfirmation = false;
      return {
        messages: [{ text: "📌 Инна — Сводка\nИтого: ...\n- ...\nШаги: ..." }],
        llmTask: {
          mode: "SUMMARY",
          userText: "сводка"
        }
      };
    }

    if (callbackData === "settings_forget") {
      state.pendingForgetConfirmation = true;
      return {
        messages: [{ text: FORGET_CONFIRM_TEXT, keyboard: forgetConfirmKeyboard(), replyKeyboard: mainReplyKeyboard() }]
      };
    }

    if (callbackData === "forget_confirm_yes") {
      if (!state.pendingForgetConfirmation) {
        return { messages: [{ text: "Эта кнопка устарела. Выбери ещё раз." }] };
      }
      state.pendingForgetConfirmation = false;
      return {
        messages: [{ text: "Ок, бот забудет всё, о чём вы говорили. Долгая память удалена.", replyKeyboard: mainReplyKeyboard() }],
        clearLongTerm: true
      };
    }

    if (callbackData === "forget_confirm_no") {
      if (!state.pendingForgetConfirmation) {
        return { messages: [{ text: "Эта кнопка устарела. Выбери ещё раз." }] };
      }
      state.pendingForgetConfirmation = false;
      return { messages: [{ text: "Ок, оставляю память как есть.", replyKeyboard: mainReplyKeyboard() }] };
    }

    if (callbackData === "safety_yes") {
      state.safetyHold = true;
      const crisis = getCrisisResponder();
      return { messages: [{ text: crisis.text, keyboard: safetyHoldKeyboard() }] };
    }

    if (callbackData === "safety_no" || callbackData === "safety_resume") {
      state.safetyHold = false;
      return { messages: [{ text: CRISIS_RESUME_TEXT }] };
    }

    if (callbackData === "safety_help") {
      const response = getHelpDiscovery(null);
      return { messages: [{ text: response.text }] };
    }

    if (callbackData.startsWith("help_country:")) {
      const code = callbackData.split(":")[1] as HelpCountryCode | undefined;
      if (!code) {
        return { messages: [{ text: "Не понял страну. Выбери ещё раз." }] };
      }
      const response = getHelpDiscovery(code);
      return { messages: [{ text: response.text }] };
    }

    return { messages: [{ text: "Эта кнопка устарела. Выбери ещё раз." }] };
  }

  private handleText(text: string, state: UserSessionState): {
    messages: OutgoingMessage[];
    llmTask?: LLMTask;
  } {
    const normalized = text.toLowerCase().trim();
    const quickAction = normalizeQuickActionText(text);

    if (state.safetyHold) {
      const crisis = getCrisisResponder();
      return { messages: [{ text: crisis.text, keyboard: safetyHoldKeyboard() }] };
    }

    const quickPersona = resolveQuickPersona(quickAction);
    if (quickPersona) {
      return { messages: this.selectPersona(state, quickPersona) };
    }

    if (quickAction === "помощь") {
      return { messages: [{ text: HELP_TEXT, replyKeyboard: mainReplyKeyboard() }] };
    }

    if (quickAction === "настройки") {
      return { messages: [{ text: SETTINGS_TEXT, keyboard: settingsKeyboard(), replyKeyboard: mainReplyKeyboard() }] };
    }

    if (quickAction === "демо") {
      return { messages: [{ text: DEMO_TEXT, keyboard: demoTryKeyboard() }] };
    }

    if (
      state.pendingMode === "awaiting_panel_input" &&
      (quickAction === "все сразу" || quickAction === "совет всех" || quickAction === "позвать всех")
    ) {
      return { messages: [{ text: "Я уже жду сообщение для всех друзей.", replyKeyboard: mainReplyKeyboard() }] };
    }

    if (state.pendingMode === "awaiting_panel_input") {
      state.pendingMode = null;
      state.pendingForgetConfirmation = false;
      return {
        messages: [{ text: "Принял. Собираю разбор от всех друзей, это может занять до 20-30 секунд." }],
        llmTask: {
          mode: "PANEL",
          userText: text
        }
      };
    }

    if (
      quickAction === "все сразу" ||
      quickAction === "совет всех" ||
      quickAction === "позвать всех" ||
      normalized === "все сразу" ||
      normalized === "совет всех" ||
      normalized === "позвать всех"
    ) {
      state.lastPersonaBeforePanel = state.currentPersona;
      state.pendingMode = "awaiting_panel_input";
      state.pendingForgetConfirmation = false;
      return {
        messages: [
          {
            text: "🤝 Ок. Следующее сообщение разберём вместе. Опиши ситуацию одним сообщением.",
            replyKeyboard: mainReplyKeyboard()
          }
        ]
      };
    }

    if (quickAction === "инна" || quickAction === "сводка" || normalized === "сводка") {
      return {
        messages: [{ text: "📌 Инна — Сводка\nИтого: ...\n- ...\nШаги: ..." }],
        llmTask: {
          mode: "SUMMARY",
          userText: text
        }
      };
    }

    const safetyClass = maybeSoftSafety(normalized);
    if (safetyClass === "soft") {
      state.pendingSafetyCheck = true;
      state.pendingUserText = text;
      const safety = getSafetyCheck();
      return { messages: [{ text: safety.text }] };
    }

    if (state.currentPersona === null) {
      state.pendingUserText = text;
      return { messages: [{ text: "Понял. Кого позвать, чтобы ответить?", keyboard: startKeyboard() }] };
    }

    return {
      messages: [{ text: `(${personaLabel(state.currentPersona)}) ${text}` }],
      llmTask: {
        mode: "SINGLE",
        persona: state.currentPersona,
        userText: text
      }
    };
  }

  private selectPersona(state: UserSessionState, persona: Persona): OutgoingMessage[] {
    const wasPanelPending = state.pendingMode === "awaiting_panel_input";
    state.pendingMode = null;
    state.pendingForgetConfirmation = false;
    state.currentPersona = persona;

    if (state.pendingUserText) {
      const pending = state.pendingUserText;
      state.pendingUserText = null;
      return [
        { text: `Сейчас с тобой ${personaLabel(persona)}.`, replyKeyboard: mainReplyKeyboard() },
        { text: `(${personaLabel(persona)}) ${pending}` }
      ];
    }

    if (wasPanelPending) {
      return [{ text: `Ок, отменил режим 🤝. Сейчас с тобой ${personaLabel(persona)}.`, replyKeyboard: mainReplyKeyboard() }];
    }

    return [{ text: `Сейчас с тобой ${personaLabel(persona)}.`, replyKeyboard: mainReplyKeyboard() }];
  }

  private getOrCreateState(userId: string, now: number): UserSessionState {
    let state = this.states.get(userId);
    if (!state) {
      state = createInitialSessionState({
        sessionId: randomUUID(),
        now
      });
      this.states.set(userId, state);
    }
    return state;
  }

  private resetSession(state: UserSessionState): void {
    const keptPersona = state.currentPersona;
    const now = Date.now();
    const reset = createInitialSessionState({
      sessionId: randomUUID(),
      now
    });
    reset.currentPersona = keptPersona;
    Object.assign(state, reset);
  }
}

function personaLabel(persona: Persona): string {
  switch (persona) {
    case "yan":
      return "Ян";
    case "natasha":
      return "Наташа";
    case "anya":
      return "Аня";
    case "max":
      return "Макс";
    default:
      return "друг";
  }
}

function resolveQuickPersona(action: string): Persona | null {
  switch (action) {
    case "ян":
      return "yan";
    case "наташа":
      return "natasha";
    case "аня":
      return "anya";
    case "макс":
      return "max";
    default:
      return null;
  }
}

function normalizeQuickActionText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isRateLimited(state: UserSessionState, now: number): boolean {
  const rate = state.rateLimitState;
  if (now - rate.windowStartTs > RATE_LIMIT_WINDOW_MS) {
    rate.windowStartTs = now;
    rate.count = 0;
  }
  rate.count += 1;
  return rate.count > RATE_LIMIT_MAX_MESSAGES;
}

function maybeSoftSafety(text: string): "soft" | "none" {
  if (text.includes("мне очень тяжело") || text.includes("я на грани")) {
    return "soft";
  }
  return "none";
}
