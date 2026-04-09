# Daily Reminder — Implementation Brief

## Goal

Send **one reminder per day** to users who haven't interacted with the bot in the last 24 hours.
Reminder text is static. User can opt out via `/settings`.

Architecture: **Railway Cron service** (separate service in the same repo) triggers an HTTP endpoint on the bot. Bot handles all DB + Telegram logic.

---

## 1. DB Migration

File: `src/state/schema.ts`

Add two columns to `user_balance` table. Use `ALTER TABLE` with try/catch or `IF NOT EXISTS`-safe pattern (SQLite doesn't support `IF NOT EXISTS` for columns — use a helper that catches "duplicate column" errors silently).

```sql
ALTER TABLE user_balance ADD COLUMN last_reminder_sent_at INTEGER;
ALTER TABLE user_balance ADD COLUMN reminders_enabled INTEGER NOT NULL DEFAULT 1;
```

Create a new function `migrateSchema(db)` called after `initSchema(db)` in the same file. It should run each ALTER TABLE in a try/catch, ignoring "duplicate column name" errors. This is idempotent — safe to run on every startup.

---

## 2. ReminderHandler

File: `src/scheduler/reminderHandler.ts`

### Interface

```ts
import type Database from "better-sqlite3";
import type { Bot } from "grammy";
import type { createLogger } from "../observability/logger.js";

export interface ReminderHandlerDeps {
  db: Database;
  bot: Bot;
  logger: ReturnType<typeof createLogger>;
  inactivityThresholdMs?: number; // default: 24 * 60 * 60 * 1000
}

export interface ReminderResult {
  sent: number;
  skipped: number;
  failed: number;
  disabled: number;
}

export async function processReminders(deps: ReminderHandlerDeps): Promise<ReminderResult>;
```

### Query to find inactive users

```sql
SELECT ub.user_id
FROM user_balance ub
JOIN (
  SELECT user_id, MAX(last_activity_at) AS last_active
  FROM sessions
  GROUP BY user_id
) s ON s.user_id = ub.user_id
WHERE s.last_active < ?                           -- inactive threshold (now - 24h)
  AND ub.reminders_enabled = 1
  AND (ub.last_reminder_sent_at IS NULL OR ub.last_reminder_sent_at < ?)  -- not sent today
```

The second `?` should be the start of the current UTC day (`new Date().setUTCHours(0,0,0,0)`), so we send at most once per calendar day.

### Reminder text

```
Есть что обсудить? Друзья ждут — просто напиши 💬

Отключить напоминания: /settings
```

Hardcode this as a constant `REMINDER_TEXT` at the top of the file.

### Send logic

For each user_id from the query:

1. Call `bot.api.sendMessage(userId, REMINDER_TEXT)`.
2. On success → update `last_reminder_sent_at = Date.now()` in `user_balance`.
3. On error:
   - If error description contains `"bot was blocked"` OR `"user is deactivated"` OR `"chat not found"` OR HTTP 403 → set `reminders_enabled = 0` for that user. Increment `disabled` counter.
   - Otherwise → log warning, increment `failed` counter. Do NOT disable reminders (transient error).
4. **Rate limit:** wait 50ms between sends (`await sleep(50)`) to stay under Telegram's 30 msg/sec limit.

### Logging

- At start: log `reminder_check_started` with timestamp.
- At end: log `reminder_check_completed` with `{ sent, skipped, failed, disabled }`.
- Each individual error: log warning with userId hash (use `hashUserId`) and error message.

---

## 3. HTTP Endpoint in Bot

File: `src/index.ts`

### Refactor the HTTP server routing

Currently `startTributeWebhookServer` creates a server that only handles `TRIBUTE_WEBHOOK_PATH`. Refactor the `createServer` callback to route between multiple paths:

```ts
const REMINDER_TRIGGER_PATH = "/api/reminders/trigger";

const server = createServer((req, res) => {
  const urlPath = req.url?.split("?")[0];
  if (urlPath === TRIBUTE_WEBHOOK_PATH) {
    void handleTributeWebhookRequest(req, res, input);
  } else if (urlPath === REMINDER_TRIGGER_PATH && req.method === "POST") {
    void handleReminderTrigger(req, res, input);
  } else {
    writeJson(res, 404, { error: "not found" });
  }
});
```

Remove the 404 check from inside `handleTributeWebhookRequest` (it's now handled by the router above). Keep the method check inside `handleTributeWebhookRequest`.

### `handleReminderTrigger` function

```ts
async function handleReminderTrigger(
  req: IncomingMessage,
  res: ServerResponse,
  input: { bot: Bot; store: SqliteStore; logger: ReturnType<typeof createLogger> }
): Promise<void> {
  // 1. Auth check
  const authHeader = req.headers["authorization"];
  const expectedToken = process.env.REMINDER_SECRET;
  if (!expectedToken || authHeader !== `Bearer ${expectedToken}`) {
    writeJson(res, 401, { error: "unauthorized" });
    return;
  }

  // 2. Run reminders
  try {
    const result = await processReminders({
      db: input.store.getDb(),
      bot: input.bot,
      logger: input.logger
    });
    writeJson(res, 200, { ok: true, ...result });
  } catch (error) {
    input.logger.error(/* ... */);
    writeJson(res, 500, { error: "internal error" });
  }
}
```

### Update `startTributeWebhookServer`

Rename to `startWebhookServer` (it now serves multiple endpoints). Update the signature to also accept `bot: Bot` directly (currently it's inside the input object — keep as-is, just add `reminderSecret` awareness). The existing input object already has `bot`, `store`, `logger` — no changes needed there.

Also: the webhook server must start even if billing is not configured. Currently it only starts if `billingConfig.tributeApiSecret` is truthy. Change the condition:

```ts
// OLD:
if (billingConfig.tributeApiSecret) {
  webhookServer = await startTributeWebhookServer({ ... });
}

// NEW:
const shouldStartWebhookServer = billingConfig.tributeApiSecret || process.env.REMINDER_SECRET;
if (shouldStartWebhookServer) {
  webhookServer = await startWebhookServer({ ... });
}
```

---

## 4. Settings: Opt-out Toggle

### Keyboard

File: `src/telegram/keyboard.ts`

Add a new function:

```ts
export function settingsKeyboardWithReminders(remindersEnabled: boolean): InlineKeyboard {
  return [
    [{ text: "🔒 Приватность", data: "settings_privacy" }],
    [{ text: "🎭 Демо", data: "settings_demo" }],
    [{ text: remindersEnabled ? "🔔 Напоминания: вкл" : "🔕 Напоминания: выкл", data: "settings_toggle_reminders" }],
    [{ text: "🔄 Сбросить сессию", data: "settings_reset" }],
    [{ text: "🧹 Забыть всё", data: "settings_forget" }]
  ];
}
```

DO NOT change `settingsKeyboard()` — keep it as-is for backward compatibility. Use the new function where the balance store is available.

### UXHandlers

File: `src/telegram/uxHandlers.ts`

**Constructor:** `UXHandlers` already receives `balanceStore` in its options. No change needed.

**`/settings` command handler:** Change to use `settingsKeyboardWithReminders`:

```ts
case "/settings": {
  const remindersEnabled = this.balanceStore
    ? this.getRemindersEnabled(userId)
    : true;
  return {
    messages: [{ text: SETTINGS_TEXT, keyboard: settingsKeyboardWithReminders(remindersEnabled), replyKeyboard: mainReplyKeyboard() }]
  };
}
```

Add private helper:

```ts
private getRemindersEnabled(userId: string): boolean {
  if (!this.balanceStore) return true;
  const db = this.balanceStore.getDb?.();
  if (!db) return true;
  const row = db.prepare<[string], { reminders_enabled: number }>(
    "SELECT reminders_enabled FROM user_balance WHERE user_id = ?"
  ).get(userId);
  return row?.reminders_enabled !== 0;
}
```

Wait — `BalanceStore` doesn't expose `getDb()`. Instead, add a method to `BalanceStore`:

File: `src/billing/balanceStore.ts`

```ts
getRemindersEnabled(userId: string): boolean {
  const row = this.db
    .prepare<[string], { reminders_enabled: number }>(
      "SELECT reminders_enabled FROM user_balance WHERE user_id = ?"
    )
    .get(userId);
  return row?.reminders_enabled !== 0;
}

setRemindersEnabled(userId: string, enabled: boolean): void {
  this.db
    .prepare<[number, number, string]>(
      "UPDATE user_balance SET reminders_enabled = ?, updated_at = ? WHERE user_id = ?"
    )
    .run(enabled ? 1 : 0, Date.now(), userId);
}
```

**Callback handler for toggle:** in `handleCallbackQuery`:

```ts
if (callbackData === "settings_toggle_reminders") {
  if (this.balanceStore) {
    const current = this.balanceStore.getRemindersEnabled(userId);
    this.balanceStore.setRemindersEnabled(userId, !current);
    const newState = !current;
    return {
      messages: [{
        text: newState
          ? "🔔 Напоминания включены."
          : "🔕 Напоминания отключены.",
        keyboard: settingsKeyboardWithReminders(newState),
        replyKeyboard: mainReplyKeyboard()
      }]
    };
  }
  return { messages: [{ text: "Настройка недоступна.", replyKeyboard: mainReplyKeyboard() }] };
}
```

Also update the quick action "настройки" handler to use the new keyboard the same way as `/settings`.

---

## 5. Cron Trigger Script

File: `src/reminderTrigger.ts`

Minimal standalone script — Railway Cron runs it, it calls the bot endpoint, exits.

```ts
async function main(): Promise<void> {
  const botUrl = process.env.BOT_INTERNAL_URL;
  const secret = process.env.REMINDER_SECRET;

  if (!botUrl || !secret) {
    console.error("BOT_INTERNAL_URL and REMINDER_SECRET are required");
    process.exit(1);
  }

  const url = `${botUrl}/api/reminders/trigger`;
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${secret}` }
  });

  const body = await res.json();
  console.log(`Reminder trigger response: ${res.status}`, body);

  if (!res.ok) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

