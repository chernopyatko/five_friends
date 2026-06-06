import { randomUUID } from "node:crypto";

import {
  balanceInfoKeyboard,
  coldStartChatKeyboard,
  coldStartKeyboard,
  coldStartMessageKeyboard,
  conversationInputKeyboard,
  demoTryKeyboard,
  forgetConfirmKeyboard,
  friendsKeyboard,
  mainReplyKeyboard,
  resetConfirmKeyboard,
  safetyHoldKeyboard,
  safetyKeyboard,
  settingsKeyboard,
  settingsKeyboardWithReminders,
  startKeyboard,
  type InlineKeyboard,
  type ReplyKeyboard
} from "./keyboard.js";
import { CRISIS_RESUME_TEXT, getCrisisResponder, getHelpDiscovery, getSafetyCheck, type HelpCountryCode } from "../security/safety.js";
import { buildShareLink, formatShareLinkMessage } from "../growth/share.js";
import { parseStartPayload } from "../growth/sourceAttribution.js";
import type { ReferralService } from "../growth/referral.js";
import type { BalanceStore } from "../billing/balanceStore.js";
import type { BillingConfig } from "../billing/config.js";
import { createInitialSessionState, type ConversationPartSource, type PanelScenario, type Persona, type UserSessionState } from "../state/session.js";
import type { AnalyticsService } from "../observability/analytics.js";
import type { BotMode, ToolScenario } from "../llm/schemas.js";

const RATE_LIMIT_WINDOW_MS = 2000;
const RATE_LIMIT_MAX_MESSAGES = 5;
const MAX_CONVERSATION_PARTS = 20;
const MAX_CONVERSATION_CHARS = 24_000;
const COLD_START_TEXT =
  "Привет. Круг друзей — это 4 ИИ-друга для сложных переписок, конфликтов и решений.\n\n" +
  "Скинь ситуацию, пересланные сообщения, войс до 10 минут или скрин. Если фрагментов несколько — кидай подряд и нажми «Готово».\n\n" +
  "Что получишь:\n" +
  "🧠 Ян — разложит факты и даст шаги.\n" +
  "❤️ Наташа — поможет понять чувства без осуждения.\n" +
  "🌀 Аня — поможет понять, что для тебя важно.\n" +
  "🎯 Макс — вернёт к реальности и скажет прямо.\n\n" +
  "Первый раз можешь просто кинуть переписку — разберут все четверо.";
const HELP_TEXT =
  "❓ Как тут всё устроено\n" +
  "Здесь живут 4 ИИ-друга. Ты выбираешь друга и пишешь как обычно.\n\n" +
  "📥 Что можно прислать\n" +
  "Текст, пересланные сообщения, войсы до 10 минут и скрины переписки.\n" +
  "Если фрагментов несколько — отправь их подряд, потом нажми «Готово». Бот ответит один раз по всей переписке.\n\n" +
  "🧰 Инструменты\n" +
  "📝 Напиши за меня — опиши ситуацию, и мы сформулируем сообщение кому угодно.\n" +
  "💬 Помоги ответить — перешли сложное сообщение, подскажем что ответить.\n" +
  "📋 Итоги — соберёт сводку вашего разговора.\n\n" +
  "🚀 Спросить всех\n" +
  "Нажми 🚀 Спросить всех → скинь переписку → нажми «Готово». Разберут все четверо.\n" +
  "💡 Один друг = 1 сообщение, «Спросить всех» = 3 сообщения.\n\n" +
  "👥 Кто отвечает\n" +
  "🧠 Ян — разложит по полочкам и даст план\n" +
  "❤️ Наташа — поддержит и назовёт чувства\n" +
  "🌀 Аня — поможет понять, что для тебя важно\n" +
  "🎯 Макс — пошутит, вернёт на землю и отделит факты от эмоций\n\n" +
  "⸻\n\n" +
  "Если ты написал без выбора\n" +
  "Ничего страшного: бот спросит \"кого позвать?\" — выберешь, и он ответит.\n\n" +
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
  inputSource?: ConversationPartSource;
  isForwarded?: boolean;
  command?: "/start" | "/help" | "/friends" | "/reset" | "/privacy" | "/forget" | "/settings" | "/demo" | "/stats" | "/balance";
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
  analyticsContext?: {
    askAllOrigin?: AskAllOrigin;
  };
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
  forceFree?: boolean;
}

export type AskAllOrigin = "auto_cs_situation" | "manual";

interface FirstPanelStateStore {
  hasSeenFirstPanel(userId: string): boolean;
}

export class UXHandlers {
  private readonly states = new Map<string, UserSessionState>();
  private readonly referrals?: ReferralService;
  private readonly analytics?: AnalyticsService;
  private readonly adminUserIds: Set<string>;
  private readonly bypassBalanceUserIds: Set<string>;
  private readonly balanceStore?: BalanceStore;
  private readonly billingConfig?: BillingConfig;
  private readonly botUsername?: string;
  private readonly firstPanelStateStore?: FirstPanelStateStore;

