# BACKEND_STRUCTURE

## 1) DB schema (SQLite, MVP)

### sessions
- `id` TEXT PRIMARY KEY
- `user_id` TEXT NOT NULL
- `started_at` INTEGER NOT NULL
- `last_activity_at` INTEGER NOT NULL
- `rolling_summary` TEXT DEFAULT ''

**Indexes:**
- `sessions_user_id_idx` (user_id)

### messages (session working memory)
- `id` TEXT PRIMARY KEY
- `session_id` TEXT NOT NULL
- `role` TEXT NOT NULL (`user|assistant`)
- `text` TEXT NOT NULL
- `created_at` INTEGER NOT NULL

**Indexes:**
- `messages_session_id_idx` (session_id)
- `messages_created_at_idx` (created_at)

**Retention:**
- Храним только последние **N=10–12** сообщений на сессию (остальные удаляем).

### memories (long‑term)
- `id` TEXT PRIMARY KEY
- `user_id` TEXT NOT NULL
- `kind` TEXT NOT NULL (`fact|preference|thread|episode`)
- `text` TEXT NOT NULL
- `importance` INTEGER NOT NULL (1–5)
- `confidence` REAL NOT NULL (0–1)
- `status` TEXT NOT NULL (`active|needs_confirmation|retracted`)
- `source_session_id` TEXT NULL
- `created_at` INTEGER NOT NULL
- `updated_at` INTEGER NOT NULL
- `last_used_at` INTEGER NULL

**Indexes:**
- `memories_user_id_idx` (user_id)
- `memories_user_kind_idx` (user_id, kind)
- `memories_user_status_idx` (user_id, status)

## 2) Пер‑пользовательская модель состояния (in‑memory + persisted)
- `currentPersona`: `yan|natasha|anya|max|null`
- `pendingMode`: `null|awaiting_panel_input`
- `pendingUserText`: `string|null`
- `lastPersonaBeforePanel`: `yan|natasha|anya|max|null`
- `sessionId`, `sessionStartTs`, `lastActivityTs`
- `safetyHold`: `boolean`
- `pendingSafetyCheck`: `boolean`
- `safetySuppressedUntilTs`: `number|null`
- `lastModeBeforeSafety`: `{ currentPersona, pendingMode }|null`
- `lastProcessedUpdateId`: `number|null` (идемпотентность)
- `rateLimitState`: { windowStartTs, count }
- `queueLock`: boolean (per‑user последовательность)

## 3) Контекст для LLM
### Обычный ответ
- pinned long‑term preferences (top 5)
- top‑K long‑term memories (K=3–7)
- rollingSummary (текущая сессия)
- последние 4–6 сообщений
- текущее сообщение

### 📌 Сводка
- **только текущая сессия**: rollingSummary + последние **N=10–12** сообщений
- long‑term не используется

## 4) Границы сессии
- Явная: `/reset` → закрывает текущую сессию и стартует новую.
- Неявная: inactivity timeout **12 часов** → новая сессия.
- `currentPersona` сохраняется между сессиями, рабочая память — нет.

## 5) Политика данных и приватности
- Храним минимум (текущая сессия + сжатые long‑term заметки).
- Сырые тексты **не логируются** в проде.
- Ретеншн логов: 7 дней.

## 6) Edge cases
- **Stale callbacks**: отвечаем «Эта кнопка устарела…».
- **Deleted messages**: игнорируем, не ломаем состояние.
- **Timeouts/5xx**: ErrorTransientRetry + идемпотентный retry.
- **Restarts**: очищаем pending‑состояния, проверяем timeout сессии.
- **Duplicate updates**: проверяем `lastProcessedUpdateId`.
- **Single instance polling**: избегаем конфликтов getUpdates.
