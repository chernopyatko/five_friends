import { randomUUID } from "node:crypto";

import {
  demoTryKeyboard,
  forgetConfirmKeyboard,
  friendsKeyboard,
  mainReplyKeyboard,
  resetConfirmKeyboard,
  safetyHoldKeyboard,
  safetyKeyboard,
  settingsKeyboard,
  startKeyboard,
  type InlineKeyboard,
  type ReplyKeyboard
} from "./keyboard.js";
import { CRISIS_RESUME_TEXT, getCrisisResponder, getHelpDiscovery, getSafetyCheck, type HelpCountryCode } from "../security/safety.js";
import { buildShareLink, formatShareLinkMessage } from "../growth/share.js";
import type { ReferralService } from "../growth/referral.js";
import { createInitialSessionState, type Persona, type UserSessionState } from "../state/session.js";
import type { AnalyticsService } from "../observability/analytics.js";
import type { BotMode, ToolScenario } from "../llm/schemas.js";

const RATE_LIMIT_WINDOW_MS = 2000;
const RATE_LIMIT_MAX_MESSAGES = 5;
const START_TEXT =
  "Привет! Это бот с четырьмя AI-друзьями — каждый со своим характером.\n" +
  "Можно просто поговорить, попросить совет или разобрать сложную ситуацию.\n\n" +
  "👥 ДРУЗЬЯ\n" +
  "🧠 Ян — разложит по полочкам и даст план\n" +
  "❤️ Наташа — поддержит и назовёт чувства\n" +
  "🌀 Аня — задаст точный вопрос про главное\n" +
  "🎯 Макс — пошутит, вернёт на землю и отделит факты от эмоций\n\n" +
  "🚀 ВСЕ ВЗГЛЯДЫ\n" +
  "Нажми «🚀 Спросить всех» — один запрос, четыре разных ответа.\n\n" +
  "🧰 ИНСТРУМЕНТЫ\n" +
  "📝 Напиши за меня — поможет сформулировать сложное сообщение\n" +
  "💬 Помоги ответить — подскажет что ответить на входящее\n" +
  "📋 Итоги — соберёт сводку вашего разговора\n\n" +
  "⸻\n\n" +
  "Выбери друга внизу 👇 или сразу нажми 🚀 Спросить всех.\n" +
  "Ответ обычно приходит за 5–15 секунд ⏳\n" +
  "📌 Закрепи бот в списке чатов — друзья всегда будут рядом.";
const HELP_TEXT =
  "❓ Как тут всё устроено\n" +
  "Это чат с четырьмя друзьями: Ян, Наташа, Аня, Макс. Ты выбираешь друга и пишешь как обычно.\n\n" +
  "🚀 Спросить всех\n" +
  "Если нужен быстрый разбор с разных сторон: нажми 🚀 Спросить всех → следующее сообщение разберут все четверо.\n\n" +
  "🧰 Инструменты\n" +
  "📝 Напиши за меня — поможет сформулировать сложное сообщение.\n" +
  "💬 Помоги ответить — подскажет что ответить на входящее.\n" +
  "📋 Итоги — коротко собирает суть текущей сессии.\n\n" +
  "⸻\n\n" +
  "👥 Друзья — кто есть кто\n\n" +
  "🧠 Ян — рациональный друг.\n" +
  "Он превращает хаос в структуру и даёт 1–3 шага на ближайшие день-два.\n\n" +
  "❤️ Наташа — бережная подруга.\n" +
  "Она называет чувства точно и мягко, без советов и давления.\n\n" +
  "🌀 Аня — смысловой компас.\n" +
  "Она задаёт точный вопрос про выбор и цену бездействия.\n\n" +
  "🎯 Макс — добрый реалист с иронией.\n" +
  "Он отделяет факты от накрутки и даёт один конкретный вызов на действие.\n\n" +
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
const RESET_CONFIRM_TEXT =
  "🔄 Подтверди сброс текущей сессии.\nБот очистит текущий диалог и pending-состояния. Долгая память не удаляется.";
