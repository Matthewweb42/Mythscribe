# MythScribe Cloud API (`cloud/`)

The Worker behind `api.mythscribe.app`. It serves the **account** routes (F-15.2: email magic
link, sessions), the **credit** routes (F-15.3: balance, Lemon Squeezy checkout and webhook,
the meter), the **AI proxy** the app uses when a project runs on MythScribe's key (F-15.4:
`POST /ai/complete`), the **opt-in diagnostics** sink (F-15.8: `POST /diagnostics`), and the
**Supporter license** (F-15.9: `GET /license`). It never
sees the author's own key and never stores manuscript text — it stores an email address, hashes,
amounts, and anonymous counts. Messages and answers pass through memory and a stream; nothing of
them is written to the database or to a log line.

Hosted AI billing follows `docs/research/AI-BILLING-SPEC.md` (2026-10-07): an append-only ledger
in micro-USD, holds placed before a request is forwarded, provider cost + a configurable markup,
OpenRouter as the gateway, and server-held config (see "Billing" below).

Source: `src/index.ts` (router, scheduled sweep), `src/auth.ts` (account handlers, pure over a
store + mailer + clock), `src/credits.ts` (balance, pricing, usage, checkout, webhook),
`src/config.ts` (the billing config and its defaults), `src/store.ts` (the store over D1; the
tests run the same SQL on SQLite via `src/testing/sqliteD1.ts`), `src/email.ts` (Resend / log transports), `src/pages.ts` (the two HTML pages),
`src/crypto.ts` (tokens, hashes, the webhook HMAC, the license signature), `src/ai.ts` (the proxy
handler), `src/openai.ts` (the upstream seam: Chat Completions over plain `fetch`, plus the SSE
reader), `src/diagnostics.ts` (the diagnostics aggregates) and `src/license.ts` (the Supporter
token).
The wire contract is shared with the desktop app in `src/shared/cloudApi.ts`, the rates in
`src/shared/cloudRates.ts`, and the license token format in `src/shared/license.ts`, imported from
there, not copied.

## Routes

