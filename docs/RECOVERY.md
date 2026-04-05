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

Если транзакции нет — начислить вручную:

```sql
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
```

**Критично**: всегда заполнять `tribute_order_id` при ручном гранте, чтобы повторный webhook (если дойдёт позже) не начислил дважды.

### 4. Проверить результат
```sql
SELECT * FROM user_balance WHERE user_id = '<USER_TELEGRAM_ID>';
SELECT * FROM balance_transactions WHERE user_id = '<USER_TELEGRAM_ID>' ORDER BY created_at DESC LIMIT 5;
```

## Killswitch

Отключение монетизации: убрать `TRIBUTE_*` env vars + **restart процесса** (redeploy / `pm2 restart` / `systemctl restart`). Занимает < 30 секунд.
