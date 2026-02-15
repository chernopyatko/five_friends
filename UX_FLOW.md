# UX_FLOW — state machine (Telegram)

> Пользовательский UI использует только терминологию «друзья/персоны/позвать/кто в чате».

## 0) Переменные состояния (per‑user)
- currentPersona: `yan | natasha | anya | max | null`
- pendingMode: `null | awaiting_panel_input`
- pendingUserText: `string | null`
- lastPersonaBeforePanel: `yan | natasha | anya | max | null`
- sessionId, sessionStartTs, lastActivityTs
- safetyHold: `boolean`
- pendingSafetyCheck: `boolean`
- safetySuppressedUntilTs: `number | null`
- lastModeBeforeSafety: `{ currentPersona, pendingMode } | null`

## 1) Список состояний
### S0 — OnboardingChooseFriend
**Entry:** `/start` или нет выбранного друга.
**Actions:** показать копирайт /start и кнопки выбора друга.
**Inputs:**
- callback: `choose_friend(yan|natasha|anya|max)`
- callback: `panel_start` (🤝 Позвать всех)
- text (любой)
- commands: `/help`, `/friends`, `/reset`, `/privacy`, `/forget`
**Transitions:**
- choose_friend → S2 SingleChat (set currentPersona)
- panel_start → S4 PanelAwaitInput (set pendingMode, lastPersonaBeforePanel)
- /friends → S1 FriendsInfo
- text → S3 NoFriendPendingText (save pendingUserText)
- /reset → S0 (сессия reset)

### S1 — FriendsInfo
**Entry:** `/friends` (в меню «Кто в чате?»)
**Actions:** показать описание друзей + кнопки выбора.
**Inputs:**
- callbacks: `choose_friend(…)`, `panel_start`
- text
- commands: `/help`, `/reset`, `/privacy`, `/forget`
**Transitions:**
- choose_friend → S2 SingleChat
- panel_start → S4 PanelAwaitInput
- text → S3 NoFriendPendingText (если currentPersona=null) или S2 SingleChat (если друг уже выбран)

### S2 — SingleChat
**Entry:** currentPersona установлен, pendingMode=null.
**Inputs:**
- text (основной поток)
- callbacks: `choose_friend(…)` (смена друга)
- commands: `/help`, `/friends`, `/reset`, `/privacy`, `/forget`
**Transitions:**
- text + триггер «все сразу/позвать всех» → S4 PanelAwaitInput
- text + триггер «сводка» → S6 SummaryRequested
- text + триггер «позови <имя>» → S2 (смена currentPersona, подтверждение)
- /friends → S1 FriendsInfo (overlay)
- /reset → S2 SingleChat (session reset, currentPersona сохраняется)

### S3 — NoFriendPendingText
**Entry:** пользователь написал текст при currentPersona=null.
**Actions:** сохранить pendingUserText и спросить «Кого позвать, чтобы ответить?» + кнопки друзей.
**Inputs:**
- callback: `choose_friend(…)`
- text (любой)
- commands: `/help`, `/friends`, `/reset`, `/privacy`, `/forget`
**Transitions:**
- choose_friend → S2 SingleChat + обработка pendingUserText
- text → S3 (перезаписать pendingUserText)

### S4 — PanelAwaitInput (pendingMode=awaiting_panel_input)
**Entry:** триггер «все сразу» или кнопка 🤝.
**Actions:** если currentPersona задан — сохранить в lastPersonaBeforePanel. Показать prompt для одного сообщения без inline‑кнопок (чтобы не создавать двойственность), ждём следующее сообщение.
**Inputs:**
- text (ожидаем следующее сообщение)
- commands: `/help`, `/friends`, `/reset`, `/privacy`, `/forget`
**Transitions:**
- text → генерация PANEL → S5 PanelAfterResponseChooseFriend
- повторный триггер «все сразу» пока pending → остаёмся в S4, отвечаем «Я уже жду одно сообщение для 🤝»

### S5 — PanelAfterResponseChooseFriend
**Entry:** панельный ответ отправлен.
**Actions:** показать 4 кнопки «Продолжить с …».
**Inputs:**
- callback: `choose_friend(…)`
- text
**Transitions:**
- choose_friend → S2 SingleChat
- text + lastPersonaBeforePanel!=null → S2 SingleChat (этим другом) + короткий hint (не чаще 1 раза в 3 ответа)
- text + lastPersonaBeforePanel==null → S3 NoFriendPendingText + нудж «Выбери, кого позвать»

### S6 — SummaryRequested
**Entry:** триггер «сводка».
**Actions:** сгенерировать сводку Инны только по текущей сессии.
**Transitions:**
- после ответа → возврат в предыдущее состояние (обычно S2)
- если данных нет → копирайт «Пока нечего сводить…», состояние не меняется

### S7 — SafetyCheckPending (soft)
**Entry:** soft‑детектор.
**Actions:** показать SafetyCheck с кнопками; сохранить pendingUserText + lastModeBeforeSafety.
**Inputs:**
- callback: `safety_yes` (мне небезопасно)
- callback: `safety_no` (я в порядке)
- callback: `safety_help`
**Transitions:**
- safety_yes → S8 SafetyHold (CrisisResponder)
- safety_no → восстановить lastModeBeforeSafety + обработать pendingUserText
- safety_help → S8 SafetyHold (показ help‑контактов)

### S8 — SafetyHold (hard)
**Entry:** hard‑детектор или подтверждение небезопасно.
**Actions:** фиксированный CrisisResponder + кнопки «Найти помощь», «Я в безопасности ✅».
**Inputs:**
- callback: `safety_help`
- callback: `safety_resume`
**Transitions:**
- safety_resume → восстановить lastModeBeforeSafety (или S0 при отсутствии)
- safety_help → остаёмся в S8, показываем контакты (если страна неизвестна — предлагаем выбор)

### S9 — ErrorTransientRetry
**Entry:** таймаут/5xx/Telegram send error.
**Actions:** сообщение ошибки + кнопки «Попробовать ещё раз», «Кого позвать».
**Transitions:**
- retry → повтор последней операции (идемпотентно)
- choose_friend → S0

### S10 — SplitResponseTail (выходной policy)
Если ответ разделён на 2–3 сообщения, кнопки показываются **только** на последнем.

## 2) Правила валидации триггеров
- «все сразу/сводка/позови <имя>» срабатывают только на коротких сообщениях (≤5–7 слов) или явном маркере (например, «позови …», «все сразу», «сводка»).
- Если сомнительно — запрос подтверждения одной парой кнопок [Да/Нет].

## 3) Back/Cancel/Home policy
- «Назад» и «Домой» не используются.
- «Отменить 🤝» — только в S4.
- «Кого позвать» — как мягкий выход в pending/error.

## 4) Interruptions
- `/help`, `/friends`, `/privacy`, `/forget` доступны из любых состояний; возвращаемся в прежнее состояние.
- `/reset` сбрасывает session/working память и pending состояния; currentPersona сохраняется.
- `/forget` удаляет long‑term память; текущая сессия и состояние сохраняются.
- Постоянная reply‑клавиатура доступна всегда, независимо от состояния; inline‑кнопки используются только там, где нужен контекстный выбор.

## 5) Подсказки
- Текстовые подсказки показывать не чаще **1 раза в 3 ответа** (N=3).

## 6) Idempotency
- Повторные update/callback не должны ломать состояние.
- Стейты в pending очищаются при рестарте (restart hygiene).
