# BRIEF for Codex — AI Friends Telegram Bot (P0 Growth Instrumentation)

## Role
You are a senior engineer. Implement ONLY the minimum changes for:
1. Referrals via deep links
2. Share button with ref link
3. Analytics event logging (privacy-safe)
4. Admin-only `/stats` command with aggregated metrics

Everything else is explicitly out of scope.

## Codebase context (READ FIRST)

| Aspect | Current state |
|---|---|
| **Language** | TypeScript, ESM modules (`.js` imports), grammy framework |
| **DB** | `better-sqlite3` v9.5.0 already exists. Schema in `src/state/schema.ts:initSchema()`. Store pattern in `src/state/store.ts` (`SqliteStore` class) |
| **DB path** | `process.env.SQLITE_PATH ?? "data/bot.sqlite"` — do NOT introduce `DB_URL` |
| **Session state** | In-memory `Map<string, UserSessionState>` in `src/telegram/uxHandlers.ts` — NOT persisted. Do NOT store persistent data here |
| **Command parsing** | `parseSupportedCommand()` in `src/index.ts` strips payload: `/start ref_X` -> only `/start`. `IncomingEvent` has no `commandPayload` field — you need to add it |
| **Command flow** | `index.ts:toMessageEvent()` -> `uxHandlers.ts:handleEvent()` -> `handleCommand()` |
| **LLM response flow** | `uxHandlers` -> `bot.ts:applyLLMIfNeeded()` -> `llmResponder.ts:generate()` -> back to `bot.ts` -> `index.ts:sendMessages()` |
| **Existing hashing** | `hashUserId()` in `src/index.ts` uses `process.env.TELEMETRY_SALT` — reuse this, do NOT create `USER_ID_HASH_SALT` |
| **Logger** | pino via `src/observability/logger.ts` |
| **Metrics** | In-memory counters in `src/observability/metrics.ts` |
| **Commands registry** | `SUPPORTED_COMMANDS` + `BOT_COMMANDS` in `src/index.ts`, `IncomingEvent.command` union in `uxHandlers.ts` |

## Hard constraints (do not violate)
- Minimal invasive changes: no refactors, no architecture rewrites.
- No new product features besides referral/share/analytics/stats.
- Do NOT store user message texts. Do NOT send raw Telegram user_id to external analytics.
- Analytics transport: stdout logging is always on; optional HTTP forwarding is enabled only when `ANALYTICS_HTTP_ENDPOINT` is set.
- Do NOT add paid infra. Default telemetry transport is stdout JSON logs.
- Do NOT add new dependencies without explicit approval.
- Follow existing conventions: ESM `.js` imports, existing folder structure, `SqliteStore` pattern.

---

## P0.1 — Referral deep links (`/start ref_<code>`)

### What
Support Telegram deep links: `/start ref_<code>`.

### Where to change
1. `src/index.ts:parseSupportedCommand()` — extract payload after `/start`
2. `src/index.ts:toMessageEvent()` — pass payload as new field
3. `src/telegram/uxHandlers.ts:IncomingEvent` — add `commandPayload?: string`
4. `src/telegram/uxHandlers.ts:handleCommand("/start")` — read payload, call referral logic
5. `src/state/schema.ts:initSchema()` — add `users` table
6. New file `src/growth/referral.ts` — referral storage & lookup

### Behavior
- If a NEW user starts with `ref_<code>`:
  - attribute inviter for that user ONCE (do not overwrite later)
  - ignore self-referral
- If the user already exists (has inviter set):
  - ignore new ref codes

### Storage (in SQLite, NOT in-memory)
New table `users`:
```sql
CREATE TABLE IF NOT EXISTS users (
  user_id TEXT PRIMARY KEY,
  inviter_user_id TEXT,
  inviter_code TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL
);
```
- `user_id` — raw Telegram numeric id (string)
- `inviter_user_id` — nullable, set once
- `inviter_code` — random url-safe token, 8–12 chars, generated on first `/start`
- `created_at` — epoch ms

### Collision handling (required)
- `inviter_code` generation must retry on `UNIQUE` collision (e.g., up to 5 attempts).
- If all attempts fail, log WARN and continue safely (no crash).

