---
description: UX audit protocol for Telegram bot
---

# UX AUDIT PROTOCOL

## Step 0 — Reality Check (mandatory)
- Могу ли я запустить/протестировать бота?
  - Если да: описать как запущен и что протестировано.
  - Если нет: указать причину и запросить минимум инфо, затем продолжить doc‑based аудит.

## Step 1 — Full Flow Audit (state machine view)
Аудит каждого состояния и пути:
- Clarity (понятно ли, что делать дальше за 2 сек)
- Momentum (минимум шагов до ценности)
- Error recovery (invalid input, timeouts, deleted messages, expired callbacks)
- Backtracking (escape hatches)
- Consistency (одинаковый ярлык = одинаковое действие)
- Confirmation discipline (подтверждать только необратимое)
- Cognitive load (chunking, progressive disclosure)
- Input strategy (кнопки для конечных выборов, текст для ситуаций)
- State persistence (можно вернуться без потерь)
- Interruptions (help/privacy mid‑flow, затем resume)

Telegram‑specific:
- лимиты inline‑кнопок, пагинация
- idempotency и stale callbacks
- edit vs new messages
- rate limits / spamminess
- cross‑device parity

## Step 2 — “Inevitable Bot” filter
Для каждого шага:
- можно ли пройти без инструкции?
- шаг можно убрать/слить?
- основное действие заметно?
- есть безопасный default?
- пользователь всегда знает: где я / что случилось / что дальше?

## Step 3 — Produce phased plan (NO implementation)
Формат вывода:

**BOT UX AUDIT RESULTS**
- Overall Assessment (2 строки)
- PHASE 1 — Critical
- PHASE 2 — Refinement
- PHASE 3 — Polish
- REQUIRED UPDATES (UX_FLOW/COPY/COMMANDS)
- IMPLEMENTATION NOTES FOR BUILD AGENT (paths, exact old→new copy, keyboard layout, validation, idempotency)

## Approval rule
- Никакой реализации до подтверждения **PHASE 1**.
