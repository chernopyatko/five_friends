# Codex Brief v3 Final: Monetization — Message Balance + Tribute Integration

## Goal
Add a per-user message balance system. New users get 15 free messages (lazy init on first billable request). When balance is insufficient, show a paywall with Tribute package links. Tribute webhook credits balance after successful purchase. Admin and whitelisted users have unlimited access.

## Architecture Decisions
- Single counter per user: `balance`
- Cost: `PANEL = 3`, all other modes = `1`
- Safety/crisis responses are non-billable and are controlled by explicit responder flag `billable: false`
- One-time packages only: 50/299₽, 150/599₽, 350/999₽
- Balance is per-user, persisted in DB
- Bypass = `ADMIN_USER_IDS ∪ BYPASS_BALANCE_USER_IDS`
- Webhook idempotency via UNIQUE constraint on `balance_transactions.tribute_order_id`
- Lazy trial initialization (`ensureBalance`) in billing gate
- Graceful degradation:
  - if billing config incomplete: paywall disabled, unlimited access, startup warning
  - webhook server starts only when `TRIBUTE_API_SECRET` is set; if started but config incomplete -> `503`
- Single schema source: only `initSchema()`
- Webhook lifecycle: start before polling, close on SIGTERM with bot/db
- **UX texts source of truth**: `COPY.md` section 14. All user-facing monetization strings (paywall, nudge, footer, /balance, grace message, purchase confirmation) MUST match that section.
- Grace message: when balance reaches 0 after deduction, send grace message with purchase buttons instead of hard-blocking immediately. Hard paywall on the *next* request.

## Implementation

### 1. Schema (`src/state/schema.ts`)
Add:
```sql
CREATE TABLE IF NOT EXISTS user_balance (
  user_id TEXT PRIMARY KEY,
  balance INTEGER NOT NULL DEFAULT 15,
  total_purchased INTEGER NOT NULL DEFAULT 0,
  total_spent INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS balance_transactions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  amount INTEGER NOT NULL,
  reason TEXT NOT NULL,
  tribute_order_id TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS balance_tx_user_idx
  ON balance_transactions(user_id);
CREATE INDEX IF NOT EXISTS balance_tx_created_idx
  ON balance_transactions(created_at);
CREATE UNIQUE INDEX IF NOT EXISTS balance_tx_order_id_uniq
  ON balance_transactions(tribute_order_id)
  WHERE tribute_order_id IS NOT NULL;
```

### 2. New file `src/billing/costs.ts`
```ts
import type { BotMode } from "../llm/schemas.js";

export function resolveMessageCost(mode: BotMode): number {
  return mode === "PANEL" ? 3 : 1;
}
```

### 3. New file `src/billing/balanceStore.ts`
Create `BalanceStore` with methods:
- `ensureBalance(userId, initialBalance=15)`
- `getBalance(userId)`
- `deductBalance(userId, amount, reason)` with guard `amount > 0`
- `addBalance(userId, amount, reason, tributeOrderId?)` with guard `amount > 0`, idempotency by UNIQUE catch
- `getBalanceInfo(userId)`

`addBalance` idempotency catch must be specific:
```ts
try {
  insertTx.run(randomUUID(), userId, amount, reason, tributeOrderId ?? null, Date.now());
} catch (err: unknown) {
  if (
    err instanceof Error &&
    err.message.includes("UNIQUE constraint failed: balance_transactions.tribute_order_id")
  ) {
    return { credited: false };
  }
  throw err;
}
```

### 4. New file `src/billing/tributeWebhook.ts`
- `verifyTributeSignature()` with `timingSafeEqual`, accepts both `hex` and `sha256=hex`
- `loadProductMap()` with safe JSON parse
- strict `parseTributeWebhookEvent()`:
  - accept only non-empty string or finite number for `telegram_id`, `product.id`, `order_id`
  - reject objects/empty strings/NaN

### 5. New file `src/billing/config.ts`
`loadBillingConfig()`:
- reads `TRIBUTE_API_SECRET`, links, product map
- validates URLs
- outputs `{ tributeApiSecret, tributeLinks, productMap, isConfigured }`

### 6. `src/telegram/bot.ts`
#### 6a. Update responder contract
```ts
export interface GenerateResult {
  messages: OutgoingMessage[];
  billable: boolean;
}

export interface LLMResponder {
  generate(input: { userId: string; task: LLMTask; state: UserSessionState }): Promise<GenerateResult>;
  clearLongTerm?(userId: string): Promise<void> | void;
  resetSession?(input: { userId: string; previousSessionId: string; newSessionId: string }): Promise<void> | void;
}
```

#### 6b. Add runtime options/fields
- `balanceStore?: BalanceStore`
- `bypassBalanceUserIds?: Set<string>`
- `billingConfig?: BillingConfig`