  constructor(input?: {
    referrals?: ReferralService;
    analytics?: AnalyticsService;
    firstPanelStateStore?: FirstPanelStateStore;
    adminUserIds?: Iterable<string>;
    bypassBalanceUserIds?: Iterable<string>;
    balanceStore?: BalanceStore;
    billingConfig?: BillingConfig;
    botUsername?: string;
  }) {
    this.referrals = input?.referrals;
    this.analytics = input?.analytics;
    this.firstPanelStateStore = input?.firstPanelStateStore;
    this.botUsername = input?.botUsername;
    this.balanceStore = input?.balanceStore;
    this.billingConfig = input?.billingConfig;
    this.adminUserIds = new Set(
      input?.adminUserIds ??
        (process.env.ADMIN_USER_IDS ?? "")
          .split(",")
          .map((id) => id.trim())
          .filter((id) => id.length > 0)
    );
    this.bypassBalanceUserIds = new Set(input?.bypassBalanceUserIds ?? []);
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

    if (!shouldBypassRateLimit(event, state) && isRateLimited(state, now)) {
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
        analyticsContext: commandResult.analyticsContext,
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
        analyticsContext: callbackResult.analyticsContext,
        sessionReset: callbackResult.sessionReset,
        clearLongTerm: callbackResult.clearLongTerm
      };
    }