const DEMO_TEXT =
  "Пользователь (пример):\n" +
  "«Мне 29. Год тяну с увольнением: платят хорошо, но я выгорел, начальник токсичный, утром ком в животе. Хочу переезд в другую страну, но страшно. Девушка устала от моей “я решусь потом”. Я мечусь: уйти страшно, остаться тоже. Как принять решение и не развалиться?»\n\n" +
  "Четыре друга:\n" +
  "🧠 Ян — Разум\n" +
  "Ты застрял в петле: стресс -> мысль “я не справлюсь” -> откладывание -> ещё больше усталости и стыда. Сейчас не надо решать “всю жизнь”, надо сделать выбор управляемым. Разведи две задачи: работа на ближайшие 4-6 недель и переезд как план на 6-12 месяцев. Сделай 3 сценария (остаться / уйти с переходом / уйти сразу) и для каждого выпиши, что делает его безопасным. На 1-3 дня выбери один конкретный шаг: обновить резюме или откликнуться на 3 вакансии.\n\n" +
  "❤️ Наташа — Сердце\n" +
  "Похоже, ты долго держишься в месте, которое тебя давит, и поэтому внутри уже нет сил “собраться”. В такой ситуации легко себя гнобить, но твоё “мне плохо” — не каприз. И девушку я понимаю: она устала не от тебя, а от подвешенности. Сейчас тебе важно дать себе чуть-чуть воздуха: сон, еда, прогулка, короткий вечер без обсуждения “судьбы”. Когда тело перестаёт трясти, решения принимаются легче.\n\n" +
  "🌀 Аня — Смысл\n" +
  "Это про то, кем ты хочешь быть: человеком, который выбирает свою жизнь, или человеком, который терпит ради “так надо”. Цена остаться — продолжать терять себя по чуть-чуть. Цена уйти — неопределённость, но шанс вернуть себе уважение и направление. Тебе не нужно прыгать с обрыва; тебе нужно начать строить мост: маленькими шагами, но в сторону своей жизни.\n\n" +
  "🎯 Макс — Реальность\n" +
  "Ты пытаешься выиграть в игру “чтобы не было риска и страха”. Так не бывает. Можно выбрать только, какой риск ты берёшь: уйти или продолжать умирать по утрам. Деньги — аргумент, но не повод жить в клетке. Сделай “план выхода без героизма”: подушка, сроки, варианты. И с девушкой обсуждай не “когда-нибудь”, а конкретику: что ты делаешь на этой неделе.";

export interface IncomingEvent {
  updateId: number;
  userId: string;
  text?: string;
  command?: "/start" | "/help" | "/friends" | "/reset" | "/privacy" | "/forget" | "/settings" | "/demo" | "/stats";
  commandPayload?: string;
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
  scenario?: ToolScenario | null;
  userText: string;
}

export class UXHandlers {
  private readonly states = new Map<string, UserSessionState>();
  private readonly referrals?: ReferralService;
  private readonly analytics?: AnalyticsService;
  private readonly adminUserIds: Set<string>;
  private readonly botUsername?: string;

