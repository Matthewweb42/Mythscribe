# AI access and billing spec

> Provided by the author on 2026-10-07 as source of truth ("Use it as truth"). Where it conflicts with something already
> built, ask the author before changing it (see "How to use this document" below). Gap report and decisions: see
> `QUESTIONS.md` and the plan files.

This document specifies how the app connects to AI models and how hosted AI usage is paid for. It is written for Claude Code working in an existing codebase.

## How to use this document

Most of the app already exists. Do not rewrite working code to match this spec's naming or structure.

1. Read the existing code that touches AI calls, settings, accounts, and any payment or backend code.
2. Produce a gap report: for each numbered requirement below, mark it `done`, `partial`, or `missing`, with file references.
3. Stop and show the gap report before making changes.
4. Implement gaps in the order given in "Build order". Follow the conventions, language, and libraries already in the repo.
5. If a requirement conflicts with something already built, ask instead of guessing.

Endpoint paths, table names, and field names below are suggestions. Requirements marked MUST are not.

## Product context

- Desktop writing app for authors, with its own editor. Manuscripts and worldbuilding notes are stored locally on the user's machine.
- AI features: document management, line edits, sorting, compilation, ghost writing, suggested edits, drafting, tagging, consistency checking, chat queries, general assistance.
- This is a passion project. The goal is break-even and accessibility, not margin.
- Two audiences must both be served: technical users who want raw cost and control, and non-technical authors who must never have to see an API key.

## Monetization rules

- M1. The app is sold as a one-time purchase (default `$30`). No subscription.
- M2. Using your own API key or a local model is free, has no markup, and MUST NOT route through our servers.
- M3. Hosted AI is paid from a prepaid balance held in real US dollars, not abstract credits.
- M4. Packs: `$10`, `$25`, `$50`. Minimum purchase is `$10`.
- M5. Balances never expire.
- M6. Hosted usage is billed at provider cost plus a markup (default `20%`).
- M7. New accounts get a one-time trial grant (default `$1.00`) after email verification. One grant per verified email.
- M8. The user can choose the model for any hosted or own-key request. A default "Auto" mode routes by task (see R4).

## Architecture

### Provider interface

- A1. All AI features MUST call models through one internal interface. No feature may call a provider SDK directly.
- A2. The interface has three interchangeable backends:
  - `hosted`: sends requests to our metering proxy, paid from the user's balance.
  - `byok`: calls a provider directly from the app with the user's own key. OpenRouter is the default supported provider; others are optional.
  - `local`: calls a local model server on the user's machine.
- A3. Every feature MUST work on all three backends. A feature may degrade (for example, slower or lower quality on a small local model) but may not be hidden based on backend.
- A4. The interface returns token usage (input, output, cached if available) for every call on every backend.

### Backend services (hosted mode only)

- A5. Auth service: passwordless email sign-in (magic link or code). Issues a short-lived access token and a refresh token.
- A6. Metering proxy: authenticates, rate-limits, places a hold, forwards to the model gateway using our key, streams the response, then settles.
- A7. Balance ledger: the source of truth for money.
- A8. Checkout: handled by a third-party merchant of record that collects sales tax and VAT. We never handle card data.
- A9. Model gateway: a single upstream that exposes many models (OpenRouter by default), so adding a model is a config change.

## Flows

### Sign-in and purchase

1. User enters email, receives a link or code, and is signed in. The app stores tokens in the OS keychain.
2. User picks a pack. The app requests a checkout session and opens the returned URL in the system browser.
3. The checkout provider calls our payments webhook. We verify the signature and write one `topup` ledger entry.
4. The app refreshes the balance (poll on window focus, or after the browser returns).

### Hosted request

1. The app builds the request locally. It includes only the context the task needs (see R5), counts input tokens, and sets an explicit `max_tokens`.
2. For any job whose estimated cost exceeds the quote threshold (default `$0.25`), the app shows the estimate and waits for confirmation.
3. The app sends the request to the proxy with the access token and an `Idempotency-Key`.
4. The proxy, in one database transaction: checks available balance, then creates a hold equal to the worst-case cost (see "Pricing math"). If balance is insufficient it returns a specific error and forwards nothing.
5. The proxy forwards to the gateway and streams the response to the app.
6. On completion the proxy reads actual usage from the gateway response, writes one `charge` ledger entry for the real cost, and closes the hold.
7. On upstream failure with no usage reported, the proxy closes the hold with no charge.
8. The app shows the actual cost of the job and the new balance.

### Own-key and local requests

1. The app calls the provider or local server directly. Nothing is sent to our backend.
2. The app still shows token usage, and an estimated cost for own-key requests when the price is known.

## Ledger

- L1. The ledger MUST be append-only. Never update or delete a money row. Corrections are new rows.
- L2. Store all amounts as signed integers in micro-dollars (`1 USD = 1,000,000`). Never use floats for money.
- L3. Entry types: `topup`, `trial_grant`, `charge`, `refund`, `adjustment`.
- L4. Each entry records: user, type, amount, idempotency key (unique), created time, and for charges: request id, model, input tokens, output tokens, provider cost, markup applied.
- L5. Holds live in a separate table with status `active`, `settled`, or `released`, and an expiry (default 10 minutes). A background job releases expired holds.
- L6. Available balance = sum of ledger entries minus sum of active holds.
- L7. Balance check and hold creation MUST happen in one transaction with a lock on the user's balance, so concurrent requests cannot overspend.
- L8. Webhooks and proxy requests MUST be idempotent. A replayed webhook or retried request never creates a second entry.

## Pricing math