| Route | Purpose |
| --- | --- |
| `GET /` | `{ "service": "mythscribe-api" }`, a liveness answer |
| `POST /auth/start` | `{ email }` → `{ attemptId, pollSecret, expiresAt }`; emails the sign-in link. 3 per address per 15 minutes; 503 `NOT_CONFIGURED` when no mail transport is set |
| `GET /auth/verify?t=` | the link in the email: approves the attempt once, mints the session, renders an HTML page (410 page when expired or already used) |
| `POST /auth/poll` | `{ attemptId, pollSecret }` → `pending` / `ready` (the session — the refresh token — handed over exactly once, plus the first short-lived `access` token) / `expired` |
| `POST /auth/verify` | `{ attemptId, pollSecret, code }`: the six-digit code from the same email, for an author reading mail elsewhere; answers like `/auth/poll`. 400 `BAD_REQUEST` for a wrong code; the fifth wrong code spends the attempt (`expired`) |
| `POST /auth/refresh` | `{ refreshToken }` (the session token) → `{ access: { token, expiresAt } }`, a 15-minute access token; 401 once the session is revoked or expired |
| `GET /auth/me` | `Authorization: Bearer <access token>` (or, until the app switches, the session token) → `{ email, userId, since }`; 401 when revoked or expired |
| `POST /auth/signout` | same header; revokes the session (an access token revokes the session it came from, ending all its access tokens), always 204 |
| `GET /credits` | bearer → `{ balanceMicros, heldMicros, spend[], periodDays, periodSpend[], periodFirstChargeAt, packs[] }` (F-15.3, F-15.5); the available balance in micro-USD (ledger sum minus active holds), the held part, lifetime spend per AI feature, the same breakdown over the usage meter's rolling `USAGE_PERIOD_DAYS` window plus the oldest charge in it (null with none), and the packs on sale |
| `GET /pricing` | **no header**: `PricingResult` — markup, app price, minimum pack, packs on sale, trial grant, quote threshold, safety factor, low-balance warning, hold expiry, refund window, limits, the model price table (USD per 1M tokens incl. cached input, display multiplier), the routing table, and the per-word constants (null until measured). All from `billing_config` |
| `GET /usage?limit=&cursor=` | bearer → `{ entries[], nextCursor }`: the account's ledger newest first (type, amount, time, feature, model, tokens in/out/cached, request id); `limit` 1–200 (default 50) |
| `POST /billing/checkout` | bearer + `{ variantId }` → `{ url }`; the Lemon Squeezy checkout for one variant on sale — a credit pack or the Supporter product (F-15.9) — with `custom[user_id]` and the email stamped on it. The app opens it, never builds it |
| `GET /license` | bearer → `{ token, product }` (F-15.9): a freshly signed Supporter token, or `token: null` when the account has no license or it was refunded, plus the Supporter product on sale (null until it is configured). 503 `NOT_CONFIGURED` only when the account *has* a license and `LICENSE_SIGNING_KEY` is unset |
| `POST /ai/complete` | bearer + optional `Idempotency-Key` header + `AiCompleteBody` (`feature`, `model`, `messages`, `maxTokens`, `json?`, `temperature?`, `stream`) → the relayed answer (F-15.4). An unreadable body, over 4 000 output tokens, or over 64 messages is 400 `BAD_REQUEST`; message content over `max_input_chars` is 413 `REQUEST_TOO_LARGE`; a model not on the price table (or one the gateway stopped serving) 422 `MODEL_UNAVAILABLE`; over `requests_per_minute` 429 `RATE_LIMITED`; a balance short of the hold 402 `INSUFFICIENT_CREDITS`; a key already charged or still running 409 `DUPLICATE_REQUEST`; no gateway key 503 `NOT_CONFIGURED`; a busy gateway 429 `RATE_LIMITED`; any other gateway failure 502 `UPSTREAM` |
| `POST /diagnostics` | **no header at all** (F-15.8): `DiagnosticsBody` (`appVersion`, `platform`, `arch`, `electron`, `counts[]`, `crashes[]`) → 204. Folds the report into two aggregate tables and stores nothing per install. A body over `DIAGNOSTICS_BODY_MAX` (32 KB), a counter outside the shared enum, or anything else the schema refuses is 400 `BAD_REQUEST` |
| `POST /billing/lemonsqueezy` | the webhook. `X-Signature` = HMAC-SHA256 hex of the raw body with `LEMONSQUEEZY_WEBHOOK_SECRET`; `order_created` (status `paid`) credits the pack price, `order_refunded` debits it, everything else answers 200 and is ignored. An order for the Supporter variant grants (or, refunded, revokes) the license instead and never touches the balance |

`/ai/complete` with `stream: false` answers `AiCompleteResult`
(`{ text, model, usage, chargeMicros, balanceMicros, requestId }`) as JSON. With `stream: true` it answers
200 `application/x-ndjson`, one `AiStreamEvent` per line: `{"type":"delta","delta":"…"}` as the
text arrives, then exactly one terminal event — `{"type":"done", model, usage, chargeMicros,
balanceMicros}`, or `{"type":"error", code, message}` when the provider fails after the headers
were sent (the status is already 200). A client that stops reading cancels the upstream call and
is charged nothing.

The order per request is: authenticate, validate, check the limits, **hold** the worst-case cost
(every input token uncached — bounded by its UTF-8 bytes plus the chat template — and the answer
at `maxTokens`, at cost + markup) in the same SQL statement that checks the available balance,
forward to the gateway, then **settle**: one `charge` ledger row for the real usage at the prices
locked on the hold, never above the hold, or — on a gateway failure or a cancelled stream —
release the hold with no charge. A hold nothing settles (the Worker was evicted, the store failed)
is released by the Cron sweep every five minutes, and stops counting against the balance the
moment it expires. One log line per request, with the request id, the user id, the feature, the
model, the token counts (cached too), the provider cost, the charge, the hold, the status, and the
time taken; never a message and never an answer.

Errors are `{ code, message }` with the codes and statuses in `src/shared/cloudApi.ts`. There are
no CORS headers: the desktop app is not a browser origin, and every response is `no-store`.
Secrets are stored only as SHA-256 hex digests; timestamps are epoch milliseconds.

## Billing (AI-BILLING-SPEC, 2026-10-07)