This file must be compiled and its output used as Railway Cron entry point.

**Add to `package.json` scripts** (if helpful):

```json
"reminder:trigger": "tsx src/reminderTrigger.ts"
```

---

## 6. Environment Variables

### Bot service (`.env`, `.env.test`, `.env.example`)

```
REMINDER_SECRET=<random-secret-string>
```

### Cron service (Railway Dashboard → Cron service → Variables)

```
BOT_INTERNAL_URL=http://<bot-service-internal-hostname>:<port>
REMINDER_SECRET=<same-secret-string>
```

### `.env.example` — add:

```
# Daily reminders
REMINDER_SECRET=
```

### `.env.test` — add:

```
REMINDER_SECRET=test-reminder-secret
```

---

## 7. Tests

File: `tests/scheduler/reminderHandler.test.ts`

### Test 1: sends reminder to inactive user
- Create a user in `user_balance` with `reminders_enabled = 1`.
- Create a session with `last_activity_at` = 25 hours ago.
- Mock `bot.api.sendMessage`.
- Call `processReminders`.
- Assert `sendMessage` called with correct userId and `REMINDER_TEXT`.
- Assert `last_reminder_sent_at` updated in DB.
- Assert result `{ sent: 1, skipped: 0, failed: 0, disabled: 0 }`.

