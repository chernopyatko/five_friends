# Codex Brief — Ad Source Tracking (Multi-channel Attribution)

## Goal
Extend `/start` payload parsing to support ad campaign attribution from multiple sources (Google Ads, Telegram Ads, UTM), persist acquisition source per user, and surface it in analytics + `/stats`. Enable a lightweight redirect page for Google Ads conversion tracking.

## Codebase context (READ FIRST)

| Aspect | Current state |
|---|---|
| **`/start` payload** | `parseSupportedCommand()` in `src/index.ts` extracts raw payload for `/start` only |
| **Referral parsing** | `extractReferralCodeFromStartPayload()` in `src/growth/referral.ts` handles only `ref_` prefix |
| **`applyStartPayload()`** | `ReferralService.applyStartPayload()` calls `extractReferralCodeFromStartPayload()`, returns `ReferralAttributionResult` |
| **`/start` handler** | `src/telegram/uxHandlers.ts:handleCommand("/start")` calls `referrals?.applyStartPayload()` and emits `start` event with `has_ref_code` and `referral_attributed` extras |
| **Analytics** | `AnalyticsService.emitEvent()` in `src/observability/analytics.ts` logs to pino + PostHog, increments `event_daily` |
| **`/stats`** | `formatStatsMessage()` in `src/telegram/uxHandlers.ts` renders admin stats |
| **`users` table** | `user_id TEXT PK`, `inviter_user_id TEXT`, `inviter_code TEXT UNIQUE`, `created_at INTEGER` |
| **Schema migration** | `migrateSchema()` in `src/state/schema.ts` uses `runIdempotentAlter()` for safe `ALTER TABLE` |
| **Conventions** | TypeScript ESM, `.js` imports, grammy, better-sqlite3, pino |

## Hard constraints
- Minimal invasive changes: no refactors, no architecture rewrites.
- Do NOT change referral logic (`ref_` prefix behavior unchanged).
- Do NOT add new npm dependencies.
- Follow existing conventions: ESM `.js` imports, existing folder structure, `SqliteStore` pattern.
- Schema changes via `migrateSchema()` using `runIdempotentAlter()` — no changes to `initSchema()`.
- **HTTP server lifecycle**: the HTTP server in `src/index.ts` MUST start unconditionally (not only when `TRIBUTE_API_SECRET` is set). Billing routes (`/api/tribute/webhook`) still return 503 when billing is not configured, but the server itself is always alive so `/go` is reachable.
- **`campaign` column semantics**: always `TEXT NULL`, never empty string `""`. If campaign is absent or empty after sanitization → store `NULL`. Analytics `extra` omits the `campaign` key when value is `null`.

---

## 1. Payload prefix routing

### What
The `/start` payload currently only recognizes `ref_<code>`. Extend to support multiple prefixes that indicate acquisition source.

### Payload format
| Prefix | Source | Example | Meaning |
|---|---|---|---|
| `ref_` | Referral (existing) | `ref_abc123` | Friend invited |
| `gads_` | Google Ads | `gads_loneliness_01` | Google Ads campaign |
| `tgads_` | Telegram Ads | `tgads_compose_a` | Telegram Ads campaign |
| `utm_` | Generic tracking | `utm_blog_post_1` | Content/organic |

### Where to change
1. **New file `src/growth/sourceAttribution.ts`** — pure function to parse any `/start` payload into a structured result:

```ts
export type AttributionSource = "referral" | "google_ads" | "telegram_ads" | "utm";

export interface StartPayloadAttribution {
  source: AttributionSource | null; // null = organic / unknown
  campaign: string | null;           // campaign id after prefix; null if absent/empty
  rawPayload: string | null;         // original payload string
}

export function parseStartPayload(payload?: string | null): StartPayloadAttribution;

// Campaign sanitization helper (exported for /go route reuse)
export function sanitizeCampaign(raw: string): string | null;
```

Rules:
- `ref_*` → `source: "referral"`, `campaign: null` (referral handles its own logic)
- `gads_*` → `source: "google_ads"`, `campaign: <everything after "gads_">`
- `tgads_*` → `source: "telegram_ads"`, `campaign: <everything after "tgads_">`
- `utm_*` → `source: "utm"`, `campaign: <everything after "utm_">`
- empty/null payload → `source: null`, `campaign: null` (shown as "organic" in display/stats only)
- unknown prefix (e.g. `foo_bar`) → `source: null`, `campaign: null`
- Campaign string sanitization: trim, strip `/[^a-zA-Z0-9_-]/g`, max 64 chars. If empty after sanitization → `null`

2. **`src/telegram/uxHandlers.ts:handleCommand("/start")`** — call `parseStartPayload(commandPayload)` and pass `source` + `campaign` to:
   - `analytics.emitEvent()` as extra fields
   - `referrals.applyStartPayload()` (unchanged, only runs for `ref_` payloads)
   - `referrals.setUserSource()` (new method, see §2)