#### 6c. `applyLLMIfNeeded()` behavior
- Compute once:
```ts
const isBypass = !this.billingConfigured || this.bypassBalanceUserIds.has(event.userId);
```
- Balance gate before responder call:
  - `ensureBalance()`
  - check cost; if insufficient, show paywall (see `COPY.md` section 14 "Paywall"):
    ```ts
    // Hard paywall text (COPY.md section 14)
    const paywallText = "Друзья на паузе ☕\n\nБесплатные разговоры закончились. Пополни баланс, чтобы продолжить — ребята ждут.";
    ```
- Use new responder return:
```ts
const generation = await this.responder.generate(...);
const generatedMessages = generation.messages;
```
- Post-generation logic for billable only:
```ts
if (generation.billable) {
  const postGenerationEvent = resolvePostGenerationEvent(result.llmTask);
  if (postGenerationEvent) this.analytics?.emitEvent(...);
}

if (!isBypass && this.balanceStore && result.llmTask && generation.billable) {
  const cost = resolveMessageCost(result.llmTask.mode);
  this.balanceStore.deductBalance(event.userId, cost, result.llmTask.mode);
  const newBalance = this.balanceStore.getBalance(event.userId);

  // Grace message: balance just hit 0 after this deduction
  if (newBalance === 0) {
    // Append grace message (see COPY.md section 14 "Grace message")
    mergedMessages.push({
      text: "💬 Это было последнее сообщение. Чтобы продолжить разбираться вместе — пополни баланс:",
      keyboard: paywallKeyboard(this.billingConfig.tributeLinks)
    });
  } else if (newBalance <= 3) {
    // Soft nudge footer (see COPY.md section 14 "Soft nudge")
    const lastMsg = mergedMessages[mergedMessages.length - 1];
    if (lastMsg) {
      lastMsg.text += `\n\n💬 Осталось ${newBalance} — пополни, чтобы ребята были на связи.`;
    }
  } else if (newBalance <= 10) {
    // Balance footer (see COPY.md section 14 "Balance footer")
    const lastMsg = mergedMessages[mergedMessages.length - 1];
    if (lastMsg) {
      lastMsg.text += `\n\n💬 Баланс: ${newBalance}`;
    }
  }
}

const withShare = generation.billable
  ? this.appendShareMessageIfNeeded(result.llmTask, event.userId, mergedMessages)
  : mergedMessages;

return { ...result, messages: withShare };
```

### 7. `src/runtime/llmResponder.ts`
Return `GenerateResult` from all branches:
- hard/soft/crisis/fallback persona-missing -> `billable: false`
- normal generated response -> `billable: true`

### 8. `src/telegram/keyboard.ts`
Add:
- `paywallKeyboard()`
- `lowBalanceKeyboard()`
- `balanceInfoKeyboard()`
Use single canonical `TributeLinks` type (recommended source: `src/billing/config.ts`).

### 9. `src/telegram/uxHandlers.ts`
- Add `/balance` to command union and switch
- Inject `balanceStore`, `billingConfig`, `bypassBalanceUserIds`
- `/balance` logic (UX texts: see `COPY.md` section 14):
```ts
if (this.bypassBalanceUserIds.has(userId)) {
  return { messages: [{ text: "💬 У тебя безлимитный доступ ♾️" }] };
}
if (!this.billingConfig?.isConfigured) {
  return { messages: [{ text: "💬 Сейчас все разговоры бесплатны." }] };
}
if (!this.balanceStore) {
  return { messages: [{ text: "💬 Сейчас все разговоры бесплатны." }] };
}
this.balanceStore.ensureBalance(userId);
const info = this.balanceStore.getBalanceInfo(userId);
return {
  messages: [{
    text:
      `💬 Баланс: ${info.balance}\n` +
      `📊 Использовано: ${info.totalSpent}\n\n` +
      `Пополнить:`,
    keyboard: balanceInfoKeyboard(this.billingConfig.tributeLinks)
  }]
};
```
- Extend `/stats` output with `paywall_shown`, `purchase_completed`

### 10. `src/observability/analytics.ts`
- Extend `AnalyticsEventName` with:
  - `paywall_shown`
  - `purchase_completed`
- Extend `StatsSnapshot.today` with:
  - `paywallShown`
  - `purchaseCompleted`
- Fill in `getStatsSnapshot()` queries