  constructor(input?: {
    referrals?: ReferralService;
    analytics?: AnalyticsService;
    adminUserIds?: Iterable<string>;
    botUsername?: string;
  }) {
    this.referrals = input?.referrals;
    this.analytics = input?.analytics;
    this.botUsername = input?.botUsername;
    this.adminUserIds = new Set(
      input?.adminUserIds ??
        (process.env.ADMIN_USER_IDS ?? "")
          .split(",")
          .map((id) => id.trim())
          .filter((id) => id.length > 0)
    );
  }

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
      const commandResult = this.handleCommand(event.command, state, event.userId, event.commandPayload);
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
      const callbackResult = this.handleCallback(event.callbackData, state, event.userId);
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
      const messages = this.handleText(event.text, state, event.userId);
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
    state: UserSessionState,
    userId: string,
    commandPayload?: string
  ): {
    messages: OutgoingMessage[];
    llmTask?: LLMTask;
    clearLongTerm?: boolean;
    sessionReset?: {
      previousSessionId: string;
    };
  } {
    switch (command) {
      case "/start": {
        const referralResult = this.referrals?.applyStartPayload(userId, commandPayload);
        this.analytics?.emitEvent({
          event: "start",
          userId,
          sessionId: state.sessionId,
          extra: {
            has_ref_code: Boolean(commandPayload?.trim().startsWith("ref_")),
            referral_attributed: referralResult?.attributed ?? false
          }
        });
        return {
          messages: [
            {
              text: START_TEXT,
              replyKeyboard: mainReplyKeyboard()
            }
          ]
        };
      }
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
          messages: [{ text: HELP_TEXT, replyKeyboard: mainReplyKeyboard() }]
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
        state.pendingResetConfirmation = false;
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
      case "/stats": {
        if (!this.adminUserIds.has(userId)) {
          return {
            messages: [{ text: "Недостаточно прав." }]
          };
        }
        if (!this.analytics) {
          return {
            messages: [{ text: "Статистика недоступна." }]
          };
        }
        const stats = this.analytics.getStatsSnapshot();
        const invited = this.referrals?.countInvitedUsers() ?? 0;
        return {
          messages: [
            {
              text: formatStatsMessage(stats, invited)
            }
          ]
        };
      }
      case "/reset": {
        state.pendingForgetConfirmation = false;
        state.pendingResetConfirmation = true;
        return {
          messages: [
            {
              text: RESET_CONFIRM_TEXT,
              keyboard: resetConfirmKeyboard(),
              replyKeyboard: mainReplyKeyboard()
            }
          ]
        };
      }
      default:
        return { messages: [] };
    }
  }

  private handleCallback(callbackData: string, state: UserSessionState, userId: string): {
    messages: OutgoingMessage[];
    llmTask?: LLMTask;
    clearLongTerm?: boolean;
    sessionReset?: {
      previousSessionId: string;
    };
  } {
    const isSafetyCallback =
      callbackData === "safety_yes" ||
      callbackData === "safety_no" ||
      callbackData === "safety_resume" ||
      callbackData === "safety_help" ||
      callbackData.startsWith("help_country:");
    if (state.safetyHold && !isSafetyCallback) {
      const crisis = getCrisisResponder();
      return { messages: [{ text: crisis.text, keyboard: safetyHoldKeyboard() }] };
    }

    if (callbackData.startsWith("choose_friend:")) {
      const persona = callbackData.split(":")[1] as Persona | undefined;
      if (!persona || !["yan", "natasha", "anya", "max"].includes(persona)) {
        return { messages: [{ text: "Не понял выбор. Попробуй ещё раз." }] };
      }
      this.analytics?.emitEvent({
        event: "choose_persona",
        userId,
        sessionId: state.sessionId
      });
      return { messages: this.selectPersona(state, persona) };
    }

    if (callbackData === "sh") {
      if (!this.referrals) {
        return { messages: [{ text: "Ссылка пока недоступна." }] };
      }
      const inviterCode = this.referrals.getOrCreateInviterCode(userId);
      const share = buildShareLink(this.botUsername, inviterCode);
      this.analytics?.emitEvent({
        event: "share_clicked",
        userId,
        sessionId: state.sessionId
      });
      return {
        messages: [{ text: formatShareLinkMessage(share.url) }]
      };
    }

    if (callbackData === "panel_start") {
      if (state.pendingMode === "awaiting_panel_input") {
        return { messages: [{ text: "Я уже жду сообщение для всех друзей.", replyKeyboard: mainReplyKeyboard() }] };
      }
      state.lastPersonaBeforePanel = state.currentPersona;
      state.pendingMode = "awaiting_panel_input";
      this.clearDangerConfirmations(state);
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

    if (callbackData === "settings_demo") {
      return { messages: [{ text: DEMO_TEXT, keyboard: demoTryKeyboard() }] };
    }

    if (callbackData === "settings_reset") {
      this.clearDangerConfirmations(state);
      state.pendingResetConfirmation = true;
      return {
        messages: [
          {
            text: RESET_CONFIRM_TEXT,
            keyboard: resetConfirmKeyboard(),
            replyKeyboard: mainReplyKeyboard()
          }
        ]
      };
    }

    if (callbackData === "summary_now") {
      state.pendingMode = null;
      this.clearDangerConfirmations(state);
      return {
        messages: [{ text: "📋 Собираю сводку текущей сессии..." }],
        llmTask: {
          mode: "SUMMARY",
          userText: "Сделай сводку текущей сессии."
        }
      };
    }

    if (callbackData === "settings_forget") {
      this.clearDangerConfirmations(state);
      state.pendingForgetConfirmation = true;
      return {
        messages: [{ text: FORGET_CONFIRM_TEXT, keyboard: forgetConfirmKeyboard(), replyKeyboard: mainReplyKeyboard() }]
      };
    }

    if (callbackData === "reset_confirm_yes") {
      if (!state.pendingResetConfirmation) {
        return { messages: [{ text: "Эта кнопка устарела. Выбери ещё раз." }] };
      }
      this.clearDangerConfirmations(state);
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

    if (callbackData === "reset_confirm_no") {
      if (!state.pendingResetConfirmation) {
        return { messages: [{ text: "Эта кнопка устарела. Выбери ещё раз." }] };
      }
      this.clearDangerConfirmations(state);
      return { messages: [{ text: "Ок, сессию не сбрасываю.", replyKeyboard: mainReplyKeyboard() }] };
    }

    if (callbackData === "forget_confirm_yes") {
      if (!state.pendingForgetConfirmation) {
        return { messages: [{ text: "Эта кнопка устарела. Выбери ещё раз." }] };
      }
      this.clearDangerConfirmations(state);
      return {
        messages: [{ text: "Ок, бот забудет всё, о чём вы говорили. Долгая память удалена.", replyKeyboard: mainReplyKeyboard() }],
        clearLongTerm: true
      };
    }

    if (callbackData === "forget_confirm_no") {
      if (!state.pendingForgetConfirmation) {
        return { messages: [{ text: "Эта кнопка устарела. Выбери ещё раз." }] };
      }
      this.clearDangerConfirmations(state);
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

  private handleText(text: string, state: UserSessionState, userId: string): {
    messages: OutgoingMessage[];
    llmTask?: LLMTask;
  } {
    const normalized = text.toLowerCase().trim();
    const quickAction = normalizeQuickActionText(text);
    const summarySelection =
      quickAction === "сводка" ||
      quickAction === "инна" ||
      quickAction === "итоги" ||
      quickAction.startsWith("сводка ") ||
      quickAction.startsWith("инна ");
    const composeSelection = quickAction === "сформулируй" || quickAction === "напиши за меня";
    const replySelection = quickAction === "ответь" || quickAction === "помоги ответить";
    const friendsSelection = quickAction === "друзья";
    const panelRequested = isPanelQuickAction(quickAction, normalized);

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

    if (friendsSelection) {
      return { messages: [{ text: "Выбери, кого позвать.", keyboard: friendsKeyboard(), replyKeyboard: mainReplyKeyboard() }] };
    }

    if (
      state.pendingMode === "awaiting_panel_input" &&
      panelRequested
    ) {
      return { messages: [{ text: "Я уже жду сообщение для всех друзей.", replyKeyboard: mainReplyKeyboard() }] };
    }

    if (state.pendingMode === "awaiting_compose_input" && composeSelection) {
      return { messages: [{ text: "Я уже жду сообщение для инструмента «Сформулируй».", replyKeyboard: mainReplyKeyboard() }] };
    }

    if (state.pendingMode === "awaiting_reply_input" && replySelection) {
      return { messages: [{ text: "Я уже жду входящее сообщение для инструмента «Ответь».", replyKeyboard: mainReplyKeyboard() }] };
    }

    if (state.pendingMode === "awaiting_compose_input" && replySelection) {
      state.pendingMode = "awaiting_reply_input";
      this.clearDangerConfirmations(state);
      if (state.currentPersona === null) {
        return { messages: [{ text: "💬 Сначала выбери друга, который будет помогать с ответом.", keyboard: startKeyboard(), replyKeyboard: mainReplyKeyboard() }] };
      }
      return { messages: [{ text: "💬 Переключил. Вставь входящее сообщение и, если нужно, что ты хочешь получить на выходе." }] };
    }

    if (state.pendingMode === "awaiting_reply_input" && composeSelection) {
      state.pendingMode = "awaiting_compose_input";
      this.clearDangerConfirmations(state);
      if (state.currentPersona === null) {
        return { messages: [{ text: "📝 Сначала выбери друга, который будет помогать формулировать.", keyboard: startKeyboard(), replyKeyboard: mainReplyKeyboard() }] };
      }
      return { messages: [{ text: "📝 Переключил. Напиши, что нужно сформулировать: ситуацию, адресата и желаемый тон." }] };
    }

    if ((state.pendingMode === "awaiting_compose_input" || state.pendingMode === "awaiting_reply_input") && summarySelection) {
      state.pendingMode = null;
      this.clearDangerConfirmations(state);
      return {
        messages: [{ text: "📋 Собираю сводку текущей сессии..." }],
        llmTask: {
          mode: "SUMMARY",
          userText: "Сделай сводку текущей сессии."
        }
      };
    }

    if ((state.pendingMode === "awaiting_compose_input" || state.pendingMode === "awaiting_reply_input") && panelRequested) {
      state.lastPersonaBeforePanel = state.currentPersona;
      state.pendingMode = "awaiting_panel_input";
      this.clearDangerConfirmations(state);
      return {
        messages: [{ text: "🤝 Переключил. Следующее сообщение разберём вместе. Опиши ситуацию одним сообщением.", replyKeyboard: mainReplyKeyboard() }]
      };
    }

    if (state.pendingMode === "awaiting_panel_input" && summarySelection) {
      state.pendingMode = null;
      this.clearDangerConfirmations(state);
      return {
        messages: [{ text: "📋 Собираю сводку текущей сессии..." }],
        llmTask: {
          mode: "SUMMARY",
          userText: "Сделай сводку текущей сессии."
        }
      };
    }

    if (state.pendingMode === "awaiting_panel_input" && composeSelection) {
      state.pendingMode = "awaiting_compose_input";
      this.clearDangerConfirmations(state);
      if (state.currentPersona === null) {
        return { messages: [{ text: "📝 Сначала выбери друга, который будет помогать формулировать.", keyboard: startKeyboard(), replyKeyboard: mainReplyKeyboard() }] };
      }
      return { messages: [{ text: "📝 Напиши, что нужно сформулировать: ситуацию, адресата и желаемый тон." }] };
    }

    if (state.pendingMode === "awaiting_panel_input" && replySelection) {
      state.pendingMode = "awaiting_reply_input";
      this.clearDangerConfirmations(state);
      if (state.currentPersona === null) {
        return { messages: [{ text: "💬 Сначала выбери друга, который будет помогать с ответом.", keyboard: startKeyboard(), replyKeyboard: mainReplyKeyboard() }] };
      }
      return { messages: [{ text: "💬 Вставь входящее сообщение и, если нужно, что ты хочешь получить на выходе." }] };
    }

    if (state.pendingMode === "awaiting_compose_input") {
      if (state.currentPersona === null) {
        return { messages: [{ text: "Сначала выбери друга.", keyboard: startKeyboard(), replyKeyboard: mainReplyKeyboard() }] };
      }
      state.pendingMode = null;
      this.clearDangerConfirmations(state);
      return {
        messages: [{ text: "📝 Собираю варианты формулировки..." }],
        llmTask: {
          mode: "SINGLE",
          persona: state.currentPersona,
          scenario: "compose",
          userText: text
        }
      };
    }

    if (state.pendingMode === "awaiting_reply_input") {
      if (state.currentPersona === null) {
        return { messages: [{ text: "Сначала выбери друга.", keyboard: startKeyboard(), replyKeyboard: mainReplyKeyboard() }] };
      }
      state.pendingMode = null;
      this.clearDangerConfirmations(state);
      return {
        messages: [{ text: "💬 Собираю варианты ответа..." }],
        llmTask: {
          mode: "SINGLE",
          persona: state.currentPersona,
          scenario: "reply",
          userText: text
        }
      };
    }

    if (state.pendingMode === "awaiting_panel_input") {
      state.pendingMode = null;
      this.clearDangerConfirmations(state);
      return {
        messages: [{ text: "Принял. Собираю разбор от всех друзей, это может занять до 20-30 секунд." }],
        llmTask: {
          mode: "PANEL",
          userText: text
        }
      };
    }

    if (panelRequested) {
      state.lastPersonaBeforePanel = state.currentPersona;
      state.pendingMode = "awaiting_panel_input";
      this.clearDangerConfirmations(state);
      return {
        messages: [
          {
            text: "🤝 Ок. Следующее сообщение разберём вместе. Опиши ситуацию одним сообщением.",
            replyKeyboard: mainReplyKeyboard()
          }
        ]
      };
    }

    if (summarySelection) {
      state.pendingMode = null;
      this.clearDangerConfirmations(state);
      return {
        messages: [{ text: "📋 Собираю сводку текущей сессии..." }],
        llmTask: {
          mode: "SUMMARY",
          userText: "Сделай сводку текущей сессии."
        }
      };
    }

    if (composeSelection) {
      state.pendingMode = "awaiting_compose_input";
      this.clearDangerConfirmations(state);
      if (state.currentPersona === null) {
        return { messages: [{ text: "📝 Сначала выбери друга, который будет помогать формулировать.", keyboard: startKeyboard(), replyKeyboard: mainReplyKeyboard() }] };
      }
      return { messages: [{ text: "📝 Напиши, что нужно сформулировать: ситуацию, адресата и желаемый тон." }] };
    }

    if (replySelection) {
      state.pendingMode = "awaiting_reply_input";
      this.clearDangerConfirmations(state);
      if (state.currentPersona === null) {
        return { messages: [{ text: "💬 Сначала выбери друга, который будет помогать с ответом.", keyboard: startKeyboard(), replyKeyboard: mainReplyKeyboard() }] };
      }
      return { messages: [{ text: "💬 Вставь входящее сообщение и, если нужно, что ты хочешь получить на выходе." }] };
    }

    const safetyClass = maybeSoftSafety(normalized);
    if (safetyClass === "soft") {
      state.pendingSafetyCheck = true;
      state.pendingUserText = text;
      this.analytics?.emitEvent({
        event: "safety_triggered",
        userId,
        sessionId: state.sessionId
      });
      const safety = getSafetyCheck();
      return { messages: [{ text: safety.text, keyboard: safetyKeyboard() }] };
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
        scenario: null,
        userText: text
      }
    };
  }

  private selectPersona(state: UserSessionState, persona: Persona): OutgoingMessage[] {
    const previousPendingMode = state.pendingMode;
    const wasPanelPending = previousPendingMode === "awaiting_panel_input";
    const wasComposePending = previousPendingMode === "awaiting_compose_input";
    const wasReplyPending = previousPendingMode === "awaiting_reply_input";
    state.pendingMode = wasComposePending || wasReplyPending ? previousPendingMode : null;
    this.clearDangerConfirmations(state);
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

    if (wasComposePending) {
      return [
        {
          text: `Сейчас с тобой ${personaLabel(persona)}. Напиши, что нужно сформулировать: ситуацию, адресата и желаемый тон.`,
          replyKeyboard: mainReplyKeyboard()
        }
      ];
    }

    if (wasReplyPending) {
      return [
        {
          text: `Сейчас с тобой ${personaLabel(persona)}. Вставь входящее сообщение и желаемый результат ответа.`,
          replyKeyboard: mainReplyKeyboard()
        }
      ];
    }

    return [{ text: `Сейчас с тобой ${personaLabel(persona)}.`, replyKeyboard: mainReplyKeyboard() }];
  }

  private clearDangerConfirmations(state: UserSessionState): void {
    state.pendingForgetConfirmation = false;
    state.pendingResetConfirmation = false;
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

function isPanelQuickAction(quickAction: string, normalized: string): boolean {
  return (
    quickAction === "все взгляды" ||
    quickAction === "все сразу" ||
    quickAction === "совет всех" ||
    quickAction === "позвать всех" ||
    quickAction === "спросить всех" ||
    normalized === "все взгляды" ||
    normalized === "все сразу" ||
    normalized === "совет всех" ||
    normalized === "позвать всех" ||
    normalized === "спросить всех"
  );
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

function formatStatsMessage(
  stats: {
    todayDate: string;
    today: {
      starts: number;
      askAll: number;
      toolWrite: number;
      toolReply: number;
      toolSummary: number;
      shareClicked: number;
      modelError: number;
      safetyTriggered: number;
    };
    sevenDays: {
      starts: number;
      askAll: number;
      shareClicked: number;
    };
  },
  invitedUsersTotal: number
): string {
  const activationToday = formatRatio(stats.today.askAll, stats.today.starts);
  const shareToday = formatRatio(stats.today.shareClicked, stats.today.askAll);
  const activation7d = formatRatio(stats.sevenDays.askAll, stats.sevenDays.starts);
  const share7d = formatRatio(stats.sevenDays.shareClicked, stats.sevenDays.askAll);

  return (
    "📊 Статистика\n\n" +
    `Сегодня (${stats.todayDate}):\n` +
    `• starts: ${stats.today.starts}\n` +
    `• ask_all: ${stats.today.askAll}\n` +
    `• tools: write ${stats.today.toolWrite} / reply ${stats.today.toolReply} / summary ${stats.today.toolSummary}\n` +
    `• share_clicked: ${stats.today.shareClicked}\n` +
    `• model_error: ${stats.today.modelError}\n` +
    `• safety_triggered: ${stats.today.safetyTriggered}\n\n` +
    "7 дней:\n" +
    `• starts: ${stats.sevenDays.starts}\n` +
    `• ask_all: ${stats.sevenDays.askAll}\n` +
    `• share_clicked: ${stats.sevenDays.shareClicked}\n\n` +
    "Конверсии:\n" +
    `• activation today: ${activationToday} (ask_all/starts)\n` +
    `• share rate today: ${shareToday} (share/ask_all)\n` +
    `• activation 7d: ${activation7d}\n` +
    `• share rate 7d: ${share7d}\n\n` +
    "Рефералы:\n" +
    `• всего приглашённых: ${invitedUsersTotal}`
  );
}

function formatRatio(numerator: number, denominator: number): string {
  if (denominator <= 0) {
    return "—";
  }
  return `${((numerator / denominator) * 100).toFixed(1)}%`;
}
