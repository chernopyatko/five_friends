# Recovery Runbook: «Оплатил, не начислилось»

## Диагностика

### 1. Проверить webhook-логи
Искать в stdout/pino по `outcome`:
```bash
grep "tribute_webhook" /path/to/logs | grep "<ORDER_ID>"
```

Возможные outcome:
- `tribute_webhook_success` — всё ок, баланс начислен
- `tribute_webhook_duplicate` — повторный webhook, уже начислено ранее
- `tribute_webhook_invalid_signature` — подпись не прошла
- `tribute_webhook_unknown_product` — неизвестный product_id
- `tribute_webhook_billing_incomplete` — billing не настроен (503)
- `tribute_webhook_unparseable` — невалидный JSON
- `tribute_webhook_notify_failed` — начислено, но уведомление не отправлено
- `tribute_webhook_error` — необработанная ошибка

### 2. Проверить транзакцию в БД
```sql
SELECT * FROM balance_transactions WHERE tribute_order_id = '<ORDER_ID>';
```

### 3. Проверить баланс пользователя
```sql
SELECT * FROM user_balance WHERE user_id = '<USER_TELEGRAM_ID>';
```

## Ручное начисление

Если транзакции нет — начислить вручную.

**Перед ручным начислением:**

1. Проверить, что транзакции с таким `tribute_order_id` ещё нет:
```sql
SELECT COUNT(*) FROM balance_transactions WHERE tribute_order_id = '<ORDER_ID>';
```
Если возвращает > 0 — не начислять, уже есть в базе.

2. Проверить фактическую сумму и статус платежа в панели Tribute.

3. Сделать бэкап базы данных перед выполнением (рекомендуется).

**Начисление** (заменить `<AMOUNT>` на реальную сумму сообщений из пакета):

```sql
BEGIN TRANSACTION;

INSERT INTO balance_transactions (id, user_id, amount, reason, tribute_order_id, created_at)
VALUES (
  lower(hex(randomblob(16))),
  '<USER_TELEGRAM_ID>',
  <AMOUNT>,
  'manual_grant',
  '<ORDER_ID>',
  unixepoch() * 1000
);

UPDATE user_balance
SET balance = balance + <AMOUNT>,
    total_purchased = total_purchased + <AMOUNT>,
    updated_at = unixepoch() * 1000
WHERE user_id = '<USER_TELEGRAM_ID>';

-- Проверить что UPDATE затронул ровно 1 строку:
-- Если 0 — юзера нет в user_balance, нужно сначала инициализировать (отправить /start или вызвать ensureBalance).
-- Если 0, откатить: ROLLBACK; и разобраться.
COMMIT;
```

**Критично**: всегда заполнять `tribute_order_id` при ручном гранте, чтобы повторный webhook (если дойдёт позже) не начислил дважды.

### 4. Проверить результат
```sql
SELECT * FROM user_balance WHERE user_id = '<USER_TELEGRAM_ID>';
SELECT * FROM balance_transactions WHERE user_id = '<USER_TELEGRAM_ID>' ORDER BY created_at DESC LIMIT 5;
```

## Killswitch

Отключение монетизации: убрать `TRIBUTE_*` env vars + **restart процесса** (redeploy / `pm2 restart` / `systemctl restart`). Занимает < 30 секунд.

**Важно — in-flight webhooks:**
- Webhooks, полученные во время рестарта (~30 сек), будут потеряны. Tribute повторяет доставку в течение 24 часов.
- После включения обратно — проверьте логи на пропущенные платежи и начислите вручную при необходимости.
- Альтернатива с меньшим риском: временно возвращать 503 из webhook-эндпоинта (не убирать env vars, а добавить env `BILLING_KILLSWITCH=1`), чтобы Tribute гарантированно повторил доставку.