### 11. `src/index.ts`
- Add `/balance` to `SUPPORTED_COMMANDS` and `BOT_COMMANDS`
- Create `balanceStore` + `billingConfig`
- Merge bypass sets from `ADMIN_USER_IDS` and `BYPASS_BALANCE_USER_IDS`
- Pass billing deps into `UXHandlers` and `BotRuntime`
- Keep convenience init on `/start`: `balanceStore.ensureBalance(event.userId)`
- Webhook server:
  - start only if `TRIBUTE_API_SECRET` exists
  - `POST /api/tribute/webhook`
  - max body 64KB -> `413`
  - if `!billingConfig.isConfigured` -> `503`
  - invalid signature -> `401`
  - unknown event/product -> `200` + log
  - duplicate order -> `{ credited:false }`, `200`
  - successful purchase -> credit, notify user (see `COPY.md` section 14 "Уведомление о зачислении": `✅ Баланс пополнен! +{amount} сообщений\n💬 Баланс: {newBalance}`), emit `purchase_completed`
- Shutdown: `webhookServer?.close()` in signal handler

### 12. Tests
Add:
- `tests/billing/costs.test.ts`
- `tests/billing/balanceStore.test.ts`
- `tests/billing/tributeWebhook.test.ts`
- `tests/billing/config.test.ts`

Update:
- `tests/telegram/botRuntime.test.ts` for `GenerateResult` and new billing cases
- `tests/index.test.ts` for `/balance` command parsing

## /balance Touchpoints
- `src/index.ts`: `SUPPORTED_COMMANDS`, `BOT_COMMANDS`
- `src/telegram/uxHandlers.ts`: command union + `case "/balance"`
- `tests/index.test.ts`: `parseSupportedCommand("/balance")`

## Env Vars
- `BYPASS_BALANCE_USER_IDS` (optional)
- `ADMIN_USER_IDS` (optional; now also bypass)
- `TRIBUTE_API_SECRET` (billing webhook secret)
- `TRIBUTE_LINK_SMALL`, `TRIBUTE_LINK_MEDIUM`, `TRIBUTE_LINK_LARGE`
- `TRIBUTE_PRODUCT_MAP`
- `WEBHOOK_PORT` (default `3100`)

## What NOT To Do
- Do not modify `src/state/session.ts`
- No new npm dependencies
- Do not change prompt/generator/policy logic (except `llmResponder` return shape)
- No separate `initBalanceSchema()`
- Do not send URL buttons with empty URL
- Do not infer safety by keyboard button data
- Do not use pre-SELECT for idempotency

## Definition of Done
1. New user sends any message -> gets 15 free messages via lazy init
2. Deduction by mode after billable response (`1`/`3`)
3. `billable:false` safety/crisis -> no deduction
4. Balance footer (`💬 Баланс: N`) shown when balance ≤ 10 after billable response (except bypass)
5. Balance 0 before LLM call -> hard paywall ("Друзья на паузе ☕"), no LLM call
5a. Balance reaches 0 *after* deduction -> grace message with purchase buttons (not hard block)
6. Balance <=3 -> soft nudge ("Осталось N — пополни, чтобы ребята были на связи.")
7. `/balance`: regular+configured -> `💬 Баланс: N` + buy buttons; not configured -> "Сейчас все разговоры бесплатны."; bypass -> "У тебя безлимитный доступ ♾️"
7a. All user-facing monetization texts MUST match `COPY.md` section 14
8. Bypass users -> no checks/deductions/footer/nudges
9. Billing incomplete with secret -> webhook `503`, gate disabled, unlimited, startup warning
10. No secret -> no webhook server, gate disabled, unlimited
11. Valid webhook + known product -> credit + user notification
12. Duplicate `order_id` -> specific `balance_transactions.tribute_order_id` UNIQUE catch, `{ credited:false }`, `200`, no credit; other UNIQUE errors rethrow
13. Unknown event/product -> `200`, log, no credit
14. Invalid signature -> `401`
15. Body >64KB -> `413`
16. `/stats` includes `paywall_shown`, `purchase_completed`
17. Webhook closes on SIGTERM with bot/db
18. `billable:false` responses do not emit `tool_*`/`ask_all` and do not append share message
19. `parseTributeWebhookEvent` rejects invalid non-string/non-finite fields
20. New and updated tests cover behavior, including `GenerateResult`
21. `npm test` passes
22. `npm run lint` passes
23. Integration test with real Tribute webhook validates signature/payload assumptions

---

# Appendix: Launch Precautions

## 1. Killswitch требует рестарта

`loadBillingConfig()` вызывается один раз в `main()`. Изменение `TRIBUTE_*` env vars без рестарта процесса не подхватится.

**Действие**: в порядке запуска явно указать:

> Killswitch = убрать/изменить `TRIBUTE_*` env vars **+ restart процесса** (redeploy или `pm2 restart` / `systemctl restart`). Не мгновенное, но занимает < 30 секунд.

**Опционально на будущее**: hot-reload config по SIGHUP или по admin-команде (не для MVP).

## 2. Матрица проверки webhook

