# MythScribe Cloud API (`cloud/`)

The Worker behind `api.mythscribe.app`. It serves the **account** routes (F-15.2: email magic
link, sessions) today; the AI proxy the app uses when a project runs on MythScribe's key
(F-15.4, F-15.11) joins the same router later. It never sees the author's own key and never
stores manuscript text — the account routes store an email address and hashes.

Source: `src/index.ts` (router), `src/auth.ts` (handlers, pure over a store + mailer + clock),
`src/store.ts` (D1 and in-memory stores), `src/email.ts` (Resend / log transports),
`src/pages.ts` (the two HTML pages), `src/crypto.ts` (tokens, hashes). The wire contract is
shared with the desktop app in `src/shared/cloudApi.ts` and imported from there, not copied.

## Routes

| Route | Purpose |
| --- | --- |
| `GET /` | `{ "service": "mythscribe-api" }`, a liveness answer |
| `POST /auth/start` | `{ email }` → `{ attemptId, pollSecret, expiresAt }`; emails the sign-in link. 3 per address per 15 minutes; 503 `NOT_CONFIGURED` when no mail transport is set |
| `GET /auth/verify?t=` | the link in the email: approves the attempt once, mints the session, renders an HTML page (410 page when expired or already used) |
| `POST /auth/poll` | `{ attemptId, pollSecret }` → `pending` / `ready` (the session, handed over exactly once) / `expired` |
| `GET /auth/me` | `Authorization: Bearer <session>` → `{ email, userId, since }`; 401 when revoked or expired |
| `POST /auth/signout` | same header; revokes the session, always 204 |

Errors are `{ code, message }` with the codes and statuses in `src/shared/cloudApi.ts`. There are
no CORS headers: the desktop app is not a browser origin, and every response is `no-store`.
Secrets are stored only as SHA-256 hex digests; timestamps are epoch milliseconds.

## Database

One D1 database, `mythscribe` (binding `DB`), migrations in `migrations/` — numbered, never
edited once applied, same rule as the app's SQLite migrations.

```
npm run cloud:migrate                      # apply to the remote database
npx wrangler d1 migrations apply mythscribe --local --config cloud/wrangler.toml
```

## Secrets

Both are **Worker secrets**, never a file in the repo and never inside the desktop app.

```
npx wrangler secret put RESEND_API_KEY     # sign-in emails (F-15.2)
npx wrangler secret put OPENAI_API_KEY     # the AI proxy (F-15.4)
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
