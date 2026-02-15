# PRIVACY (MVP)

## Что хранится
1) **Текущая сессия (working memory)**
- rollingSummary
- последние N=10–12 сообщений

2) **Долгая память (long‑term)**
- сжатые заметки типов: fact | preference | thread | episode
- без сырого лога

## Что не хранится
- Сырый текст сообщений в прод‑логах
- Raw LLM‑ответы в прод‑логах

## Логи (prod)
- Только структурированные метрики/статусы: request_id, mode, latency, outcome, safety_class и т.п.
- user_id — в проде только хеш (salted)
- Ретеншн логов: 7 дней

## Как сбросить
- `/reset` очищает **текущую сессию** и pending‑состояния
- `/forget` удаляет **долгую память** (long‑term)

## Debug‑режим
- `DEBUG_LOG_TEXT=1` допустим **только локально**