| # | Условие | Команда | Ожидаемый результат |
|---|---|---|---|
| A | `TRIBUTE_API_SECRET` пуст | `curl -X POST https://<domain>:3100/api/tribute/webhook` | Connection refused (сервер не поднят) |
| B | Secret есть, billing incomplete | `curl -X POST -H "trbt-signature: test" -d '{}' https://<domain>:3100/api/tribute/webhook` | **503** `billing not configured` |
| C | Billing complete, подпись неверная | `curl -X POST -H "trbt-signature: badhex" -d '{}' https://<domain>:3100/api/tribute/webhook` | **401** `invalid signature` |
| D | Billing complete, подпись верная, unknown event | `curl` с валидной HMAC, `event_type: "test"` | **200** OK, лог `tribute_webhook_ignored` |
| E | Billing complete, подпись верная, known product | Тест-покупка через Tribute | **200** OK, баланс начислен, юзер уведомлён |

**Действие**: добавить этот чеклист в DoD как пункт 24:

> 24. Pre-launch webhook verification: пройти все 5 строк матрицы (A–E), зафиксировать результаты.

## 3. Recovery runbook: "Оплатил, не начислилось"

Минимальный SQL-плейбук для инцидента:

```sql
-- 1. Проверить: есть ли webhook event в логах?
-- Искать в stdout/pino: outcome=tribute_webhook_*

-- 2. Проверить: есть ли транзакция по order_id?
SELECT * FROM balance_transactions WHERE tribute_order_id = '<ORDER_ID>';

-- 3. Если транзакции нет — ручное начисление:
INSERT INTO balance_transactions (id, user_id, amount, reason, tribute_order_id, created_at)
VALUES (
  lower(hex(randomblob(16))),
  '<USER_TELEGRAM_ID>',
  50,
  'manual_grant',
  '<ORDER_ID>',
  unixepoch() * 1000
);

UPDATE user_balance
SET balance = balance + 50,
    total_purchased = total_purchased + 50,
    updated_at = unixepoch() * 1000
WHERE user_id = '<USER_TELEGRAM_ID>';

-- 4. Проверить результат:
SELECT * FROM user_balance WHERE user_id = '<USER_TELEGRAM_ID>';
```

**Критично**: всегда заполнять `tribute_order_id` при ручном гранте, чтобы повторный webhook (если дойдёт позже) не начислил дважды.

**Действие**: добавить runbook в `docs/RECOVERY.md` или README. Добавить в DoD:

> 25. Recovery runbook для "оплатил, не начислилось" задокументирован и протестирован на dev-базе.

## 4. Операционные webhook-события в аналитику

Сейчас в аналитику идут только `paywall_shown` и `purchase_completed`. Webhook-инциденты логируются через pino, но не считаются в `/stats`.

**Действие**: не добавлять их в `AnalyticsEventName`, вместо этого:

- логировать structured `outcome` во всех webhook-путях:
  - `tribute_webhook_invalid_signature`
  - `tribute_webhook_unparseable`
  - `tribute_webhook_duplicate`
  - `tribute_webhook_unknown_product`
  - `tribute_webhook_billing_incomplete`
  - `tribute_webhook_error`
- добавить в DoD:

> 26. Все webhook-пути (success + error) логируют structured event с уникальным `outcome` через pino. Grep-able для мониторинга.

**На будущее**: при необходимости парсить эти логи в Loki/Grafana.

## 5. Canary rollout

| Шаг | Действие | Кто под монетизацией |
|---|---|---|
| 1 | Деплой кода + пустые `TRIBUTE_*` | Никто (безлимит для всех) |
| 2 | Настроить Tribute, добавить env vars | Никто (bypass = все текущие юзеры) |
| 3 | Создать 1-2 тестовых Telegram-аккаунта, НЕ в bypass | Только тестовые аккаунты |
| 4 | Прогнать цикл: 15 free → paywall → покупка → баланс | Только тестовые аккаунты |
| 5 | Пройти webhook-матрицу (п.2) | — |
| 6 | Пройти recovery runbook на dev (п.3) | — |
| 7 | Canary 2-3 дня | Новые юзеры (не в bypass) |
| 8 | Мониторить: `paywall_shown`, `purchase_completed`, webhook логи | — |
| 9 | Если всё ок — rollout complete | Все кроме bypass |

**Действие**: добавить в DoD:

> 27. Canary: монетизация протестирована на тестовых аккаунтах (шаги 3-6) перед открытием для новых юзеров.

## Обновлённый DoD (пункты 24-27)

```text
24. Pre-launch webhook matrix (A–E) пройдена и зафиксирована.
25. Recovery runbook задокументирован и протестирован на dev-базе.
26. Все webhook-пути логируют structured pino event с уникальным `outcome`.
27. Canary: монетизация протестирована на тестовых аккаунтах перед открытием для новых юзеров.
```
