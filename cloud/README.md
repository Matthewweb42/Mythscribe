# MythScribe Cloud API (`cloud/`)

The Worker behind `api.mythscribe.app`. It serves the **account** routes (F-15.2: email magic
link, sessions), the **credit** routes (F-15.3: balance, Lemon Squeezy checkout and webhook,
the meter), the **AI proxy** the app uses when a project runs on MythScribe's key (F-15.4:
`POST /ai/complete`), and the **opt-in diagnostics** sink (F-15.8: `POST /diagnostics`). It never
sees the author's own key and never stores manuscript text — it stores an email address, hashes,
amounts, and anonymous counts. Messages and answers pass through memory and a stream; nothing of
them is written to the database or to a log line.

Source: `src/index.ts` (router), `src/auth.ts` (account handlers, pure over a store + mailer +
clock), `src/credits.ts` (credit handlers and the meter), `src/store.ts` (D1 and in-memory
stores), `src/email.ts` (Resend / log transports), `src/pages.ts` (the two HTML pages),
`src/crypto.ts` (tokens, hashes, the webhook HMAC), `src/ai.ts` (the proxy handler),
`src/openai.ts` (the upstream seam: Chat Completions over plain `fetch`, plus the SSE reader)
and `src/diagnostics.ts` (the diagnostics aggregates).
The wire contract is shared with the desktop app in `src/shared/cloudApi.ts` and the rates in
`src/shared/cloudRates.ts`, imported from there, not copied.

## Routes

| Route | Purpose |
| --- | --- |
| `GET /` | `{ "service": "mythscribe-api" }`, a liveness answer |
| `POST /auth/start` | `{ email }` → `{ attemptId, pollSecret, expiresAt }`; emails the sign-in link. 3 per address per 15 minutes; 503 `NOT_CONFIGURED` when no mail transport is set |
| `GET /auth/verify?t=` | the link in the email: approves the attempt once, mints the session, renders an HTML page (410 page when expired or already used) |
| `POST /auth/poll` | `{ attemptId, pollSecret }` → `pending` / `ready` (the session, handed over exactly once) / `expired` |
| `GET /auth/me` | `Authorization: Bearer <session>` → `{ email, userId, since }`; 401 when revoked or expired |
| `POST /auth/signout` | same header; revokes the session, always 204 |
| `GET /credits` | bearer → `{ balanceMicros, spend[], periodDays, periodSpend[], periodFirstChargeAt, packs[] }` (F-15.3, F-15.5); the balance in micro-USD, lifetime spend per AI feature, the same breakdown over the usage meter's rolling `USAGE_PERIOD_DAYS` window plus the oldest charge in it (null with none), and the packs on sale |
| `POST /billing/checkout` | bearer + `{ variantId }` → `{ url }`; the pack's Lemon Squeezy checkout with `custom[user_id]` and the email stamped on it. The app opens it, never builds it |
| `POST /ai/complete` | bearer + `AiCompleteBody` (`feature`, `model`, `messages`, `maxTokens`, `json?`, `temperature?`, `stream`) → the relayed answer (F-15.4). Caps: `AI_COMPLETE_MAX_TOKENS` 4 000, `AI_COMPLETE_MAX_MESSAGES` 64, `AI_COMPLETE_MAX_CHARS` 200 000 of message content; a model outside the rate table or a body over a cap is 400 `BAD_REQUEST`, no `OPENAI_API_KEY` is 503 `NOT_CONFIGURED`, a used-up balance is 402 `INSUFFICIENT_CREDITS`, a busy provider 429 `RATE_LIMITED`, any other provider failure 502 `UPSTREAM` |
| `POST /diagnostics` | **no header at all** (F-15.8): `DiagnosticsBody` (`appVersion`, `platform`, `arch`, `electron`, `counts[]`, `crashes[]`) → 204. Folds the report into two aggregate tables and stores nothing per install. A body over `DIAGNOSTICS_BODY_MAX` (32 KB), a counter outside the shared enum, or anything else the schema refuses is 400 `BAD_REQUEST` |
| `POST /billing/lemonsqueezy` | the webhook. `X-Signature` = HMAC-SHA256 hex of the raw body with `LEMONSQUEEZY_WEBHOOK_SECRET`; `order_created` (status `paid`) credits the pack price, `order_refunded` debits it, everything else answers 200 and is ignored |