- P1. The server holds a price table: per model, input price and output price per million tokens (plus cached-input price where supported), and a display multiplier relative to the default model.
- P2. `provider_cost = input_tokens * input_price + output_tokens * output_price`
- P3. `charge = ceil(provider_cost * (1 + markup))`, in micro-dollars.
- P4. `hold = ceil((input_tokens * input_price + max_tokens * output_price) * (1 + markup))`. Because `max_tokens` caps output, the charge can never exceed the hold.
- P5. The app fetches the price table from the server and caches it. The app MUST NOT hardcode prices.
- P6. Price or markup changes apply to new requests only.

## Estimates and display

- E1. Show the balance in dollars at all times in hosted mode.
- E2. Next to the balance, show an approximate remaining capacity, for example "about 140,000 words of line editing left". Compute it from measured per-word cost constants for the default model, stored in server config.
- E3. Describe packs by example, tied to actions and the default model. Example: "$10 covers about one full line edit plus a consistency check on a 100,000-word novel."
- E4. Pad every published or displayed estimate by a safety factor (default `20%`).
- E5. Non-default models are labeled with a multiplier, for example "Premium: about 2x".
- E6. Warn when the balance drops below a threshold (default `$2.00`). No automatic top-up.
- E7. Provide a usage history view: date, action, model, tokens, cost.

## Request design

- R1. Large jobs (full-manuscript edit, full consistency check) MUST be split into chunks, each sent and billed as its own request.
- R2. A chunked job MUST be resumable. If it stops midway, completed chunks are kept and only the remaining chunks are run.
- R3. The quote for a chunked job is the sum of its chunk estimates.
- R4. Auto mode routes by task: small models for tagging, sorting, and simple checks; stronger models for drafting, line edits, and ghost writing. The mapping lives in config. The user can override per task or globally.
- R5. Retrieve only relevant worldbuilding notes for each request instead of sending whole documents.
- R6. Use provider prompt caching where available for context reused across chunks, and pass the savings through via the cached-input price.

## Security and privacy

- S1. Our provider key exists only on the server. It MUST NOT appear in the app bundle, config files, or logs.
- S2. Users' own keys are stored only in the OS keychain and are never sent to our backend.
- S3. The proxy MUST NOT store or log prompt or response content. It logs only: user id, request id, model, token counts, cost, status, timing.
- S4. Rate limits per user: requests per minute and a maximum input size per request (both in config).
- S5. Verify webhook signatures. Reject unsigned or stale webhooks.
- S6. Access tokens are short-lived. Refresh tokens are revocable.

## Suggested API surface

| Method | Path | Purpose |
|---|---|---|
| POST | `/auth/start` | Send sign-in email |
| POST | `/auth/verify` | Exchange code for tokens |
| POST | `/auth/refresh` | Refresh access token |
| GET | `/v1/balance` | Available balance and active holds |
| GET | `/v1/pricing` | Price table, packs, markup, estimate constants |
| GET | `/v1/usage` | Paginated usage history |
| POST | `/v1/checkout` | Create checkout session, return URL |
| POST | `/v1/completions` | Metered, streaming model request |
| POST | `/webhooks/payments` | Payment provider webhook |

Error responses from `/v1/completions` MUST distinguish: `insufficient_balance`, `rate_limited`, `request_too_large`, `model_unavailable`, `upstream_error`.

## Copy rules

- C1. Never claim the tool replaces a human editor. Do not compare its price to the cost of hiring one.
- C2. Position hosted AI as convenience: one balance, every model, pay only for what you use.
- C3. State the privacy rule (S3) in plain language on the purchase screen.
- C4. Never show the word "tokens" to hosted users by default. Show dollars and words. Token counts may appear in an advanced or usage view.

## Config defaults

| Key | Default |
|---|---|
| `app_price_usd` | 30 |
| `pack_sizes_usd` | 10, 25, 50 |
| `markup` | 0.20 |
| `trial_grant_usd` | 1.00 |
| `quote_threshold_usd` | 0.25 |
| `estimate_safety_factor` | 1.20 |
| `low_balance_warning_usd` | 2.00 |
| `hold_expiry_minutes` | 10 |

All of these MUST be changeable without an app release.

## Non-goals

- No subscriptions, no expiring credits, no automatic top-ups.
- No storage of manuscripts or notes on our servers.
- No team or shared balances.
- No in-app card form. Checkout always happens with the third-party provider.

## Build order

1. Provider interface (A1 to A4) with `byok` and `local` backends.
2. Usage instrumentation, so real per-task costs can be measured on real manuscripts.
3. Auth, ledger, and holds (A5, A7, L1 to L8).
4. Metering proxy and `hosted` backend (A6, A9, P1 to P6).
5. Checkout and webhook (A8).
6. Quotes, balance display, usage history (E1 to E7).
7. Chunked, resumable jobs and caching (R1 to R6), if not already present.

## Acceptance checks

- Two simultaneous requests from one user with balance for only one: exactly one succeeds.
- A webhook delivered twice adds the balance once.
- A request retried with the same idempotency key is charged once.
- A failed upstream call leaves the balance unchanged once the hold is released.
- A charge is never larger than its hold.
- Sum of ledger entries always equals the displayed balance plus active holds.
- With the network to our backend blocked, own-key and local modes still work fully.
- Searching the built app bundle and server logs finds no provider key and no manuscript text.
- A full-manuscript job interrupted halfway resumes without re-running or re-billing finished chunks.

## Open decisions

Ask the project owner before implementing anything that depends on these:

- Which merchant of record to use for checkout.
- Whether the gateway is OpenRouter or direct provider APIs.
- The default model and the Auto routing table.
- The measured per-word cost constants used for estimates (E2, E3). These must come from real measurements, not guesses.
- Refund policy for unused balance.
