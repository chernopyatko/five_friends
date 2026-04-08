# COLD START UX — Бриф для реализации

## Контекст

Текущий `/start` показывает стену текста (12 строк, 3 инструмента + 4 персонажа) и 8-кнопочную reply keyboard. Новый юзер парализован выбором — не знает с чего начать. Пишет «привет» → бот: «Кого позвать?» → тупик.

**Цель:** переделать /start так, чтобы юзер за 1 нажатие попал в разговор.

## Что меняется

### 1. /start текст — укорачиваем

**Было:**
```
Привет! Здесь живут 4 друга — они помогут разобраться в сложной ситуации и подобрать правильные слова.

🧰 ЧТО МЫ УМЕЕМ
🚀 Спросить всех — задай вопрос и получи 4 разных взгляда на ситуацию.
📝 Напиши за меня — опиши ситуацию, и мы сформулируем сообщение кому угодно.
💬 Помоги ответить — перешли нам сложное сообщение, а мы подскажем, что на него ответить.
А еще можно выбрать кого-то одного и просто поболтать.

👥 КТО ОТВЕЧАЕТ
🧠 Ян — разложит по полочкам и даст план
❤️ Наташа — поддержит и назовёт чувства
🌀 Аня — задаст точный вопрос про главное
🎯 Макс — пошутит, вернёт на землю и отделит факты от эмоций

Выбирай нужный инструмент в меню ниже или просто пиши свой вопрос прямо сюда!
```

**Стало:**
```
Привет! Здесь живут 4 друга — каждый помогает по-своему.

Что привело тебя сюда?
```

Плюс **inline-клавиатура** (см. п.2) + **reply keyboard** (без изменений, показывается сразу как сейчас).

### 2. Новая inline-клавиатура для /start

**Файл:** `src/telegram/keyboard.ts`

Добавить функцию `coldStartKeyboard()`:
```ts
export function coldStartKeyboard(): InlineKeyboard {
  return [
    [{ text: "🤯 Есть ситуация — нужен взгляд со стороны", data: "cs_situation" }],
    [{ text: "💬 Сложное сообщение — помоги ответить или написать", data: "cs_message" }],
    [{ text: "🙂 Просто хочу поболтать", data: "cs_chat" }]
  ];
}
```

Добавить функцию `coldStartMessageKeyboard()` (подменю для «Сложное сообщение»):
```ts
export function coldStartMessageKeyboard(): InlineKeyboard {
  return [
    [{ text: "📝 Написать сообщение кому-то", data: "cs_compose" }],
    [{ text: "💬 Ответить на чужое сообщение", data: "cs_reply" }]
  ];
}
```

Добавить функцию `coldStartChatKeyboard()` (выбор друга для «Поболтать»):
```ts
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
```

**НЕ трогать** существующие функции: `startKeyboard()`, `friendsKeyboard()`, `mainReplyKeyboard()` и остальные. Они используются в других местах.

### 3. Обработчики callback в uxHandlers.ts

**Файл:** `src/telegram/uxHandlers.ts`

#### 3a. Изменить /start handler

В методе `handleCommand`, case `/start`:
- Заменить `START_TEXT` на новый короткий текст (см. п.1).
- Добавить `keyboard: coldStartKeyboard()` к ответу.
- Reply keyboard по-прежнему `mainReplyKeyboard()`.
- Референс и аналитика `/start` — **не трогать**, оставить как есть.

Результат:
```ts
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
        text: COLD_START_TEXT,
        keyboard: coldStartKeyboard(),
        replyKeyboard: mainReplyKeyboard()
      }
    ]
  };
}
```

Где `COLD_START_TEXT`:
```ts
const COLD_START_TEXT =
  "Привет! Здесь живут 4 друга — каждый помогает по-своему.\n\n" +
  "Что привело тебя сюда?";
```

Старый `START_TEXT` **оставить в файле** (будет использоваться в `/help`; см. п.5).

#### 3b. Callback: `cs_situation`

В методе `handleCallback`, добавить обработку:

```
cs_situation → ставит pendingMode = "awaiting_panel_input", отвечает текстом.
```

Логика:
```ts
if (callbackData === "cs_situation") {
  state.lastPersonaBeforePanel = state.currentPersona;
  state.pendingMode = "awaiting_panel_input";
  state.pendingPanelScenario = null;
  this.clearDangerConfirmations(state);
  return {
    messages: [{
      text: "Расскажи что случилось — ребята разберут с разных сторон.",
      replyKeyboard: mainReplyKeyboard()
    }]
  };
}
```

Это по сути то же самое, что делает `panel_start`, но с другим текстом ответа. Дальше юзер пишет текст → стандартный PANEL flow уже работает.

#### 3c. Callback: `cs_message`

