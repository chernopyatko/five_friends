# UX_FLOW — state machine (Telegram)

## 0) Session state (per user)
- `currentPersona`: `yan | natasha | anya | max | null`
- `pendingMode`: `null | awaiting_panel_input | awaiting_compose_input | awaiting_reply_input`
- `pendingUserText`: `string | null`
- `lastPersonaBeforePanel`: `yan | natasha | anya | max | null`
- `safetyHold`: `boolean`
- `pendingSafetyCheck`: `boolean`
- `sessionId`, `sessionStartTs`, `lastActivityTs`

## 1) Main entry points
- `/start` -> показывает стартовый текст + постоянную reply-клавиатуру.
- `/help` и `/friends` -> объяснение режимов и друзей.
- Текст без выбранного друга -> `pendingUserText` + вопрос «Кого позвать?».

## 2) Main reply keyboard
- `🚀 Все взгляды` `👥 Друзья`
- `📝 Сформулируй` `💬 Ответь`
- `📋 Сводка` `❓ Помощь`
- `⚙️ Настройки`

## 3) Core text routing priority
1. `safetyHold == true` -> CrisisResponder.
2. Быстрый выбор друга (callback `choose_friend:*` или короткий текст `Ян/Наташа/Аня/Макс`) -> смена `currentPersona`.
3. Системные quick actions (`помощь`, `настройки`, `демо`, `друзья`).
4. Pending modes:
   - `awaiting_panel_input` -> PANEL на следующем тексте.
   - `awaiting_compose_input` -> SINGLE + `scenario=compose`.
   - `awaiting_reply_input` -> SINGLE + `scenario=reply`.
5. Triggers:
   - panel: `все взгляды|все сразу|совет всех|позвать всех`
   - summary: `сводка|инна` (legacy alias)
   - compose: `сформулируй`
   - reply: `ответь`
6. Default:
   - если `currentPersona != null` -> SINGLE.
   - иначе -> сохранить `pendingUserText` и попросить выбрать друга.

## 4) Panel flow
- Вход: кнопка `🚀 Все взгляды` или текстовый trigger.
- Состояние: `pendingMode = awaiting_panel_input`.
- Ответ-промпт: «Следующее сообщение разберём вместе...».
- Следующий текст -> `llmTask.mode = PANEL`, pending очищается.

## 5) Summary flow
- Вход: кнопка `📋 Сводка`, callback `summary_now`, или trigger `сводка`/`инна`.
- Состояние: pending не используется, режим запускается сразу.
- `llmTask.mode = SUMMARY` в том же update.
- Summary — tool-flow без отдельной персоны.

## 6) Compose flow
- Вход: кнопка/текст `📝 Сформулируй`.
- Состояние: `pendingMode = awaiting_compose_input`.
- Если `currentPersona == null` -> сначала выбор друга.
- Следующий текст -> `llmTask = { mode: SINGLE, persona: currentPersona, scenario: compose }`.

## 7) Reply flow
- Вход: кнопка/текст `💬 Ответь`.
- Состояние: `pendingMode = awaiting_reply_input`.
- Если `currentPersona == null` -> сначала выбор друга.
- Следующий текст -> `llmTask = { mode: SINGLE, persona: currentPersona, scenario: reply }`.

## 8) Safety flow
- hard marker -> fixed CrisisResponder.
- soft marker -> SafetyCheck с кнопками.
- `safety_yes` -> `safetyHold = true`.
- `safety_no` / `safety_resume` -> выход из safety flow.

## 9) Session/controls
- `/reset` сбрасывает рабочую сессию и pending state, но сохраняет выбранную персону.
- `/forget` удаляет long-term memory.
- Rate limit: 5 событий за 2 секунды на пользователя.
- Duplicate update id -> «Эта кнопка устарела. Выбери ещё раз.»
