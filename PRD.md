# PRD — «4 друзей + инструменты»

## 1) Краткое описание
Телеграм-бот, где пользователь выбирает одного из 4 друзей (Ян, Наташа, Аня, Макс) или запускает инструментный режим.

Ценность MVP:
- быстрый «разговорный» ответ в тоне выбранного друга;
- режим `Все взгляды` для 4 разных точек зрения;
- утилитарные сценарии для socially awkward кейсов: `Сформулируй`, `Ответь`, `Сводка`.

## 2) Целевая аудитория (MVP)
- люди, которым трудно формулировать сложные сообщения;
- пользователи в эмоциональном напряжении, которым нужен быстрый ясный ответ;
- пользователи, предпочитающие low-friction UI в Telegram.

## 3) Goals
- Дать предсказуемый UX: «друзья» и «инструменты» разделены.
- Сохранять отличимые голоса 4 друзей.
- Дать полезный результат за 1-2 шага.
- Сохранять безопасность и приватность.

## 4) Non-goals
- Никаких диагнозов и мед/юрид/фин-инструкций.
- Никакого web UI в MVP.
- Никакой публичной соц-механики.

## 5) Core modes
- `SINGLE`: ответ выбранного друга.
- `PANEL`: ответы 4 друзей.
- `SUMMARY`: tool-flow `📋 Сводка`.
- `CRISIS`: фиксированный safety ответ.
- `SINGLE+scenario=compose`: инструмент `📝 Сформулируй`.
- `SINGLE+scenario=reply`: инструмент `💬 Ответь`.

## 6) User stories
- Как пользователь, я выбираю друга и пишу как в обычном чате.
- Как пользователь, я запускаю `🚀 Все взгляды` и получаю 4 разных ответа.
- Как пользователь, я запускаю `📝 Сформулируй` и получаю готовые варианты сообщения.
- Как пользователь, я запускаю `💬 Ответь` и получаю варианты ответа на входящее.
- Как пользователь, я запускаю `📋 Сводка` и получаю короткий итог с шагами.

## 7) Functional requirements
### 7.1 UX / keyboard
- Постоянная reply-клавиатура:
  - `🚀 Спросить всех` `👥 Друзья`
  - `📝 Напиши за меня` `💬 Помоги ответить`
  - `📋 Итоги` `❓ Помощь`
  - `⚙️ Настройки`

### 7.2 Session logic
- `currentPersona` sticky до явного переключения.
- Инструменты не сбрасывают выбранную персону.
- Pending режимы:
  - `awaiting_panel_input`
  - `awaiting_compose_input`
  - `awaiting_reply_input`
- `SUMMARY` запускается one-click без pending state.

### 7.3 Safety
- hard/soft safety detection.
- hard -> fixed crisis text.
- soft -> safety check flow с resume.

### 7.4 Data
- session memory: rolling summary + последние сообщения.
- long-term memory: `fact/preference/thread/episode`.
- `/reset` -> session state reset.
- `/forget` -> long-term reset.

## 8) Acceptance criteria
- PANEL всегда содержит ровно 4 блока друзей.
- SUMMARY выводится как `📋 Сводка`.
- `compose` и `reply` работают через отдельные scenario prompts.
- `npm run test`, `npm run lint`, `npm run build` проходят.

## 9) Out of scope (current iteration)
- Репетиция разговора (multi-turn rehearsal).
- NLP-роутинг сложных intent-классов без кнопок.
- Инструмент `Разбор` как отдельный режим.
- Voice input (STT).
- Image input (multimodal).
- Daily reminders (autonomous proactive messages).

## 10) Future (next iteration)
- **Voice input**: STT через OpenAI Whisper API → транскрипт обрабатывается как обычный текст. grammY `message:voice` handler. Биллинг: 1 сообщение.
- **Image input (multimodal)**: скриншоты переписок → анализ через vision-capable модель (input_image в Responses API). Биллинг: 2–3 сообщения.
- **Daily reminders**: автономные push-сообщения для retention. Бот отправляет напоминание «напиши, как дела» без триггера от пользователя. Расписание настраивается; DB-based scheduler (или внешний cron). Тон — от выбранного друга.
  - **Consent**: напоминания включены по умолчанию, отключение через `/settings` (opt-out модель). При первом напоминании — пояснение как отключить.
  - **Frequency**: не более 1 напоминания в сутки, «неактивный» = нет сообщений последние 24h (configurable).
  - **Timezone**: напоминания отправляются с учётом часового пояса пользователя (default UTC).
  - **Rate limits**: учёт Telegram API rate limits при массовой отправке (batch с задержками).
  - **Privacy**: юзер информируется о трекинге активности для напоминаний.

### Accepted risks
- **Safety vs paywall**: при balance=0 пользователь в кризисе получит paywall, а не safety response. Осознанный выбор: pre-LLM safety check добавляет сложность и потенциальную поверхность для injection. Safety-классификация работает внутри LLM responder как штатный механизм. При необходимости можно добавить локальный `classifySafety(text)` до balance gate в будущем.