Показывает подменю compose/reply:
```ts
if (callbackData === "cs_message") {
  return {
    messages: [{
      text: "Что нужно?",
      keyboard: coldStartMessageKeyboard(),
      replyKeyboard: mainReplyKeyboard()
    }]
  };
}
```

#### 3d. Callback: `cs_compose`

Запускает compose flow. Если друг не выбран — предлагает выбрать (используя существующий `startKeyboard()`):
```ts
if (callbackData === "cs_compose") {
  state.pendingMode = "awaiting_compose_input";
  state.pendingPanelScenario = null;
  this.clearDangerConfirmations(state);
  if (state.currentPersona === null) {
    return {
      messages: [{
        text: "📝 Сначала выбери друга, который поможет сформулировать.",
        keyboard: startKeyboard(),
        replyKeyboard: mainReplyKeyboard()
      }]
    };
  }
  return {
    messages: [{
      text: "📝 Напиши, что нужно сформулировать: ситуацию, адресата и желаемый тон.",
      replyKeyboard: mainReplyKeyboard()
    }]
  };
}
```

#### 3e. Callback: `cs_reply`

Аналогично compose, но для reply:
```ts
if (callbackData === "cs_reply") {
  state.pendingMode = "awaiting_reply_input";
  state.pendingPanelScenario = null;
  this.clearDangerConfirmations(state);
  if (state.currentPersona === null) {
    return {
      messages: [{
        text: "💬 Сначала выбери друга, который поможет с ответом.",
        keyboard: startKeyboard(),
        replyKeyboard: mainReplyKeyboard()
      }]
    };
  }
  return {
    messages: [{
      text: "💬 Вставь входящее сообщение и, если нужно, что ты хочешь получить на выходе.",
      replyKeyboard: mainReplyKeyboard()
    }]
  };
}
```

#### 3f. Callback: `cs_chat`

Показывает выбор друга для болтовни:
```ts
if (callbackData === "cs_chat") {
  return {
    messages: [{
      text: "С кем хочешь поговорить?",
      keyboard: coldStartChatKeyboard(),
      replyKeyboard: mainReplyKeyboard()
    }]
  };
}
```

#### 3g. Callback: `cs_chat_yan`, `cs_chat_natasha`, `cs_chat_anya`, `cs_chat_max`

Выбирает друга + запускает приветствие от друга (LLM, non-billable):
```ts
if (callbackData.startsWith("cs_chat_")) {
  const persona = callbackData.replace("cs_chat_", "") as Persona;
  if (!["yan", "natasha", "anya", "max"].includes(persona)) {
    return { messages: [{ text: "Не понял выбор. Попробуй ещё раз." }] };
  }
  state.currentPersona = persona;
  state.pendingMode = null;
  state.pendingPanelScenario = null;
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
      userText: "Пользователь только что пришёл и выбрал тебя, чтобы просто поболтать. Поздоровайся в своём стиле и предложи тему или задай лёгкий вопрос. Не спрашивай 'о чём хочешь поговорить' — предложи сам.",
      forceFree: true
    }
  };
}
```

### 4. forceFree флаг

#### 4a. Добавить в LLMTask

**Файл:** `src/telegram/uxHandlers.ts`

В интерфейс `LLMTask` добавить опциональное поле:
```ts
export interface LLMTask {
  mode: Extract<BotMode, "SINGLE" | "PANEL" | "SUMMARY">;
  persona?: Persona;
  scenario?: ToolScenario | null;
  userText: string;
  forceFree?: boolean;  // ← добавить
}
```

#### 4b. Обработать в bot.ts

**Файл:** `src/telegram/bot.ts`

В методе `applyLLMIfNeeded`, в блоке проверки баланса, добавить условие `forceFree`:

**Было:**
```ts
const isBypass = !this.billingConfigured || this.bypassBalanceUserIds.has(event.userId);
if (!isBypass && this.balanceStore && this.billingConfig) {
```

**Стало:**
```ts
const isBypass = !this.billingConfigured || this.bypassBalanceUserIds.has(event.userId) || result.llmTask.forceFree === true;
if (!isBypass && this.balanceStore && this.billingConfig) {
```

Так же в блоке post-generation deduction (ниже по коду), та же проверка:

**Было:**
```ts
if (!isBypass && this.balanceStore && generation.billable && this.billingConfig) {
```

**Стало:**
```ts
if (!isBypass && this.balanceStore && generation.billable && this.billingConfig && !result.llmTask.forceFree) {
```

И в блоке share:

**Было:**
```ts
const withShare = generation.billable
  ? this.appendShareMessageIfNeeded(result.llmTask, event.userId, mergedMessages)
  : mergedMessages;
```

**Стало:**
```ts
const withShare = generation.billable && !result.llmTask.forceFree
  ? this.appendShareMessageIfNeeded(result.llmTask, event.userId, mergedMessages)
  : mergedMessages;
```