### Test 2: skips active user
- Session with `last_activity_at` = 2 hours ago.
- Assert `sendMessage` NOT called.
- Assert result `{ sent: 0, skipped: 0, failed: 0, disabled: 0 }` (user simply not in query).

### Test 3: skips user with reminders disabled
- `reminders_enabled = 0`.
- Session with `last_activity_at` = 25 hours ago.
- Assert `sendMessage` NOT called.

### Test 4: skips user already reminded today
- `last_reminder_sent_at` = 1 hour ago (today).
- Session with `last_activity_at` = 25 hours ago.
- Assert `sendMessage` NOT called.

### Test 5: disables reminders on blocked user
- Mock `sendMessage` to throw error with description "Forbidden: bot was blocked by the user".
- Assert `reminders_enabled` set to 0 in DB.
- Assert result `disabled: 1`.

### Test 6: does not disable on transient error
- Mock `sendMessage` to throw generic error.
- Assert `reminders_enabled` still 1.
- Assert result `failed: 1`.

File: `tests/telegram/stateMachine.test.ts`

### Test 7: settings_toggle_reminders toggles state
- Call handleEvent with `callbackData: "settings_toggle_reminders"`.
- Assert response text contains "отключены".
- Call again → assert "включены".

File: `tests/billing/balanceStore.test.ts` (or existing test file)