Money is integers in **micro-USD** (1e-6 USD; a $10 pack is 10_000_000), and the source of truth
is `ledger_entries` (0005): append-only — triggers refuse every `UPDATE` and `DELETE` — with the
types `topup`, `trial_grant`, `charge`, `refund`, `adjustment` and a unique `idempotency_key` on
every row, so a replayed webhook or a retried request lands nowhere. No balance is stored: the
available balance is the ledger's sum minus the account's active, unexpired holds (`holds`).

- **Holds and concurrency.** The balance check and the hold are one
  `INSERT … SELECT … WHERE available >= amount` statement (`PLACE_HOLD` in `src/store.ts`). D1
  executes one statement at a time against one SQLite database, so two requests racing for the last
  dollar cannot both pass the check: the statement is the lock. A hold is unique per
  `(account, Idempotency-Key)`: a retry of a key that was charged or is running is 409
  `DUPLICATE_REQUEST`; a retry of a key whose attempt failed (released, no charge) runs again.
- **Pricing.** `charge = ceil(provider_cost × (1 + markup))` with the provider cost from the price
  table (cached input at its own price), in integer arithmetic (`src/shared/cloudBilling.ts`,
  shared with the app). At least 1 micro-USD per answered request, never more than the hold.
- **Trial grant.** `trial_grant_usd` ($2.00) once per verified email, on the first sign-in by link
  or code; keyed by the address's SHA-256, so it is never granted twice.
- **Top-ups and refunds.** `order_created` (paid) writes a `topup` of the configured pack price
  (key `order_created:<order id>`, the same as the 0002 `order_ref`, so replays across the
  migration stay duplicates). `order_refunded` writes a `refund` of the order's cumulative
  `refunded_amount` (the whole pack when absent), capped at the pack, minus what the order already
  had refunded — so the operator refunds what is left of a pack in Lemon Squeezy and the ledger
  follows exactly. Spent money is the operator's call; the refund window is `refund_window_days`.
- **Staleness.** A signed order event older than `webhook_max_age_hours` (by its `created_at`, or
  `refunded_at` for a refund), or one without a timestamp, is 400 `STALE_WEBHOOK` and changes nothing.
- **Gateway.** `OPENROUTER_API_KEY` set: the proxy forwards to OpenRouter with the price table's
  ids. Otherwise `OPENAI_API_KEY` (the F-15.4 setup) forwards `openai/…` models to OpenAI by their
  bare names.
- **Legacy.** 0005 copies every `credit_events` row into the ledger; `credits` and `credit_events`
  stay in the database, unread. `src/shared/cloudRates.ts` (2x) is no longer used by the Worker;
  the app still shows it until it reads `GET /pricing`.

### Billing config (operator)

Every key below has a built-in default (`DEFAULT_BILLING_CONFIG` in `src/config.ts`); a row in
`billing_config` overrides it on the next request, with no deploy and no app release. Values are
JSON. A row that does not validate is logged and ignored, and a routing table that names a model
not on the price table falls back to the default routing.

| Key | Default |
| --- | --- |
| `app_price_usd` | `30` |
| `min_pack_usd` | `10` (a configured pack below it is not sold) |
| `markup` | `0.2` |
| `trial_grant_usd` | `2` |
| `quote_threshold_usd` | `0.25` |
| `estimate_safety_factor` | `1.2` |
| `low_balance_warning_usd` | `2` |
| `hold_expiry_minutes` | `10` |
| `requests_per_minute` | `60` |
| `max_input_chars` | `200000` |
| `refund_window_days` | `30` |
| `webhook_max_age_hours` | `72` |
| `models` | GPT-5.4 mini / 5.4 / 5.4 nano via OpenRouter (`openai/…`), with cached-input prices and display multipliers |
| `routing` | `{"tiers":{"fast":"openai/gpt-5.4-mini","strong":"openai/gpt-5.4"},"features":{}}` |
| `word_costs` | `{"lineEdit":null,"consistencyCheck":null}` (null hides the estimate line) |