И в блоке analytics post-generation event:

**Было:**
```ts
if (generation.billable) {
  const postGenerationEvent = resolvePostGenerationEvent(result.llmTask);
```

**Стало:**
```ts
if (generation.billable && !result.llmTask.forceFree) {
  const postGenerationEvent = resolvePostGenerationEvent(result.llmTask);
```

**Суть:** `forceFree` делает LLM-вызов полностью невидимым для биллинга — не проверяет баланс, не списывает, не показывает nudge/footer, не добавляет share, не эмитит billable-аналитику.

### 5. /help получает полное описание

**Файл:** `src/telegram/uxHandlers.ts`

`HELP_TEXT` уже содержит полное описание инструментов и друзей — **ничего менять не нужно**. Кнопка «❓ Помощь» на reply keyboard и команда `/help` уже ведут туда.

### 6. COPY.md — обновить документацию

**Файл:** `COPY.md`

Обновить секцию `## 1) /start`:
```md
## 1) /start
Текст:
\```
Привет! Здесь живут 4 друга — каждый помогает по-своему.

Что привело тебя сюда?
\```
Inline-кнопки:
- `🤯 Есть ситуация — нужен взгляд со стороны` (callback: `cs_situation`)
- `💬 Сложное сообщение — помоги ответить или написать` (callback: `cs_message`)
- `🙂 Просто хочу поболтать` (callback: `cs_chat`)

Reply keyboard: стандартная (без изменений).

### Подменю «Сложное сообщение»
Текст: `Что нужно?`
- `📝 Написать сообщение кому-то` (callback: `cs_compose`)
- `💬 Ответить на чужое сообщение` (callback: `cs_reply`)

### Подменю «Просто хочу поболтать»
Текст: `С кем хочешь поговорить?`
- `🧠 Ян — разложит по полочкам` (callback: `cs_chat_yan`)
- `❤️ Наташа — поддержит и поймёт` (callback: `cs_chat_natasha`)
- `🌀 Аня — задаст точный вопрос` (callback: `cs_chat_anya`)
- `🎯 Макс — скажет как есть` (callback: `cs_chat_max`)

После выбора друга — друг здоровается сам (LLM, non-billable).
```

---

## Чего НЕ делать

1. **НЕ трогать** существующие keyboard-функции (`startKeyboard`, `friendsKeyboard`, `mainReplyKeyboard` и т.д.) — они используются в других flows.
2. **НЕ менять** reply keyboard layout — остаётся как есть.
3. **НЕ трогать** HELP_TEXT — он остаётся полным описанием.
4. **НЕ менять** обработку текста без персоны (`currentPersona === null` + текст → «Кого позвать?»). Это отдельный фикс на будущее.
5. **НЕ менять** логику referral в /start — payload обработка остаётся.
6. **НЕ трогать** safety flow, billing flow, panel/compose/reply flows — они уже работают.
7. **НЕ добавлять** новые зависимости.

## Тесты

### Что проверить (unit tests):

1. `/start` возвращает короткий текст + `coldStartKeyboard()` + `mainReplyKeyboard()`.
2. Callback `cs_situation` → ставит `pendingMode = "awaiting_panel_input"`, возвращает текст.
3. Callback `cs_message` → возвращает подменю с `coldStartMessageKeyboard()`.
4. Callback `cs_compose` без друга → предлагает выбрать друга.
5. Callback `cs_compose` с другом → ставит `pendingMode = "awaiting_compose_input"`.
6. Callback `cs_reply` без друга → предлагает выбрать друга.
7. Callback `cs_reply` с другом → ставит `pendingMode = "awaiting_reply_input"`.
8. Callback `cs_chat` → возвращает `coldStartChatKeyboard()`.
9. Callback `cs_chat_yan` → ставит `currentPersona = "yan"`, возвращает `llmTask` с `forceFree: true`.
10. `forceFree: true` в LLMTask → `bot.ts` не проверяет баланс, не списывает, не добавляет share.

### Существующие тесты:

Все существующие тесты **ДОЛЖНЫ проходить** без изменений, кроме тестов на /start text (если есть проверка точного текста START_TEXT — обновить на COLD_START_TEXT).

## Файлы для изменения (полный список)

1. `src/telegram/keyboard.ts` — добавить 3 новые функции.
2. `src/telegram/uxHandlers.ts` — новый COLD_START_TEXT, изменить /start handler, добавить 7 callback handlers, добавить `forceFree` в LLMTask.
3. `src/telegram/bot.ts` — обработка `forceFree` в 4 местах в `applyLLMIfNeeded`.
4. `COPY.md` — обновить секцию /start.

Общий объём: ~100 строк нового кода + правки в 4 точках bot.ts.
