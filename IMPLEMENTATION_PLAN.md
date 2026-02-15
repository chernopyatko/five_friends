# IMPLEMENTATION_PLAN

> План после `B_LOCKED`. Никакого кода до подтверждения.

## 1.1 Базовая инфраструктура
**Файлы:** package.json, tsconfig.json, eslint.config.js, vitest.config.ts, .gitignore, .env.example, src/index.ts (пустой вход), /tests.

**DoD:**
- Проект собирается (`npm run build`).
- Тесты и линт запускаются (пусть без тестов).

**Verify:**
- `npm run build`
- `npm run lint`

**Rollback:** удалить добавленные файлы.

## 1.2 Схема БД и store состояния
**Файлы:** src/state/schema.ts, src/state/store.ts, src/state/session.ts

**DoD:**
- Таблицы sessions/messages/memories создаются.
- CRUD для session/working и long‑term.

**Verify:**
- `npm test -- schema` (smoke)

**Rollback:** откатить schema/store.

## 1.3 Prompt loader + promptBuilder
**Файлы:** src/llm/promptBuilder.ts, src/llm/schemas.ts

**DoD:**
- Загрузка промптов из /prompts.
- Встроены delimiters: USER_MESSAGE_START/END, MEMORY_START/END.
- Snapshot test: LLM_SYSTEM_PROMPT_RU_LONG.md включён полностью.

**Verify:**
- `npm test -- promptBuilder`

**Rollback:** удалить promptBuilder.

## 1.4 Router (gpt‑5‑mini) + JSON schema
**Файлы:** src/llm/router.ts, src/llm/routerSchema.ts

**DoD:**
- Router возвращает только JSON (json_schema, additionalProperties=false).
- Никакой генерации текста.

**Verify:**
- `npm test -- routerSchema`

**Rollback:** revert router.

## 1.5 Политика модели и эскалации
**Файлы:** src/policy/modelPolicy.ts, tests/policy/modelPolicy.test.ts

**DoD:**
- Детерминированные overrides по правилам.
- Никогда не даун‑эскалация.

**Verify:**
- `npm test -- modelPolicy`

## 1.6 Safety + Output guard
**Файлы:** src/security/safety.ts, src/security/outputGuard.ts, tests/security/*.test.ts

**DoD:**
- Hard/soft классификация.
- SafetyCheck UX + safetyHold.
- Output guard блокирует role‑токены и URL; один retry.

**Verify:**
- `npm test -- safety`
- `npm test -- outputGuard`

## 1.7 LLM generator + tokenCount
**Файлы:** src/llm/generator.ts, src/utils/tokenCount.ts

**DoD:**
- SINGLE → gpt‑5.1 (эскалации → 5.2)
- PANEL → 5.2
- SUMMARY → mini
- instructions всегда устанавливаются.

**Verify:**
- unit‑tests + local smoke

## 1.8 Memory updater
**Файлы:** src/memory/sessionMemory.ts, src/memory/longTermMemory.ts, src/memory/memoryUpdater.ts, tests/memory/memoryUpdater.test.ts

**DoD:**
- rollingSummary обновляется mini‑моделью.
- long‑term записи только допустимых типов.

**Verify:**
- `npm test -- memoryUpdater`

## 1.9 Mode handlers
**Файлы:** src/modes/single.ts, src/modes/panel.ts, src/modes/summary.ts

**DoD:**
- PANEL формат валидируется; splitMessage применяется.
- SUMMARY — Inna‑only формат.

**Verify:**
- `npm test -- modes`

## 1.10 Telegram UX handlers
**Файлы:** src/telegram/uxHandlers.ts, src/keyboard.ts, src/bot.ts

**DoD:**
- Inline‑кнопки только в узлах.
- State machine соответствует UX_FLOW.
- Per‑user очередь, rate‑limit, идемпотентность.

**Verify:**
- `npm test -- stateMachine`

## 1.11 Observability
**Файлы:** src/observability/logger.ts, src/observability/metrics.ts

**DoD:**
- Структурные логи без сырого текста.
- METRICS_ENABLED флаг.

**Verify:**
- unit + smoke

## 1.12 README + smoke tests
**Файлы:** README.md

**DoD:**
- Инструкции запуска, env vars, smoke checklist.

**Verify:**
- локальный запуск dev‑режима

