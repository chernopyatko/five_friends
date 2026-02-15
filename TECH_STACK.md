# TECH_STACK

## Runtime
- Node.js 20
- TypeScript 5.5.4

## Telegram
- grammY 1.23.1

## Storage
- SQLite (file‑based)
- better‑sqlite3 9.5.0

## LLM
- OpenAI SDK `openai` 4.76.0
- Responses API
- Модельные роли:
  - Router: gpt‑5‑mini (только JSON)
  - Generator SINGLE: gpt‑5.1 (эскалация до gpt‑5.2)
  - Generator PANEL: gpt‑5.2
  - SUMMARY + memory updates: gpt‑5‑mini
- `instructions` на каждом вызове
- `reasoning.effort`: high

## PromptBuilder (композиция)
**Порядок инструкций (всегда):**
1) `prompts/LLM_SYSTEM_PROMPT_RU_LONG.md` (1:1)
2) `prompts/global_instructions.txt`
3) mode prompt (`prompts/mode_panel.txt` / `mode_summary.txt` / `mode_crisis.txt`)
4) persona prompt (`prompts/persona_*.txt`) — только в SINGLE
5) Delimiters и untrusted‑данные:
   - `MEMORY_START ... MEMORY_END`
   - `USER_MESSAGE_START ... USER_MESSAGE_END`
**Контекст:** pinned prefs + topK long‑term + rollingSummary + последние 4–6 сообщений.

## Observability
- pino 9.0.0
- Структурированные логи без сырого текста

## Testing / Linting
- vitest 1.6.0
- eslint 8.57.0

## Scripts (package.json)
- `dev`: tsx src/index.ts
- `build`: tsc
- `start`: node dist/src/index.js
- `test`: vitest
- `lint`: eslint .

## Env vars (минимум)
- BOT_TOKEN
- OPENAI_API_KEY
- TELEMETRY_SALT
- LOG_LEVEL
- DEBUG_LOG_TEXT
- METRICS_ENABLED

Модельная политика фиксирована по режимам (см. `MODEL_POLICY.md`); `OPENAI_MODEL` в runtime не используется.

## Политика маршрутизации (сводно)
- Router (mini) даёт только JSON‑решения.
- Политика в `src/policy/modelPolicy.ts` делает детерминированные overrides.
- Всегда эскалируем вверх при сомнениях.