```bash
# Change the markup to 25 % (applies to the next request; holds in flight keep their price).
npx wrangler d1 execute mythscribe --remote --config cloud/wrangler.toml --command \
  "INSERT INTO billing_config (key, value, updated_at) VALUES ('markup', '0.25', unixepoch() * 1000)
   ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at"

# A correction is a new ledger row, never an edit: credit an account $5.
npx wrangler d1 execute mythscribe --remote --config cloud/wrangler.toml --command \
  "INSERT INTO ledger_entries (id, user_id, type, amount_micros, idempotency_key, created_at)
   VALUES (lower(hex(randomblob(16))), '<user id>', 'adjustment', 5000000,
           'adjustment:<ticket>', unixepoch() * 1000)"
```

The webhook answers a non-2xx only for the two things an operator can fix (a body not signed with
our secret: 401 `BAD_SIGNATURE`; no secret configured: 503 `NOT_CONFIGURED`). An unreadable body,
an unknown user, or an unknown variant is a `console.warn` and a 200, because Lemon Squeezy
retries every failure for days and none of those would improve.

## Diagnostics (F-15.8)

`POST /diagnostics` is the one route with no `Authorization` header, because a report is anonymous
by design: no session, no install id, no IP, and nothing else that could link two reports. The app
sends it only while the author has turned diagnostics on (off on every install), and it sends
counters out of a fixed enum plus crash reports whose message and stack were scrubbed before they
left the machine (`src/shared/diagnostics.ts`). The Worker validates the same zod schemas, so a
counter the enum does not know is a 400 rather than a new row.

What lands in D1 is aggregate only: `diagnostic_counts` adds to a total per day, app version,
platform, and counter; `diagnostic_crashes` keeps one row per fingerprint (SHA-256 of the error
name, the top 5 frames, and the app version) with a count and a first/last sighting. Unauthenticated
is bounded by the 32 KB body cap, the schema's 200 count rows and 10 crashes per report, and a
`DIAGNOSTIC_COUNT_MAX` (10 000) clamp per counter per report — rows repeated inside one body are
summed before the clamp, so the cap cannot be split across rows. The table's row count is bounded by
versions × platforms × counters × days. Per-IP limiting is deliberately not done in code (storing IPs
would contradict "anonymous"); Cloudflare zone rate limiting can be added in the dashboard.

## Supporter license (F-15.9)

`GET /license` hands a licensed account a signed token and nothing else. The token is
`base64url(JSON claims).base64url(Ed25519 signature)` over `{ v: 1, sub, iat, exp }`, with
`exp = iat + LICENSE_GRACE_MS` (14 days) — the format, the claims, and the grace period live in
`src/shared/license.ts` and are shared with the app. The app verifies the signature against the
public key it ships with, caches the token, and refreshes it once a day, so the cosmetic extras keep
working offline and never block on this route.

The Worker stores no token: `supporter_licenses` holds one row per licensed account, written by the
billing webhook, and every call signs a fresh token from it. A refund sets `revoked_at`, after which
the route answers `token: null` — the app clears its cache on the next refresh, and an app that
never reaches the Worker loses the extras when the cached token expires. Rotating
`LICENSE_SIGNING_KEY` invalidates every token in the wild, so it goes with a release that carries
the new public half.

## Database

One D1 database, `mythscribe` (binding `DB`), migrations in `migrations/` — numbered, never
edited once applied, same rule as the app's SQLite migrations. `0001_auth.sql` holds users,
login attempts, and sessions; `0002_credits.sql` the balance (`credits`) and its ledger
(`credit_events`); `0003_diagnostics.sql` the two diagnostics aggregates (`diagnostic_counts`,
`diagnostic_crashes`), which belong to no user; `0004_supporter.sql` the Supporter licenses
(`supporter_licenses`), one row per account, idempotent on the Lemon Squeezy order (since
2026-10-07 also the $30 app license); `0005_billing.sql` the append-only ledger (`ledger_entries`,
seeded from `credit_events`), `holds`, `billing_config`, `rate_limits`, `access_tokens`, and the
sign-in code columns on `login_attempts`. The tests apply every migration in order to an in-memory
SQLite database (`src/store.test.ts`), so a migration that does not apply fails the suite.

```
npm run cloud:migrate                      # apply to the remote database
npx wrangler d1 migrations apply mythscribe --local --config cloud/wrangler.toml
```

## Secrets

All of them are **Worker secrets**, never a file in the repo and never inside the desktop app.