### Test 8: getRemindersEnabled / setRemindersEnabled
- `ensureBalance(userId)` → `getRemindersEnabled` returns true (default).
- `setRemindersEnabled(userId, false)` → `getRemindersEnabled` returns false.
- `setRemindersEnabled(userId, true)` → `getRemindersEnabled` returns true.

---

## 8. What NOT to Change

- DO NOT add new npm dependencies.
- DO NOT change existing keyboard functions (keep `settingsKeyboard()` as-is).
- DO NOT change Tribute webhook logic.
- DO NOT change billing/balance deduction logic.
- DO NOT change LLM/prompt logic.
- DO NOT change session timeout or session creation logic.
- DO NOT use LLM to generate reminder text (static only).
- DO NOT change the existing `handleTributeWebhookRequest` function signature — only remove the 404 path check from it since routing is now handled by the parent.

---

## 9. Railway Cron Setup (Manual — NOT code)

After code is deployed:

1. Railway Dashboard → Project → **+ New Service** → connect same GitHub repo.
2. Service name: `reminder-cron`.
3. Settings:
   - **Start Command:** `npx tsx src/reminderTrigger.ts`
   - **Cron Schedule:** `0 18 * * *` (18:00 UTC = 21:00 MSK daily)
4. Variables:
   - `BOT_INTERNAL_URL` = internal URL of bot service (from Railway networking)
   - `REMINDER_SECRET` = same value as in bot service
5. That's it. Railway runs the script daily at 21:00 MSK, it hits the bot endpoint, bot sends reminders.

---

## 10. Verification

```bash
# Unit tests
npm test

# Smoke test (local, with test bot):
# 1. Set REMINDER_SECRET=test-reminder-secret in .env.test
# 2. Start bot: env $(cat .env.test | grep -v '^#' | grep -v '^$' | xargs) npx tsx src/index.ts
# 3. Trigger manually:
curl -X POST http://localhost:3101/api/reminders/trigger \
  -H "Authorization: Bearer test-reminder-secret"
# 4. Check response: { "ok": true, "sent": N, "skipped": 0, "failed": 0, "disabled": 0 }
# 5. Check test bot — should receive reminder message
# 6. Trigger again → sent should be 0 (already reminded today)
# 7. Test auth: curl without header → 401
```

---

## Summary of files to create/modify

| Action | File |
|--------|------|
| MODIFY | `src/state/schema.ts` — add `migrateSchema()` with ALTER TABLEs |
| CREATE | `src/scheduler/reminderHandler.ts` — query + send + update logic |
| CREATE | `src/reminderTrigger.ts` — cron entry point (fetch + exit) |
| MODIFY | `src/index.ts` — refactor HTTP routing, add reminder endpoint, start server unconditionally |
| MODIFY | `src/billing/balanceStore.ts` — add `getRemindersEnabled()` + `setRemindersEnabled()` |
| MODIFY | `src/telegram/keyboard.ts` — add `settingsKeyboardWithReminders()` |
| MODIFY | `src/telegram/uxHandlers.ts` — `/settings` uses new keyboard, add `settings_toggle_reminders` callback |
| MODIFY | `.env.example` — add `REMINDER_SECRET` |
| CREATE | `tests/scheduler/reminderHandler.test.ts` — 6 tests |
| MODIFY | `tests/telegram/stateMachine.test.ts` — 1 test for toggle |