`/ai/complete` with `stream: false` answers `AiCompleteResult`
(`{ text, model, usage, chargeMicros, balanceMicros }`) as JSON. With `stream: true` it answers
200 `application/x-ndjson`, one `AiStreamEvent` per line: `{"type":"delta","delta":"…"}` as the
text arrives, then exactly one terminal event — `{"type":"done", model, usage, chargeMicros,
balanceMicros}`, or `{"type":"error", code, message}` when the provider fails after the headers
were sent (the status is already 200). A client that stops reading cancels the upstream call and
is charged nothing.

The order per request is: authenticate, validate, check the balance (`hasCredit`), call the
provider, then charge (`meterRequest`) — so the tokens are known before the charge and the last
request of an account may overdraw it slightly. One log line per answered request, with the
request id, the user id, the feature, the model, the token counts, the charge, and the status;
never a message and never an answer.

Errors are `{ code, message }` with the codes and statuses in `src/shared/cloudApi.ts`. There are
no CORS headers: the desktop app is not a browser origin, and every response is `no-store`.
Secrets are stored only as SHA-256 hex digests; timestamps are epoch milliseconds.

Credits are integers in **micro-USD** (1e-6 USD; a $5 pack is 5_000_000). Every request the proxy
answers is charged at `cloudChargeMicros` from `src/shared/cloudRates.ts` — the provider price
times `CLOUD_RATE_MULTIPLIER` — so the app and the Worker publish one rate. A charge is applied
after the answer, so the last request may leave the balance slightly negative; the next one is
refused. Purchases and refunds are idempotent on `credit_events.order_ref`
(`<event_name>:<order id>`): a replayed delivery answers 200 and changes nothing.

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

## Database

One D1 database, `mythscribe` (binding `DB`), migrations in `migrations/` — numbered, never
edited once applied, same rule as the app's SQLite migrations. `0001_auth.sql` holds users,
login attempts, and sessions; `0002_credits.sql` the balance (`credits`) and its ledger
(`credit_events`); `0003_diagnostics.sql` the two diagnostics aggregates (`diagnostic_counts`,
`diagnostic_crashes`), which belong to no user.

```
npm run cloud:migrate                      # apply to the remote database
npx wrangler d1 migrations apply mythscribe --local --config cloud/wrangler.toml
```

## Secrets

All three are **Worker secrets**, never a file in the repo and never inside the desktop app.

```
npx wrangler secret put RESEND_API_KEY               # sign-in emails (F-15.2)
npx wrangler secret put OPENAI_API_KEY               # the AI proxy (F-15.4)
npx wrangler secret put LEMONSQUEEZY_WEBHOOK_SECRET  # signs the billing webhook (F-15.3)
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
2. Create one **one-time** product per credit pack ($5, $20). $1 paid is $1 of credit — the
   margin lives in the rate (`CLOUD_RATE_MULTIPLIER`), not in the pack price. Note each
   product's **variant id** and its **buy link** (`https://<store>.lemonsqueezy.com/buy/<uuid>`).
3. Put them in `LEMONSQUEEZY_PACKS` in `wrangler.toml` (the commented example shows the shape)
   and deploy. A malformed value is logged and treated as "no packs on sale"; the Account tab
   then says so rather than failing.
4. Settings › Webhooks: add `https://api.mythscribe.app/billing/lemonsqueezy` with the events
   `order_created` and `order_refunded`, and a signing secret of your own choosing.
5. `npx wrangler secret put LEMONSQUEEZY_WEBHOOK_SECRET` and paste the same secret.
6. `npm run cloud:migrate` (once, for `0002_credits.sql`) and `npm run cloud:deploy`.
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
