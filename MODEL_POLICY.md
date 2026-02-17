# MODEL_POLICY — deterministic routing & safety gating (MVP)

## 0) Primary goal
- Никогда не ухудшать качество ответа из-за «неуверенного» роутинга.
- gpt-5-mini — router + memory + SUMMARY.
- gpt-5.1 — дефолт SINGLE.
- gpt-5.2 — PANEL и эскалации SINGLE.
- CRISIS — фиксированный текст (без LLM-генерации).

## 1) Source of truth
- `prompts/LLM_SYSTEM_PROMPT_RU_LONG.md` — основной системный промпт.
- `prompts/mode_panel.txt`, `prompts/mode_summary.txt` — режимные промпты.
- `prompts/scenario_compose.txt`, `prompts/scenario_reply.txt` — tool-сценарии.

## 2) Decision pipeline
A) Router (gpt-5-mini) -> JSON-решение, без пользовательского текста.  
B) Generator (gpt-5.1/5.2/5-mini) -> ответ пользователю.  
C) Memory updater (gpt-5-mini) -> rollingSummary + long-term.

## 3) Deterministic mode overrides
Вход: `user_text + state + routerDecision + tokenEstimate`.

1) `crisis_heuristic_hard == true` -> MODE=CRISIS, fixed response.
2) `forcedMode == PANEL|SUMMARY` (из `llmTask.mode`) -> выбранный MODE.
3) `pendingMode == awaiting_panel_input` -> MODE=PANEL, model=gpt-5.2.
4) Явный trigger panel (`все взгляды`, `все сразу`, `совет всех`, `позвать всех`) -> MODE=PANEL.
5) Явный trigger summary (`сводка`, `инна`) -> MODE=SUMMARY.
6) Иначе MODE=SINGLE (персону задаёт UX).

## 4) Tool scenarios
- `compose` и `reply` работают как `SINGLE` с дополнительным tool prompt.
- Tool-сценарий не меняет модель сам по себе.
- Эскалация для tool-сценария совпадает с правилами SINGLE.

## 5) Escalation SINGLE -> gpt-5.2
Эскалируем вверх, если выполняется любой сигнал:
- `tokenEstimate >= 850`
- high-importance markers в user_text
- конфликт/амбивалентность в user_text
- `routerDecision.emotional_intensity == high`
- soft safety signal
- `routerDecision.confidence < 0.75`
- конфликт сигналов heuristic vs router
- `routerDecision.needs_escalation == true`

Правило: если сомнение — эскалация вверх, никогда вниз.

## 6) Safety design
- hard -> фиксированный CrisisResponder, `safetyHold=true`.
- soft -> SafetyCheck до продолжения обычного флоу.
- Контакты помощи выдаются только через flow `Найти помощь`.

## 7) Prompt injection defense
- user text и memory считаются untrusted.
- PromptBuilder всегда добавляет:
  - `MEMORY_START/END`
  - `USER_MESSAGE_START/END`
- Output guard блокирует role-токены и URL.

## 8) Router JSON contract
```json
{
  "requested_mode": "SINGLE|PANEL|SUMMARY|CRISIS",
  "requested_persona": "yan|natasha|anya|max|null",
  "safety_class": "none|soft|hard",
  "emotional_intensity": "low|medium|high",
  "needs_escalation": true,
  "confidence": 0.0,
  "reasons": ["SHORT_REASON_CODES_ONLY"]
}
```
- `requested_persona` не используется для summary; summary определяется через `requested_mode=SUMMARY`.
- `additionalProperties=false`.

## 9) Acceptance criteria
- PANEL всегда gpt-5.2.
- SINGLE по умолчанию gpt-5.1, с эскалацией по правилам.
- SUMMARY всегда gpt-5-mini.
- hard-crisis всегда fixed response.
- Output guard блокирует role-токены и URL.