```
npx wrangler secret put RESEND_API_KEY               # sign-in emails (F-15.2)
npx wrangler secret put OPENROUTER_API_KEY           # the AI gateway (A9); preferred
npx wrangler secret put OPENAI_API_KEY               # the AI proxy before OpenRouter (F-15.4)
npx wrangler secret put LEMONSQUEEZY_WEBHOOK_SECRET  # signs the billing webhook (F-15.3)
npx wrangler secret put LICENSE_SIGNING_KEY          # signs Supporter tokens (F-15.9)
```

Rotating: run the same `secret put` with the new value; no redeploy needed. Without
`RESEND_API_KEY` (and with `EMAIL_TRANSPORT = "resend"`), `/auth/start` answers 503 and the app
shows "Sign-in email is not configured on the server yet." verbatim.

## Running it locally

```
cp cloud/.dev.vars.example cloud/.dev.vars    # EMAIL_TRANSPORT=log, PUBLIC_ORIGIN=http://127.0.0.1:8787,
                                              # OPENAI_API_KEY=<a real key, for /ai/complete>
npx wrangler d1 migrations apply mythscribe --local --config cloud/wrangler.toml
npm run cloud:dev                             # http://127.0.0.1:8787
MYTHSCRIBE_CLOUD_API_URL=http://127.0.0.1:8787 npm run dev
```

With the `log` transport the link is printed by the Worker and returned as `devLink` from
`/auth/start`, so a sign-in can be driven end to end without sending mail. `PUBLIC_ORIGIN` is
needed locally because `wrangler dev` builds every request URL from the configured route
(`api.mythscribe.app`), which would otherwise end up in the link.

```
npm run cloud:types      # regenerate worker-configuration.d.ts after a wrangler.toml change
npx vitest run --project cloud
npx tsc --noEmit -p cloud/tsconfig.json
npm run cloud:deploy
```

`worker-configuration.d.ts` is generated and committed; never hand-edit it.

## Setting up Resend (operator, once)

1. Create the Resend account and add the domain `mythscribe.app`.
2. Add the DNS records Resend shows for it in Cloudflare: the DKIM `TXT` record, the SPF
   `TXT` (`include:amazonses.com` as Resend words it), and the `MX`/`TXT` pair for the return
   path. Wait for Resend to report the domain verified.
3. Create an API key with **send** permission only.
4. `npx wrangler secret put RESEND_API_KEY` and paste it.
5. Send yourself a link from the app and confirm it arrives from `sign-in@mythscribe.app`.

The sender address and the email body live in `src/email.ts`.

## Setting up Lemon Squeezy (operator, once)

1. Create the Lemon Squeezy store and switch it to **test mode** for the whole of this recipe.
2. Create one **one-time** product per balance pack ($10, $25, $50; `min_pack_usd` refuses
   smaller). $1 paid is $1 of balance — the markup is on usage, not in the pack price — and the
   $30 app license is one more one-time product, put in `LEMONSQUEEZY_APP_LICENSE`. Note each
   product's **variant id** and its **buy link** (`https://<store>.lemonsqueezy.com/buy/<uuid>`).
3. Put them in `LEMONSQUEEZY_PACKS` in `wrangler.toml` (the commented example shows the shape)
   and deploy. A malformed value is logged and treated as "no packs on sale"; the Account tab
   then says so rather than failing.
4. Settings › Webhooks: add `https://api.mythscribe.app/billing/lemonsqueezy` with the events
   `order_created` and `order_refunded`, and a signing secret of your own choosing.
5. `npx wrangler secret put LEMONSQUEEZY_WEBHOOK_SECRET` and paste the same secret.
6. `npm run cloud:migrate` (applies every pending migration, `0005_billing.sql` included) and
   `npm run cloud:deploy` (also registers the Cron Trigger for the hold sweep).
7. Buy a pack with a test card from the app's Account tab and confirm the balance moves. Lemon
   Squeezy's webhook log shows the delivery and our 200; a replay must leave the balance alone.

### Replaying a signed event against `wrangler dev`

The handler parses the payload leniently (field names are from documentation, not from a live
event), so confirm a real test-mode body before going live: copy it out of the Lemon Squeezy
webhook log into `event.json` and replay it locally.