### Acceptance criteria
- `ref_` payloads still work exactly as before (referral attribution unchanged)
- `gads_loneliness_01` → analytics event has `source: "google_ads"`, `campaign: "loneliness_01"`
- Unknown prefix `foo_bar` → `source: null`, `campaign: null`
- Empty payload → `source: null`, `campaign: null`
- `gads_` (prefix only, no campaign) → `source: "google_ads"`, `campaign: null`
- `gads_<script>alert(1)</script>` → campaign sanitized to `scriptalert1script` (stripped non-alnum except `-_`)

---

## 2. Persist acquisition source in `users` table

### What
Store where each user came from (set once, never overwritten — same as `inviter_user_id` semantics).

### Schema change
In `src/state/schema.ts:migrateSchema()`, add two idempotent `ALTER TABLE`:
```ts
runIdempotentAlter(db, "ALTER TABLE users ADD COLUMN source TEXT");
runIdempotentAlter(db, "ALTER TABLE users ADD COLUMN campaign TEXT");
```

### Where to change
`src/growth/referral.ts` — add method `setUserSource()`:

```ts
setUserSource(userId: string, source: string | null, campaign: string | null): void {
  // Only write if source is non-null (skip organic/unknown to allow later attribution)
  if (source === null) return;
  // Set once — only if source is currently NULL
  this.db
    .prepare<[string, string | null, string]>(`
      UPDATE users
      SET source = ?, campaign = ?
      WHERE user_id = ?
        AND source IS NULL
    `)
    .run(source, campaign, userId);
}
```

### Call site
In `src/telegram/uxHandlers.ts:handleCommand("/start")`, after `referrals?.applyStartPayload()`:
```ts
const attribution = parseStartPayload(commandPayload);
this.referrals?.setUserSource(userId, attribution.source, attribution.campaign);
```

### Acceptance criteria
- New user with `gads_X` → `users.source = "google_ads"`, `users.campaign = "X"`
- Existing user revisits with different source → source NOT overwritten
- User without payload → `source` remains `NULL` in DB (not "organic")
- User first visits without payload, later clicks ad link → source IS updated (because NULL → non-null allowed)
- `campaign` is never empty string in DB — always `NULL` or non-empty value

---

## 3. Enrich analytics `start` event

### What
Add `source` and `campaign` as extra fields to the existing `start` analytics event.

### Where to change
`src/telegram/uxHandlers.ts:handleCommand("/start")` — update the `extra` object:

```ts
this.analytics?.emitEvent({
  event: "start",
  userId,
  sessionId: state.sessionId,
  extra: {
    has_ref_code: Boolean(commandPayload?.trim().startsWith("ref_")),
    referral_attributed: referralResult?.attributed ?? false,
    source: attribution.source ?? "organic",
    ...(attribution.campaign != null ? { campaign: attribution.campaign } : {})
  }
});
```

### Acceptance criteria
- `start` event in pino/PostHog always contains `source` field (string, never omitted; `"organic"` when null)
- `campaign` field present in event **only** when non-null (omitted otherwise)
- Existing `has_ref_code` and `referral_attributed` fields unchanged

---

## 4. `/stats` — source breakdown

### What
Add acquisition source breakdown to admin `/stats` output.

### Where to change
1. **`src/growth/referral.ts`** — add method:
```ts
getSourceBreakdown(): Array<{ source: string; count: number }> {
  return this.db
    .prepare<[], { source: string; count: number }>(`
      SELECT COALESCE(source, 'organic') AS source, COUNT(*) AS count
      FROM users
      GROUP BY COALESCE(source, 'organic')
      ORDER BY count DESC
    `)
    .all();
}
```

2. **`src/telegram/uxHandlers.ts:formatStatsMessage()`** — add new parameter `sourceBreakdown` and append section:
```
Источники:
• organic: 42
• google_ads: 12
• telegram_ads: 8
• referral: 14
```

3. **`src/telegram/uxHandlers.ts:handleCommand("/stats")`** — pass `this.referrals?.getSourceBreakdown() ?? []` to `formatStatsMessage()`.

### Acceptance criteria
- `/stats` shows source breakdown
- Works when no users have source set (all show as "organic")
- Non-admins still get `Недостаточно прав.`

---

## 5. Redirect page for Google Ads (optional, lightweight)

### What
A minimal HTML endpoint on the existing webhook HTTP server that fires a GA4 event and redirects to the bot deep link. This enables Google Ads conversion tracking.

### Where to change
`src/index.ts` — in the existing `http.createServer` handler, add route `GET /go`:

### Behavior
1. Read query params: `utm_source`, `utm_campaign` (or fallback to `campaign`)
2. Build deep link: `https://t.me/${BOT_USERNAME}?start=gads_${campaign}`
3. Return minimal HTML page that:
   - Sends GA4 `page_view` event via gtag.js (if `GA_MEASUREMENT_ID` env var is set)
   - Auto-redirects to the deep link after 1 second via `<meta http-equiv="refresh">`
   - Shows fallback link text: "Переход в бота..."

### Env vars
| Var | Required | Notes |
|---|---|---|
| `GA_MEASUREMENT_ID` | ❌ | e.g. `G-XXXXXXXXXX`. If missing, no GA tag, just redirect |

### Template (inline in handler, NOT a separate file)
```html
<!DOCTYPE html>
<html><head>
<meta charset="utf-8">
<meta http-equiv="refresh" content="1;url=DEEP_LINK">
<title>Переход в бота</title>
GTAG_SCRIPT
</head><body>
<p>Переход в бота... <a href="DEEP_LINK">Открыть</a></p>
</body></html>
```

Where `GTAG_SCRIPT` is either empty string or:
```html
<script async src="https://www.googletagmanager.com/gtag/js?id=GA_ID"></script>
<script>window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments);}gtag('js',new Date());gtag('config','GA_ID');</script>
```

### Security
- Sanitize `campaign` param via shared `sanitizeCampaign()` from `src/growth/sourceAttribution.ts`: strip `/[^a-zA-Z0-9_-]/g`, max 64 chars, `null` if empty after sanitization
- Deep link URL: `encodeURIComponent(campaign)` before inserting into URL
- HTML output: escape `<>&"'` in all dynamic values (campaign and deep link) before inserting into HTML template
- If `BOT_USERNAME` missing → return 503 with "Bot not configured"
- Content-Security-Policy header: `default-src 'none'; script-src https://www.googletagmanager.com 'unsafe-inline'; connect-src https://www.google-analytics.com`

### Acceptance criteria
- `GET /go?campaign=loneliness_01` → HTML page that redirects to `t.me/BOT?start=gads_loneliness_01`
- GA4 event fires if `GA_MEASUREMENT_ID` is set
- Works without GA (just redirect)
- Invalid/missing campaign → redirect to plain `t.me/BOT` without payload

---

## Non-goals (out of scope)
- No Google Ads API integration or offline conversion import
- No changes to billing, paywall, or balance logic
- No changes to LLM responder or prompts
- No new npm dependencies
- No separate landing page service (reuse existing HTTP server)

---

## Env vars (new)

| Var | Required | Notes |
|---|---|---|
| `GA_MEASUREMENT_ID` | ❌ | For redirect page GA4 tracking. No GA if missing |

All other env vars (`BOT_USERNAME`, `BOT_TOKEN`, etc.) already exist.

---

## Files to change

| File | Change |
|---|---|
| **NEW** `src/growth/sourceAttribution.ts` | `parseStartPayload()` + `StartPayloadAttribution` type |
| `src/growth/referral.ts` | Add `setUserSource()` + `getSourceBreakdown()` methods |
| `src/state/schema.ts` | Add `source` + `campaign` columns to `migrateSchema()` |
| `src/telegram/uxHandlers.ts` | Update `/start` handler, enrich analytics extra, update `/stats` + `formatStatsMessage()` |
| `src/index.ts` | Add `GET /go` route to HTTP server |
| **NEW** `tests/growth/sourceAttribution.test.ts` | Unit tests for `parseStartPayload()` |
| `tests/telegram/stateMachine.test.ts` | Test `/start` with `gads_*`, `tgads_*`, `utm_*` payloads |
| `tests/index.test.ts` | Test `GET /go` redirect (optional) |

---

## Deliverables
1. Code changes implementing §1–§5
2. Tests for payload parsing, source persistence, and analytics enrichment
3. `npm test` and `npm run lint` pass

## Definition of Done
1. `/start gads_loneliness_01` → user gets `source=google_ads`, `campaign=loneliness_01` in DB
2. `/start tgads_compose_a` → user gets `source=telegram_ads`, `campaign=compose_a` in DB
3. `/start ref_abc123` → referral attribution works exactly as before + `source=referral` set
4. `/start` (no payload) → `source` stays `NULL` in DB (displayed as "organic" in stats/analytics)
5. Source set once per user — non-null source never overwritten
6. User with `NULL` source CAN be attributed later if they click an ad link
7. `campaign` column is never empty string — always `NULL` or non-empty
8. `start` analytics event contains `source` field (always); `campaign` field only when non-null
9. `/stats` shows source breakdown section (NULL displayed as "organic")
10. `GET /go?campaign=X` redirects to `t.me/BOT?start=gads_X` with HTML-escaped output + CSP header
11. Redirect page includes GA4 tag when `GA_MEASUREMENT_ID` is set
12. HTTP server starts unconditionally (not gated by `TRIBUTE_API_SECRET`)
13. `npm test` passes
14. `npm run lint` passes