    if (event.text !== undefined) {
      const messages = this.handleText(event.text, state, event.userId, event.inputSource ?? "text", event.isForwarded === true);
      state.lastActivityTs = now;
      return {
        messages: messages.messages,
        state,
        llmTask: messages.llmTask,
        analyticsContext: messages.analyticsContext
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
    analyticsContext?: {
      askAllOrigin?: AskAllOrigin;
    };
    clearLongTerm?: boolean;
    sessionReset?: {
      previousSessionId: string;
    };
  } {
    switch (command) {
      case "/start": {
        const attribution = parseStartPayload(commandPayload);
        const referralResult = this.referrals?.applyStartPayload(userId, commandPayload);
        this.referrals?.setUserSource(userId, attribution.source, attribution.campaign);
        this.analytics?.emitEvent({
          event: "start",
          userId,
          sessionId: state.sessionId,
          extra: {
            has_ref_code: Boolean(commandPayload?.trim().startsWith("ref_")),
            referral_attributed: referralResult?.attributed ?? false,
            source: attribution.source ?? "organic",
            ...(attribution.campaign != null ? { campaign: attribution.campaign } : {})
          }
        });
        this.enterPanelInput(state, userId, null);
        state.pendingUserText = null;
        return {
          messages: [
            {
              text: COLD_START_TEXT,
              keyboard: coldStartKeyboard(),
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
          messages: [{ text: SETTINGS_TEXT, keyboard: this.getSettingsKeyboard(userId), replyKeyboard: mainReplyKeyboard() }]
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
        const sourceBreakdown = this.referrals?.getSourceBreakdown() ?? [];
        return {
          messages: [
            {
              text: formatStatsMessage(stats, invited, sourceBreakdown)
            }
          ]
        };
      }
      case "/balance": {
        if (this.bypassBalanceUserIds.has(userId)) {
          return {
            messages: [{ text: "💬 У тебя безлимитный доступ ♾️" }]
          };
        }
        if (!this.billingConfig?.isConfigured || !this.balanceStore) {
          return {
            messages: [{ text: "💬 Сейчас все разговоры бесплатны." }]
          };
        }
        this.balanceStore.ensureBalance(userId);
        const info = this.balanceStore.getBalanceInfo(userId);
        return {
          messages: [{
            text:
              `💬 Баланс: ${info.balance} сообщений\n` +
              `📊 Использовано: ${info.totalSpent} сообщений\n\n` +
              "Пополнить:",
            keyboard: balanceInfoKeyboard(this.billingConfig.tributeLinks)
          }]
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
    analyticsContext?: {
      askAllOrigin?: AskAllOrigin;
    };
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

    if (callbackData === "conversation_done") {
      return this.finishPendingConversation(state);
    }

    if (callbackData === "conversation_cancel") {
      this.clearPendingConversation(state);
      state.pendingUserText = null;
      state.pendingMode = null;
      state.pendingPanelScenario = null;
      state.pendingAutoPanelFromColdStart = false;
      return { messages: [{ text: "Ок, очистил переписку. Продолжаем.", replyKeyboard: mainReplyKeyboard() }] };
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
      const pendingText = this.consumePendingConversation(state) ?? state.pendingUserText;
      const messages = this.selectPersona(state, persona);
      if (pendingText) {
        return {
          messages,
          llmTask: {
            mode: "SINGLE",
            persona,
            scenario: null,
            userText: pendingText
          }
        };
      }
      return { messages };
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

    if (callbackData === "cs_help_start") {
      this.analytics?.emitEvent({
        event: "cold_start_click",
        userId,
        sessionId: state.sessionId,
        extra: { entry: "help_start" }
      });
      this.enterPanelInput(state, userId, null);
      this.clearDangerConfirmations(state);
      return {
        messages: [{
          text: "🌀 Аня: Что случилось? Можно коротко, можно длинно — как удобно.",
          replyKeyboard: mainReplyKeyboard()
        }]
      };
    }

    if (callbackData === "cs_situation") {
      this.analytics?.emitEvent({
        event: "cold_start_click",
        userId,
        sessionId: state.sessionId,
        extra: { entry: "situation" }
      });
      this.enterPanelInput(state, userId, null);
      this.clearDangerConfirmations(state);
      return {
        messages: [{
          text: "Расскажи что случилось — 4 друга разберут с разных сторон:\n\n" +
            "🧠 Ян — разложит по полочкам и даст план\n" +
            "❤️ Наташа — поддержит и назовёт чувства\n" +
            "🌀 Аня — поможет понять, что для тебя важно\n" +
            "🎯 Макс — скажет как есть и отделит факты от эмоций\n\n" +
            "Кидай ситуацию, переписку, войс или скрин. Когда всё — нажми «Готово».",
          replyKeyboard: mainReplyKeyboard()
        }]
      };
    }

    if (callbackData === "cs_message") {
      state.pendingAutoPanelFromColdStart = false;
      this.analytics?.emitEvent({
        event: "cold_start_click",
        userId,
        sessionId: state.sessionId,
        extra: { entry: "message" }
      });
      return {
        messages: [{
          text: "Что нужно?",
          keyboard: coldStartMessageKeyboard(),
          replyKeyboard: mainReplyKeyboard()
        }]
      };
    }

    if (callbackData === "cs_compose") {
      this.analytics?.emitEvent({
        event: "cold_start_click",
        userId,
        sessionId: state.sessionId,
        extra: { entry: "compose" }
      });
      this.enterPanelInput(state, userId, "compose");
      this.clearDangerConfirmations(state);
      return {
        messages: [{
          text: "📝 Опиши, кому и что нужно написать. Если есть переписка, войсы или скрины — кидай их следом. Когда всё — нажми «Готово».",
          replyKeyboard: mainReplyKeyboard()
        }]
      };
    }

    if (callbackData === "cs_reply") {
      this.analytics?.emitEvent({
        event: "cold_start_click",
        userId,
        sessionId: state.sessionId,
        extra: { entry: "reply" }
      });
      this.enterPanelInput(state, userId, "reply");
      this.clearDangerConfirmations(state);
      return {
        messages: [{
          text: "💬 Вставь сообщение, на которое нужно ответить. Если важен контекст, войсы или скрины — кидай их следом. Когда всё — нажми «Готово».",
          replyKeyboard: mainReplyKeyboard()
        }]
      };
    }

    if (callbackData === "cs_chat") {
      state.pendingAutoPanelFromColdStart = false;
      this.analytics?.emitEvent({
        event: "cold_start_click",
        userId,
        sessionId: state.sessionId,
        extra: { entry: "chat" }
      });
      return {
        messages: [{
          text: "С кем хочешь поговорить?",
          keyboard: coldStartChatKeyboard(),
          replyKeyboard: mainReplyKeyboard()
        }]
      };
    }

    if (callbackData.startsWith("cs_chat_")) {
      const persona = callbackData.replace("cs_chat_", "") as Persona;
      if (!["yan", "natasha", "anya", "max"].includes(persona)) {
        return { messages: [{ text: "Не понял выбор. Попробуй ещё раз." }] };
      }
      state.currentPersona = persona;
      state.pendingMode = null;
      state.pendingPanelScenario = null;
      state.pendingAutoPanelFromColdStart = false;
      this.clearDangerConfirmations(state);
      this.analytics?.emitEvent({
        event: "choose_persona",
        userId,
        sessionId: state.sessionId
      });
      return {
        messages: [{ text: `Сейчас с тобой ${personaLabel(persona)}.`, replyKeyboard: mainReplyKeyboard() }],
        llmTask: {
          mode: "SINGLE",
          persona,
          scenario: null,
          userText:
            "Пользователь только что пришёл и выбрал тебя, чтобы просто поболтать. Поздоровайся в своём стиле и предложи тему или задай лёгкий вопрос. Не спрашивай 'о чём хочешь поговорить' — предложи сам.",
          forceFree: true
        }
      };
    }

    if (callbackData === "panel_start") {
      const pendingConversation = this.consumePendingConversation(state);
      if (pendingConversation || state.pendingUserText) {
        const pending = pendingConversation ?? state.pendingUserText ?? "";
        state.pendingUserText = null;
        state.pendingMode = null;
        state.pendingPanelScenario = null;
        state.pendingAutoPanelFromColdStart = false;
        this.clearDangerConfirmations(state);
        return {
          messages: [{ text: "🤝 Разберём вместе.", replyKeyboard: mainReplyKeyboard() }],
          llmTask: {
            mode: "PANEL",
            scenario: null,
            userText: pending
          },
          analyticsContext: {
            askAllOrigin: "manual"
          }
        };
      }
      if (state.pendingMode === "awaiting_panel_input") {
        if (state.pendingPanelScenario === "compose") {
          return { messages: [{ text: "Я уже жду сообщение для «Напиши за меня + Спросить всех».", replyKeyboard: mainReplyKeyboard() }] };
        }
        if (state.pendingPanelScenario === "reply") {
          return { messages: [{ text: "Я уже жду сообщение для «Помоги ответить + Спросить всех».", replyKeyboard: mainReplyKeyboard() }] };
        }
        return { messages: [{ text: "Я уже жду сообщение для всех друзей.", replyKeyboard: mainReplyKeyboard() }] };
      }
      state.lastPersonaBeforePanel = state.currentPersona;
      if (state.pendingMode === "awaiting_compose_input") {
        state.pendingPanelScenario = "compose";
      } else if (state.pendingMode === "awaiting_reply_input") {
        state.pendingPanelScenario = "reply";
      } else {
        state.pendingPanelScenario = null;
      }
      state.pendingMode = "awaiting_panel_input";
      state.pendingAutoPanelFromColdStart = false;
      this.clearDangerConfirmations(state);
      if (state.pendingPanelScenario === "compose") {
        return {
          messages: [{ text: "🤝 Переключил. Кидай переписку, войсы или скрины. Когда всё — нажми «Готово». Разберём всеми друзьями в формате «Напиши за меня».", replyKeyboard: mainReplyKeyboard() }]
        };
      }
      if (state.pendingPanelScenario === "reply") {
        return {
          messages: [{ text: "🤝 Переключил. Кидай переписку, войсы или скрины. Когда всё — нажми «Готово». Разберём всеми друзьями в формате «Помоги ответить».", replyKeyboard: mainReplyKeyboard() }]
        };
      }
      return {
        messages: [{ text: "🤝 Ок. Кидай ситуацию, переписку, войс или скрин. Когда всё — нажми «Готово».", replyKeyboard: mainReplyKeyboard() }]
      };
    }

    if (callbackData === "panel_cancel") {
      state.pendingMode = null;
      state.pendingPanelScenario = null;
      state.pendingAutoPanelFromColdStart = false;
      return { messages: [{ text: "Отменил режим 🤝. Продолжаем.", replyKeyboard: mainReplyKeyboard() }] };
    }

    if (callbackData === "friends_info") {
      state.pendingMode = null;
      state.pendingPanelScenario = null;
      state.pendingAutoPanelFromColdStart = false;
      return { messages: [{ text: "Выбери, кого позвать.", keyboard: friendsKeyboard(), replyKeyboard: mainReplyKeyboard() }] };
    }

    if (callbackData === "settings_privacy") {
      return { messages: [{ text: PRIVACY_TEXT, replyKeyboard: mainReplyKeyboard() }] };
    }

    if (callbackData === "settings_demo") {
      return { messages: [{ text: DEMO_TEXT, keyboard: demoTryKeyboard() }] };
    }

    if (callbackData === "settings_toggle_reminders") {
      if (!this.balanceStore) {
        return { messages: [{ text: "Настройка недоступна.", replyKeyboard: mainReplyKeyboard() }] };
      }

      const current = this.balanceStore.getRemindersEnabled(userId);
      const next = !current;
      this.balanceStore.setRemindersEnabled(userId, next);

      return {
        messages: [{
          text: next ? "🔔 Напоминания включены." : "🔕 Напоминания отключены.",
          keyboard: settingsKeyboardWithReminders(next),
          replyKeyboard: mainReplyKeyboard()
        }]
      };
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
      state.pendingPanelScenario = null;
      state.pendingAutoPanelFromColdStart = false;
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

  private handleText(text: string, state: UserSessionState, userId: string, source: ConversationPartSource, isForwarded: boolean): {
    messages: OutgoingMessage[];
    llmTask?: LLMTask;
    analyticsContext?: {
      askAllOrigin?: AskAllOrigin;
    };
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
      const pendingText = this.consumePendingConversation(state) ?? state.pendingUserText;
      const messages = this.selectPersona(state, quickPersona);
      if (pendingText) {
        return {
          messages,
          llmTask: {
            mode: "SINGLE",
            persona: quickPersona,
            scenario: null,
            userText: pendingText
          }
        };
      }
      return { messages };
    }

    if (state.pendingConversationParts.length > 0 && isConversationDoneQuickAction(quickAction)) {
      return this.finishPendingConversation(state);
    }

    if (state.pendingConversationParts.length > 0 && isConversationCancelQuickAction(quickAction)) {
      this.clearPendingConversation(state);
      state.pendingUserText = null;
      state.pendingMode = null;
      state.pendingPanelScenario = null;
      state.pendingAutoPanelFromColdStart = false;
      return { messages: [{ text: "Ок, очистил переписку. Продолжаем.", replyKeyboard: mainReplyKeyboard() }] };
    }

    if (
      state.pendingConversationParts.length > 0 &&
      (summarySelection || composeSelection || replySelection || friendsSelection || panelRequested)
    ) {
      return {
        messages: [{
          text: "Сначала закончи переписку: нажми «Готово» или «Отмена».",
          keyboard: conversationInputKeyboard(),
          replyKeyboard: mainReplyKeyboard()
        }]
      };
    }

    if (quickAction === "помощь") {
      return { messages: [{ text: HELP_TEXT, replyKeyboard: mainReplyKeyboard() }] };
    }

    if (quickAction === "премиум") {
      if (this.bypassBalanceUserIds.has(userId)) {
        return { messages: [{ text: "💬 У тебя безлимитный доступ ♾️", replyKeyboard: mainReplyKeyboard() }] };
      }
      if (!this.billingConfig?.isConfigured || !this.balanceStore) {
        return { messages: [{ text: "💬 Сейчас все разговоры бесплатны.", replyKeyboard: mainReplyKeyboard() }] };
      }
      this.balanceStore.ensureBalance(userId);
      const premiumInfo = this.balanceStore.getBalanceInfo(userId);
      return {
        messages: [{
          text:
            `💬 Баланс: ${premiumInfo.balance} сообщений\n` +
            `📊 Использовано: ${premiumInfo.totalSpent} сообщений\n` +
            `💡 Один друг = 1 сообщение, «Спросить всех» = 3\n\n` +
            "📦 50 сообщений — 299₽\n" +
            "📦 150 сообщений — 599₽\n" +
            "📦 350 сообщений — 999₽",
          keyboard: balanceInfoKeyboard(this.billingConfig.tributeLinks),
          replyKeyboard: mainReplyKeyboard()
        }]
      };
    }

    if (quickAction === "настройки") {
      return { messages: [{ text: SETTINGS_TEXT, keyboard: this.getSettingsKeyboard(userId), replyKeyboard: mainReplyKeyboard() }] };
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
      if (state.pendingPanelScenario === "compose") {
        return { messages: [{ text: "Я уже жду сообщение для «Напиши за меня + Спросить всех».", replyKeyboard: mainReplyKeyboard() }] };
      }
      if (state.pendingPanelScenario === "reply") {
        return { messages: [{ text: "Я уже жду сообщение для «Помоги ответить + Спросить всех».", replyKeyboard: mainReplyKeyboard() }] };
      }
      return { messages: [{ text: "Я уже жду сообщение для всех друзей.", replyKeyboard: mainReplyKeyboard() }] };
    }

    if (state.pendingMode === "awaiting_compose_input" && composeSelection) {
      return { messages: [{ text: "Я уже жду сообщение для инструмента «Сформулируй».", replyKeyboard: mainReplyKeyboard() }] };
    }

    if (state.pendingMode === "awaiting_reply_input" && replySelection) {
      return { messages: [{ text: "Я уже жду входящее сообщение для инструмента «Ответь».", replyKeyboard: mainReplyKeyboard() }] };
    }

    if (state.pendingMode === "awaiting_compose_input" && replySelection) {
      if (state.currentPersona === null) {
        this.enterPanelInput(state, userId, "reply");
        this.clearDangerConfirmations(state);
        return { messages: [{ text: "💬 Вставь сообщение, на которое нужно ответить. Если важен контекст, войсы или скрины — кидай их следом. Когда всё — нажми «Готово».", replyKeyboard: mainReplyKeyboard() }] };
      }
      state.pendingMode = "awaiting_reply_input";
      this.clearDangerConfirmations(state);
      return { messages: [{ text: "💬 Переключил. Вставь входящее сообщение и, если нужно, что ты хочешь получить на выходе." }] };
    }

    if (state.pendingMode === "awaiting_reply_input" && composeSelection) {
      if (state.currentPersona === null) {
        this.enterPanelInput(state, userId, "compose");
        this.clearDangerConfirmations(state);
        return { messages: [{ text: "📝 Опиши, кому и что нужно написать. Если есть переписка, войсы или скрины — кидай их следом. Когда всё — нажми «Готово».", replyKeyboard: mainReplyKeyboard() }] };
      }
      state.pendingMode = "awaiting_compose_input";
      this.clearDangerConfirmations(state);
      return { messages: [{ text: "📝 Переключил. Напиши, что нужно сформулировать: ситуацию, адресата и желаемый тон." }] };
    }

    if ((state.pendingMode === "awaiting_compose_input" || state.pendingMode === "awaiting_reply_input") && summarySelection) {
      state.pendingMode = null;
      state.pendingPanelScenario = null;
      state.pendingAutoPanelFromColdStart = false;
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
      state.pendingPanelScenario = state.pendingMode === "awaiting_compose_input" ? "compose" : "reply";
      state.pendingMode = "awaiting_panel_input";
      state.pendingAutoPanelFromColdStart = false;
      this.clearDangerConfirmations(state);
      if (state.pendingPanelScenario === "compose") {
        return {
          messages: [{ text: "🤝 Переключил. Кидай переписку, войсы или скрины. Когда всё — нажми «Готово». Разберём всеми друзьями в формате «Напиши за меня».", replyKeyboard: mainReplyKeyboard() }]
        };
      }
      return {
        messages: [{ text: "🤝 Переключил. Кидай переписку, войсы или скрины. Когда всё — нажми «Готово». Разберём всеми друзьями в формате «Помоги ответить».", replyKeyboard: mainReplyKeyboard() }]
      };
    }

    if (state.pendingMode === "awaiting_panel_input" && summarySelection) {
      state.pendingMode = null;
      state.pendingPanelScenario = null;
      state.pendingAutoPanelFromColdStart = false;
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
      if (state.currentPersona === null) {
        this.enterPanelInput(state, userId, "compose");
        this.clearDangerConfirmations(state);
        return { messages: [{ text: "📝 Опиши, кому и что нужно написать. Если есть переписка, войсы или скрины — кидай их следом. Когда всё — нажми «Готово».", replyKeyboard: mainReplyKeyboard() }] };
      }
      state.pendingMode = "awaiting_compose_input";
      state.pendingPanelScenario = null;
      state.pendingAutoPanelFromColdStart = false;
      this.clearDangerConfirmations(state);
      return { messages: [{ text: "📝 Напиши, что нужно сформулировать: ситуацию, адресата и желаемый тон." }] };
    }

    if (state.pendingMode === "awaiting_panel_input" && replySelection) {
      if (state.currentPersona === null) {
        this.enterPanelInput(state, userId, "reply");
        this.clearDangerConfirmations(state);
        return { messages: [{ text: "💬 Вставь сообщение, на которое нужно ответить. Если важен контекст, войсы или скрины — кидай их следом. Когда всё — нажми «Готово».", replyKeyboard: mainReplyKeyboard() }] };
      }
      state.pendingMode = "awaiting_reply_input";
      state.pendingPanelScenario = null;
      state.pendingAutoPanelFromColdStart = false;
      this.clearDangerConfirmations(state);
      return { messages: [{ text: "💬 Вставь входящее сообщение и, если нужно, что ты хочешь получить на выходе." }] };
    }

    if (state.pendingMode === "awaiting_compose_input") {
      if (state.currentPersona === null) {
        return { messages: [{ text: "Сначала выбери друга.", keyboard: startKeyboard(), replyKeyboard: mainReplyKeyboard() }] };
      }
      return this.appendPendingConversationPart(state, text, source);
    }

    if (state.pendingMode === "awaiting_reply_input") {
      if (state.currentPersona === null) {
        return { messages: [{ text: "Сначала выбери друга.", keyboard: startKeyboard(), replyKeyboard: mainReplyKeyboard() }] };
      }
      return this.appendPendingConversationPart(state, text, source);
    }

    if (state.pendingMode === "awaiting_panel_input") {
      return this.appendPendingConversationPart(state, text, source);
    }

    if (panelRequested) {
      state.lastPersonaBeforePanel = state.currentPersona;
      state.pendingMode = "awaiting_panel_input";
      state.pendingPanelScenario = null;
      state.pendingAutoPanelFromColdStart = false;
      this.clearDangerConfirmations(state);
      return {
        messages: [
          {
            text: "🤝 Ок. Кидай ситуацию, переписку, войс или скрин. Когда всё — нажми «Готово».",
            replyKeyboard: mainReplyKeyboard()
          }
        ]
      };
    }

    if (summarySelection) {
      state.pendingMode = null;
      state.pendingPanelScenario = null;
      state.pendingAutoPanelFromColdStart = false;
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
      if (state.currentPersona === null) {
        this.enterPanelInput(state, userId, "compose");
        this.clearDangerConfirmations(state);
        return { messages: [{ text: "📝 Опиши, кому и что нужно написать. Если есть переписка, войсы или скрины — кидай их следом. Когда всё — нажми «Готово».", replyKeyboard: mainReplyKeyboard() }] };
      }
      state.pendingMode = "awaiting_compose_input";
      state.pendingPanelScenario = null;
      state.pendingAutoPanelFromColdStart = false;
      this.clearDangerConfirmations(state);
      return { messages: [{ text: "📝 Напиши, что нужно сформулировать: ситуацию, адресата и желаемый тон." }] };
    }

    if (replySelection) {
      if (state.currentPersona === null) {
        this.enterPanelInput(state, userId, "reply");
        this.clearDangerConfirmations(state);
        return { messages: [{ text: "💬 Вставь сообщение, на которое нужно ответить. Если важен контекст, войсы или скрины — кидай их следом. Когда всё — нажми «Готово».", replyKeyboard: mainReplyKeyboard() }] };
      }
      state.pendingMode = "awaiting_reply_input";
      state.pendingPanelScenario = null;
      state.pendingAutoPanelFromColdStart = false;
      this.clearDangerConfirmations(state);
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
      return this.appendPendingConversationPart(state, text, source);
    }

    if (isForwarded || source === "screenshot") {
      return this.appendPendingConversationPart(state, text, source);
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
    state.pendingPanelScenario = null;
    state.pendingAutoPanelFromColdStart = false;
    this.clearDangerConfirmations(state);
    state.currentPersona = persona;

    if (state.pendingUserText) {
      state.pendingUserText = null;
      return [
        { text: `Сейчас с тобой ${personaLabel(persona)}.`, replyKeyboard: mainReplyKeyboard() }
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

  private appendPendingConversationPart(
    state: UserSessionState,
    text: string,
    source: ConversationPartSource
  ): {
    messages: OutgoingMessage[];
  } {
    const cleaned = text.trim();
    if (cleaned.length === 0) {
      return {
        messages: [{
          text: "Пустой фрагмент не добавил. Кидай текст, войс или скрин.",
          keyboard: conversationInputKeyboard(),
          replyKeyboard: mainReplyKeyboard()
        }]
      };
    }
    if (state.pendingConversationParts.length >= MAX_CONVERSATION_PARTS) {
      return {
        messages: [{
          text: `Уже ${MAX_CONVERSATION_PARTS} фрагментов. Нажми «Готово» или «Отмена».`,
          keyboard: conversationInputKeyboard(),
          replyKeyboard: mainReplyKeyboard()
        }]
      };
    }

    const nextParts = [...state.pendingConversationParts, { source, text: cleaned }];
    if (formatConversationParts(nextParts).length > MAX_CONVERSATION_CHARS) {
      return {
        messages: [{
          text: "Текста уже много. Нажми «Готово» — разберём то, что есть.",
          keyboard: conversationInputKeyboard(),
          replyKeyboard: mainReplyKeyboard()
        }]
      };
    }

    state.pendingConversationParts = nextParts;
    this.clearDangerConfirmations(state);

    return {
      messages: [{
        text: formatConversationPartAck(state.pendingConversationParts.length),
        keyboard: conversationInputKeyboard(),
        replyKeyboard: mainReplyKeyboard()
      }]
    };
  }

  private finishPendingConversation(state: UserSessionState): {
    messages: OutgoingMessage[];
    llmTask?: LLMTask;
    analyticsContext?: {
      askAllOrigin?: AskAllOrigin;
    };
  } {
    const userText = this.consumePendingConversation(state);
    if (!userText) {
      return {
        messages: [{
          text: "Пока нечего разбирать. Кинь текст, войс или скрин.",
          replyKeyboard: mainReplyKeyboard()
        }]
      };
    }

    if (state.pendingMode === "awaiting_panel_input") {
      const panelScenario = state.pendingPanelScenario;
      const askAllOrigin: AskAllOrigin = state.pendingAutoPanelFromColdStart ? "auto_cs_situation" : "manual";
      const forceFree = state.pendingAutoPanelFromColdStart;
      state.pendingMode = null;
      state.pendingPanelScenario = null;
      state.pendingAutoPanelFromColdStart = false;
      this.clearDangerConfirmations(state);
      const panelIntro =
        panelScenario === "compose"
          ? "📝 Принял переписку. Собираю варианты формулировки от всех друзей, это может занять до 20-30 секунд."
          : panelScenario === "reply"
            ? "💬 Принял переписку. Собираю варианты ответа от всех друзей, это может занять до 20-30 секунд."
            : "Принял переписку. Собираю разбор от всех друзей, это может занять до 20-30 секунд.";
      return {
        messages: [{ text: panelIntro }],
        llmTask: {
          mode: "PANEL",
          scenario: panelScenario,
          userText,
          ...(forceFree ? { forceFree: true } : {})
        },
        analyticsContext: {
          askAllOrigin
        }
      };
    }

    if (state.pendingMode === "awaiting_compose_input" || state.pendingMode === "awaiting_reply_input") {
      if (state.currentPersona === null) {
        state.pendingUserText = userText;
        return {
          messages: [{ text: "Понял переписку. Кого позвать, чтобы ответить?", keyboard: startKeyboard(), replyKeyboard: mainReplyKeyboard() }]
        };
      }
      const scenario: ToolScenario = state.pendingMode === "awaiting_compose_input" ? "compose" : "reply";
      state.pendingMode = null;
      state.pendingPanelScenario = null;
      state.pendingAutoPanelFromColdStart = false;
      this.clearDangerConfirmations(state);
      return {
        messages: [{ text: scenario === "compose" ? "📝 Принял переписку. Собираю варианты формулировки..." : "💬 Принял переписку. Собираю варианты ответа..." }],
        llmTask: {
          mode: "SINGLE",
          persona: state.currentPersona,
          scenario,
          userText
        }
      };
    }

    if (state.currentPersona === null) {
      state.pendingUserText = userText;
      this.clearDangerConfirmations(state);
      return {
        messages: [{ text: "Понял переписку. Кого позвать, чтобы ответить?", keyboard: startKeyboard(), replyKeyboard: mainReplyKeyboard() }]
      };
    }

    this.clearDangerConfirmations(state);
    return {
      messages: [{ text: `(${personaLabel(state.currentPersona)}) Принял переписку.` }],
      llmTask: {
        mode: "SINGLE",
        persona: state.currentPersona,
        scenario: null,
        userText
      }
    };
  }

  private consumePendingConversation(state: UserSessionState): string | null {
    if (state.pendingConversationParts.length === 0) {
      return null;
    }
    const text = formatConversationParts(state.pendingConversationParts);
    this.clearPendingConversation(state);
    return text;
  }

  private clearPendingConversation(state: UserSessionState): void {
    state.pendingConversationParts = [];
  }

  private enterPanelInput(state: UserSessionState, userId: string, panelScenario: PanelScenario): void {
    state.lastPersonaBeforePanel = state.currentPersona;
    state.pendingMode = "awaiting_panel_input";
    state.pendingPanelScenario = panelScenario;
    state.pendingAutoPanelFromColdStart = this.shouldRunFreeColdStartPanel(state, userId);
    this.clearPendingConversation(state);
  }

  private shouldRunFreeColdStartPanel(state: UserSessionState, userId: string): boolean {
    return state.pendingAutoPanelFromColdStart || (this.firstPanelStateStore ? !this.firstPanelStateStore.hasSeenFirstPanel(userId) : false);
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

  private getSettingsKeyboard(userId: string): InlineKeyboard {
    if (!this.balanceStore) {
      return settingsKeyboard();
    }
    return settingsKeyboardWithReminders(this.balanceStore.getRemindersEnabled(userId));
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

function isConversationDoneQuickAction(quickAction: string): boolean {
  return quickAction === "готово" || quickAction === "готов";
}

function isConversationCancelQuickAction(quickAction: string): boolean {
  return quickAction === "отмена" || quickAction === "отменить" || quickAction === "сброс";
}

function shouldBypassRateLimit(event: IncomingEvent, state: UserSessionState): boolean {
  if (state.pendingConversationParts.length === 0) {
    return false;
  }
  if (event.text !== undefined) {
    return true;
  }
  return event.callbackData === "conversation_done" || event.callbackData === "conversation_cancel";
}

function formatConversationPartAck(count: number): string {
  return `Принял ${count} ${pluralizeFragment(count)}. Кидай ещё переписку, войс или скрин. Когда всё — нажми «Готово».`;
}

function pluralizeFragment(count: number): string {
  const mod10 = count % 10;
  const mod100 = count % 100;
  if (mod10 === 1 && mod100 !== 11) {
    return "фрагмент";
  }
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) {
    return "фрагмента";
  }
  return "фрагментов";
}

function formatConversationParts(parts: UserSessionState["pendingConversationParts"]): string {
  return parts
    .map((part, index) => `[Фрагмент ${index + 1}: ${conversationPartSourceLabel(part.source)}]\n${part.text}`)
    .join("\n\n");
}

function conversationPartSourceLabel(source: ConversationPartSource): string {
  switch (source) {
    case "voice":
      return "войс";
    case "screenshot":
      return "скрин";
    case "text":
    default:
      return "текст";
  }
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
      paywallShown: number;
      purchaseCompleted: number;
    };
    sevenDays: {
      starts: number;
      askAll: number;
      shareClicked: number;
    };
  },
  invitedUsersTotal: number,
  sourceBreakdown: Array<{ source: string; count: number }>
): string {
  const activationToday = formatRatio(stats.today.askAll, stats.today.starts);
  const shareToday = formatRatio(stats.today.shareClicked, stats.today.askAll);
  const activation7d = formatRatio(stats.sevenDays.askAll, stats.sevenDays.starts);
  const share7d = formatRatio(stats.sevenDays.shareClicked, stats.sevenDays.askAll);
  const sourceLines = sourceBreakdown.length > 0
    ? sourceBreakdown.map((item) => `• ${item.source}: ${item.count}`).join("\n")
    : "• organic: 0";

  return (
    "📊 Статистика\n\n" +
    `Сегодня (${stats.todayDate}):\n` +
    `• starts: ${stats.today.starts}\n` +
    `• ask_all: ${stats.today.askAll}\n` +
    `• tools: write ${stats.today.toolWrite} / reply ${stats.today.toolReply} / summary ${stats.today.toolSummary}\n` +
    `• share_clicked: ${stats.today.shareClicked}\n` +
    `• model_error: ${stats.today.modelError}\n` +
    `• safety_triggered: ${stats.today.safetyTriggered}\n` +
    `• paywall_shown: ${stats.today.paywallShown}\n` +
    `• purchase_completed: ${stats.today.purchaseCompleted}\n\n` +
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
    `• всего приглашённых: ${invitedUsersTotal}\n\n` +
    "Источники:\n" +
    sourceLines
  );
}

function formatRatio(numerator: number, denominator: number): string {
  if (denominator <= 0) {
    return "—";
  }
  return `${((numerator / denominator) * 100).toFixed(1)}%`;
}