### Acceptance criteria
- `/start ref_X` attributes inviter once.
- Repeated `/start` does not change inviter.
- Self-referral is a no-op.
- Each user gets a stable `inviter_code` on first interaction.

---

## P0.2 — Share button with inviter ref link

### What
After key LLM outputs, show share UI with Telegram deep link:
`https://t.me/<BOT_USERNAME>?start=ref_<inviter_code>`

### Where to change
1. `src/telegram/keyboard.ts` — add `shareKeyboard(link: string): InlineKeyboard`
2. `src/telegram/bot.ts:applyLLMIfNeeded()` — after message merge, append share prompt as final message. Do NOT modify `llmResponder.ts`.
3. New file `src/growth/share.ts` — link generation helper

### Button contract (Telegram-compatible)
- Inline button `Поделиться ботом` uses `url` (direct deep link).
- Optional second inline button `Получить ссылку` uses `callback_data: "sh"` and returns the link as text.
- Do NOT put `url` and `callback_data` on the same button.

### When to show (ONLY these 4 flows)
- PANEL mode ("Ask all")
- COMPOSE_MESSAGE tool ("Write for me")
- REPLY_TO_MESSAGE tool ("Help reply")
- SUMMARY mode

Detect flow from `result.llmTask.mode` and `result.llmTask.scenario` in `src/telegram/bot.ts`.

### Requirements
- `BOT_USERNAME` from `process.env.BOT_USERNAME`.
- If missing: build degraded placeholder link, log WARN, do NOT crash, do NOT hide other UI.
- Handle `"sh"` callback in `uxHandlers.ts:handleCallback()` — respond with share link text.

### Multi-message handling
If LLM response is split into multiple `OutgoingMessage[]`:
- Content messages stay unchanged.
- Append ONE final message: `Что дальше?` with inline share keyboard.
- Do NOT attach reply keyboard to this final share message (inline and reply keyboards are different Telegram surfaces).

### Acceptance criteria
- Share UI appears after the 4 flows listed above.
- Link contains the user's stable `inviter_code`.
- Clicking link from another account attributes correctly.
- Works even if `BOT_USERNAME` is not set (degraded, with WARN log).

---

## P0.3 — Analytics (privacy-safe, optional HTTP sink)

### Default mode
Write JSON lines to stdout via existing pino logger (one line per event).

### Optional HTTP mode
If `ANALYTICS_HTTP_ENDPOINT` env var is set:
- POST same JSON payload (best-effort, non-blocking via `fetch` with timeout)
- Failures must NOT break bot. Catch all errors (log WARN at most).

### Where to change
- New file `src/observability/analytics.ts` — `emitEvent()` function, event types
- Wire calls in `uxHandlers.ts` (UX events) and `bot.ts`/`index.ts` (LLM events, errors)

### Events
| Event | Where to emit | Extra fields |
|---|---|---|
| `start` | `handleCommand("/start")` | `has_ref_code: boolean` |
| `choose_persona` | `handleCallback("choose_friend:*")` | — |
| `ask_all` | `bot.ts` after PANEL generation | — |
| `tool_write_for_me` | `bot.ts` after COMPOSE generation | — |
| `tool_help_reply` | `bot.ts` after REPLY generation | — |
| `tool_summary` | `bot.ts` after SUMMARY generation | — |
| `share_clicked` | `handleCallback("sh")` | — |
| `model_error` | `bot.ts:applyLLMIfNeeded()` catch block | — |
| `safety_triggered` | `llmResponder.ts` when CRISIS/soft triggers | — |

### Payload fields (all events)
```json
{
  "event": "start",
  "ts": "2026-03-05T08:00:00.000Z",
  "session_id": "<existing state.sessionId>",
  "user_id_hash": "<output of existing hashUserId()>",
  "inviter_present": true
}
```
- `session_id`: use existing `state.sessionId` from `UserSessionState`
- `user_id_hash`: reuse existing `hashUserId()` from `src/index.ts` (uses `TELEMETRY_SALT`)
- NEVER log raw `user_id`

### Acceptance criteria
- Bot works with HTTP analytics disabled.
- No raw user IDs in logs/HTTP payloads.
- Events emitted on each action (best-effort; at-least-once OK).

---

## P0.4 — Admin `/stats` command (add-on)

### What
Admin-only `/stats` showing aggregated metrics from SQLite.

