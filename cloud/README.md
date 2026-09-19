# MythScribe Cloud API (`cloud/`)

The Worker behind `api.mythscribe.app`. It serves the **account** routes (F-15.2: email magic
link, sessions) and the **credit** routes (F-15.3: balance, Lemon Squeezy checkout and webhook,
the meter); the AI proxy the app uses when a project runs on MythScribe's key (F-15.4, F-15.11)
joins the same router later. It never sees the author's own key and never stores manuscript
text — it stores an email address, hashes, and amounts.

Source: `src/index.ts` (router), `src/auth.ts` (account handlers, pure over a store + mailer +
clock), `src/credits.ts` (credit handlers and the meter), `src/store.ts` (D1 and in-memory
stores), `src/email.ts` (Resend / log transports), `src/pages.ts` (the two HTML pages),
`src/crypto.ts` (tokens, hashes, the webhook HMAC). The wire contract is shared with the desktop
app in `src/shared/cloudApi.ts` and the rates in `src/shared/cloudRates.ts`, imported from there,
not copied.

## Routes

| Route | Purpose |
| --- | --- |
| `GET /` | `{ "service": "mythscribe-api" }`, a liveness answer |
| `POST /auth/start` | `{ email }` → `{ attemptId, pollSecret, expiresAt }`; emails the sign-in link. 3 per address per 15 minutes; 503 `NOT_CONFIGURED` when no mail transport is set |
| `GET /auth/verify?t=` | the link in the email: approves the attempt once, mints the session, renders an HTML page (410 page when expired or already used) |
| `POST /auth/poll` | `{ attemptId, pollSecret }` → `pending` / `ready` (the session, handed over exactly once) / `expired` |
| `GET /auth/me` | `Authorization: Bearer <session>` → `{ email, userId, since }`; 401 when revoked or expired |
| `POST /auth/signout` | same header; revokes the session, always 204 |
| `GET /credits` | bearer → `{ balanceMicros, spend[], packs[] }` (F-15.3); the balance in micro-USD, lifetime spend per AI feature, and the packs on sale |
| `POST /billing/checkout` | bearer + `{ variantId }` → `{ url }`; the pack's Lemon Squeezy checkout with `custom[user_id]` and the email stamped on it. The app opens it, never builds it |
| `POST /billing/lemonsqueezy` | the webhook. `X-Signature` = HMAC-SHA256 hex of the raw body with `LEMONSQUEEZY_WEBHOOK_SECRET`; `order_created` (status `paid`) credits the pack price, `order_refunded` debits it, everything else answers 200 and is ignored |

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

## Database

One D1 database, `mythscribe` (binding `DB`), migrations in `migrations/` — numbered, never
edited once applied, same rule as the app's SQLite migrations. `0001_auth.sql` holds users,
login attempts, and sessions; `0002_credits.sql` the balance (`credits`) and its ledger
(`credit_events`).

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
cp cloud/.dev.vars.example cloud/.dev.vars    # EMAIL_TRANSPORT=log, PUBLIC_ORIGIN=http://127.0.0.1:8787
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