```bash
SECRET=local-webhook-secret   # the value in cloud/.dev.vars
SIG=$(node -e "const c=require('node:crypto'),f=require('node:fs');process.stdout.write(c.createHmac('sha256',process.argv[1]).update(f.readFileSync(process.argv[2])).digest('hex'))" "$SECRET" event.json)
curl -sS -i http://127.0.0.1:8787/billing/lemonsqueezy -H "Content-Type: application/json" -H "X-Signature: $SIG" --data-binary @event.json
```

The signature covers the exact bytes, so send the file as-is (`--data-binary`, no reformatting).
A correct replay answers `{"status":"applied"}` the first time and `{"status":"duplicate"}` after
that; `{"status":"ignored"}` with a line in the `wrangler dev` log means the user id or the
variant did not match the configuration.

## Setting up the Supporter license (operator, once)

The key pair does not exist until this is run: until then the app ships a placeholder public key and
the Worker answers 503 `NOT_CONFIGURED` to a licensed account. Order matters — the app's public key
must be the one the Worker signs with, so keygen comes before the first signed build.

1. From the repo root: `npm run cloud:license-keygen`. It prints a private JWK and a public JWK and
   stores neither.
2. `npx wrangler secret put LICENSE_SIGNING_KEY` (from `cloud/`) and paste the **private** JWK, the
   one-line JSON exactly as printed.
3. Replace `LICENSE_PUBLIC_KEY_JWK` in `src/shared/license.ts` with the **public** block it printed,
   and commit that. Every build from then on verifies tokens from this Worker.
4. Create one **one-time** Lemon Squeezy product for the Supporter license ($39). Note its variant
   id and buy link, and put them in `LEMONSQUEEZY_SUPPORTER` in `wrangler.toml` (the commented
   example shows the shape). The existing webhook already covers it: add no new event.
5. `npm run cloud:migrate` (for `0004_supporter.sql`) and `npm run cloud:deploy`.
6. Buy it with a test card from the app's Account tab: the webhook log shows a 200, `GET /license`
   starts answering a token, and the Account tab shows the Supporter badge. Refund the test order and
   confirm the next refresh answers `token: null`.

```bash
# Who holds a license, and which order paid for it.
npx wrangler d1 execute mythscribe --remote --config cloud/wrangler.toml --command \
  "SELECT user_id, order_ref,
          datetime(granted_at / 1000, 'unixepoch') AS granted_utc,
          datetime(revoked_at / 1000, 'unixepoch') AS revoked_utc
     FROM supporter_licenses
    ORDER BY granted_at DESC
    LIMIT 50"
```

Granting one by hand (a giveaway, or a purchase made outside the app) is one statement: insert a row
with a unique `order_ref` for the account's `user_id`. Revoking is `UPDATE supporter_licenses SET
revoked_at = <epoch ms>`.

## Reading diagnostics (operator)

Ship the route once:

```bash
npm run cloud:migrate    # applies 0003_diagnostics.sql to the remote database
npm run cloud:deploy     # publishes POST /diagnostics
```

There is no dashboard and no read route — the aggregates are read with SQL, from the repo root:

```bash
# Usage: what happened per day, build, and platform over the last two weeks.
npx wrangler d1 execute mythscribe --remote --config cloud/wrangler.toml --command \
  "SELECT day, app_version, platform, counter, total
     FROM diagnostic_counts
    WHERE day >= date('now', '-14 days')
    ORDER BY day DESC, total DESC
    LIMIT 100"

# Crashes: the groups seen most recently, worst first within a sighting.
npx wrangler d1 execute mythscribe --remote --config cloud/wrangler.toml --command \
  "SELECT count, name, message, kind, app_version, platform, arch,
          datetime(first_seen / 1000, 'unixepoch') AS first_utc,
          datetime(last_seen / 1000, 'unixepoch') AS last_utc,
          stack
     FROM diagnostic_crashes
    ORDER BY last_seen DESC, count DESC
    LIMIT 20"
```

`--local` instead of `--remote` reads the `wrangler dev` database. Nothing prunes these tables:
when they get long, delete by `day` or by `last_seen`, which is all the age either row has.