### Where to change
1. `src/index.ts` — add `/stats` to `SUPPORTED_COMMANDS` and `BOT_COMMANDS`
2. `src/telegram/uxHandlers.ts` — add `/stats` to `IncomingEvent.command` union type, add case in `handleCommand()`
3. `src/state/schema.ts` — add `event_daily` table
4. `src/observability/analytics.ts` — add `incEventDaily()` call alongside `emitEvent()`

### Admin gating
- `ADMIN_USER_IDS` env var: comma-separated Telegram user IDs (example: `"123,456"`)
- In `handleCommand("/stats")`: if `userId` not in list -> respond `Недостаточно прав.`
- `userId` comes from `IncomingEvent.userId`, pass through to command handler

### Storage
```sql
CREATE TABLE IF NOT EXISTS event_daily (
  date TEXT NOT NULL,
  event TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (date, event)
);
```
- `date` must be UTC day (`YYYY-MM-DD`).
- `incEventDaily(event_name)`: UPSERT -> insert `(today_utc, event, 1)` or increment count.
- Wire `incEventDaily()` inside `emitEvent()` so each analytics event increments daily aggregate.

### Events to aggregate
`start`, `ask_all`, `tool_write_for_me`, `tool_help_reply`, `tool_summary`, `share_clicked`, `model_error`, `safety_triggered`

### `/stats` output format
```text
📊 Статистика

Сегодня (2026-03-05):
• starts: 12
• ask_all: 8
• tools: write 3 / reply 2 / summary 1
• share_clicked: 4
• model_error: 0
• safety_triggered: 1

7 дней:
• starts: 85
• ask_all: 52
• share_clicked: 28

Конверсии:
• activation today: 66.7% (ask_all/starts)
• share rate today: 50.0% (share/ask_all)
• activation 7d: 61.2%
• share rate 7d: 53.8%

Рефералы:
• всего приглашённых: 14
```
- Handle division by zero: show `—` instead of NaN/Infinity.
- Referral count: `SELECT COUNT(*) FROM users WHERE inviter_user_id IS NOT NULL`.
- `Сегодня` and `7 дней` windows are UTC-based.

### Acceptance criteria
- `/stats` works for admin IDs only.
- Non-admins get `Недостаточно прав.`
- Aggregates increment correctly with each event.
- No raw events with message texts stored.
- Bot behavior unchanged for normal users.

---

## Non-goals (explicitly out of scope)
- No "Fast/Deeper" modes
- No caching, summarization guardrails, retries, rate limiting, healthchecks
- No new onboarding menus or UX changes beyond share UI
- No storing user prompts/messages
- No dependency additions (use existing `better-sqlite3`, `grammy`, `pino`)

---

## Environment variables

| Var | Required | Notes |
|---|---|---|
| `BOT_TOKEN` | ✅ | Existing |
| `OPENAI_API_KEY` | ✅ | Existing |
| `TELEMETRY_SALT` | ✅ | Existing. Used for `user_id_hash` |
| `SQLITE_PATH` | ❌ | Existing. Default `data/bot.sqlite` |
| `BOT_USERNAME` | ❌ | For share links. Degraded mode without it |
| `ANALYTICS_HTTP_ENDPOINT` | ❌ | Optional HTTP analytics sink |
| `ADMIN_USER_IDS` | ❌ | Comma-separated Telegram IDs for `/stats` |

---

## Deliverables
1. Code changes implementing P0.1–P0.4 with minimal edits
2. Schema additions in `src/state/schema.ts` (no separate migration files)
3. README update: new env vars, how to test referrals, example stdout event
4. Smoke test instructions:
   - `/start ref_<code>` -> check inviter attributed
   - Run ask_all -> verify share UI + analytics event in stdout
   - `/stats` -> verify counts

---

## Implementation guidance (strict)
- Follow existing project conventions (TypeScript ESM, `.js` imports, folder structure).
- Reuse `SqliteStore` DB instance — do NOT open a second connection. Pass store/DB to new modules.
- New files: `src/growth/referral.ts`, `src/growth/share.ts`, `src/observability/analytics.ts`
- Keep handlers thin; helpers for link generation and event emit.
- `callback_data` for copy-link button: `"sh"` (within Telegram 64-byte limit).
- All new functions must be unit-testable (no side effects in constructors).
