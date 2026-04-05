# FIX: Tribute Webhook — формат payload не соответствует реальному API

**Приоритет**: 🚨 Блокер — без фикса webhook не обработает ни одну покупку.

## Контекст

Текущая реализация webhook handler написана по гипотетическому формату Tribute API.
Реальный формат (документация: https://wiki.tribute.tg/ru/api-dokumentaciya/vebkhuki
и https://wiki.tribute.tg/ru/for-content-creators/digital-product/api-integration)
значительно отличается. Мы используем цифровые товары (digital products), не подписки.

## Реальный формат вебхука Tribute (покупка цифрового товара)

```json
{
  "name": "new_digital_product",
  "created_at": "2025-03-20T01:15:58.33246Z",
  "sent_at": "2025-03-20T01:15:58.542279448Z",
  "payload": {
    "product_id": 456,
    "product_name": "50 сообщений",
    "amount": 500,
    "currency": "rub",
    "trb_user_id": "T-31326",
    "telegram_user_id": 12321321,
    "telegram_username": "durov",
    "purchase_id": 78901,
    "transaction_id": 234567,
    "purchase_created_at": "2025-03-20T01:15:58.33246Z"
  }
}
```

Формат возврата (сейчас только логируем, баланс не снимаем):
```json
{
  "name": "digital_product_refunded",
  "payload": {
    "product_id": 456,
    "telegram_user_id": 12321321,
    "purchase_id": 78901,
    "refund_reason": "telegram_refund",
    "refunded_at": "2025-03-20T02:30:00.33246Z"
  }
}
```

Заголовок подписи: `trbt-signature` (HMAC-SHA256 hex, подписано API-ключом). Уже реализовано корректно.

## Таблица расхождений

| # | Что | Код сейчас | Реальный API |
|---|---|---|---|
| 1 | Поле типа события | `event_type` / `type` | `name` |
| 2 | Значение события | `"order_paid"` | `"new_digital_product"` |
| 3 | Обёртка данных | `data` | `payload` |
| 4 | Telegram ID | `data.telegram_id` | `payload.telegram_user_id` |
| 5 | Product ID | `data.product.id` (string) | `payload.product_id` (number) |
| 6 | Idempotency ID | `data.order_id` → `orderId` | `payload.purchase_id` → `purchaseId` |
| 7 | Refund event | не обработан | `"digital_product_refunded"` |

## Файлы для изменения (только эти 4)

### 1. `src/billing/tributeWebhook.ts`

**Интерфейс** `TributeWebhookEvent` — переименовать `orderId` → `purchaseId`:
```ts
export interface TributeWebhookEvent {
  eventType: string;       // значение поля `name`
  telegramId: string;      // из payload.telegram_user_id
  productId: string;       // из payload.product_id
  purchaseId: string;      // из payload.purchase_id (было orderId)
}
```

**Функция** `parseTributeWebhookEvent` — переписать маппинг:
- Читать `name` (не `event_type`/`type`)
- Читать вложенный `payload` (не `data`)
- Из `payload` читать: `telegram_user_id`, `product_id`, `purchase_id`
- Все три — числовые, нормализовать в string через существующий `readIdentifier`
- Убрать старую логику с `data`, `data.product.id`, `data.telegram_id`, `data.order_id`

**НЕ трогать**: `verifyTributeSignature`, `loadProductMap`, helper-функции.

### 2. `src/index.ts`

**Константа** `KNOWN_TRIBUTE_EVENTS` (строка ~41):
```ts
const KNOWN_TRIBUTE_EVENTS = new Set(["new_digital_product", "digital_product_refunded"]);
```

**Все ссылки** `event.orderId` → `event.purchaseId` в `handleTributeWebhookRequest`:
- `addBalance(..., event.orderId)` → `event.purchaseId`
- Все лог-объекты `orderId:` → `purchaseId:`
- Fallback session `purchase:${event.orderId}` → `purchase:${event.purchaseId}`

**Добавить ветку refund** перед credit-логикой (после product lookup):
```ts
if (event.eventType === "digital_product_refunded") {
  input.logger.warn(
    toSafeLog({ outcome: "tribute_webhook_refund", details: { purchaseId: event.purchaseId, userId: event.telegramId } }),
    "Digital product refunded (no balance deduction yet)"
  );
  writeJson(res, 200, { ok: true, refund_logged: true });
  return;
}
```

### 3. `tests/billing/tributeWebhook.test.ts`

Обновить все тесты `parseTributeWebhookEvent` на реальный формат:

**"parses strict tribute payload"** — новый payload:
```ts
parseTributeWebhookEvent({
  name: "new_digital_product",
  created_at: "2025-03-20T01:15:58.33246Z",
  sent_at: "2025-03-20T01:15:58.542279448Z",
  payload: {
    product_id: 456,
    product_name: "50 сообщений",
    amount: 500,
    currency: "rub",
    trb_user_id: "T-31326",
    telegram_user_id: 12321321,
    telegram_username: "durov",
    purchase_id: 78901,
    transaction_id: 234567
  }
})
// → { eventType: "new_digital_product", telegramId: "12321321", productId: "456", purchaseId: "78901" }
```

**"rejects invalid"** — обновить на новый формат (невалидные `telegram_user_id`, пустой `product_id`, NaN `purchase_id`)

**Добавить тест** парсинга refund:
```ts
parseTributeWebhookEvent({
  name: "digital_product_refunded",
  payload: { product_id: 456, telegram_user_id: 12321321, purchase_id: 78901 }
})
// → { eventType: "digital_product_refunded", telegramId: "12321321", productId: "456", purchaseId: "78901" }
```

### 4. `.env.example` и `README.md`

Обновить пример `TRIBUTE_PRODUCT_MAP` — ключи числовые ID из Tribute:
```
TRIBUTE_PRODUCT_MAP={"456":50,"457":150,"458":350}
```

## Definition of Done

1. `parseTributeWebhookEvent` парсит реальный формат `{ name, payload: { telegram_user_id, product_id, purchase_id } }`
2. `TributeWebhookEvent.orderId` переименован в `purchaseId` — все ссылки обновлены
3. `KNOWN_TRIBUTE_EVENTS` включает `new_digital_product` и `digital_product_refunded`
4. `digital_product_refunded` логируется warn и возвращает 200, без изменения баланса
5. Все тесты обновлены под реальный формат + добавлен тест refund
6. `.env.example` и `README.md` примеры `TRIBUTE_PRODUCT_MAP` обновлены
7. `npm test` проходит (все тесты)
8. `npm run lint` проходит

## Запрещено

- Менять `verifyTributeSignature` — формат подписи совпадает
- Менять `loadProductMap` — работает корректно
- Менять файлы кроме перечисленных
- Добавлять npm-зависимости
- Менять логику balance/deduction в `bot.ts`
