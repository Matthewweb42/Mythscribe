# AI access & billing — gap report (2026-10-07)

Spec: `docs/research/AI-BILLING-SPEC.md`. Code read on 2026-10-07 (read-only; nothing run). Status: done / partial / missing.
Paths are repo-relative.

**Totals:** 54 numbered requirements (M/A/L/P/E/R/S/C): 11 done, 31 partial, 12 missing. Flows (14 steps): 5 done, 8 partial,
1 missing. API surface (9): 3 done, 3 partial, 3 missing; error codes partial. Config defaults (8): 0 done, 2 partial, 6
missing/conflict (only the pack list is changeable without a release). Acceptance checks (9): 2 pass, 2 fail, 1 n/a (no
holds), 4 partial/unverified.

State of hosted AI: the Worker routes exist and are tested, but hosted AI is switched off in the app
(`CLOUD_AI_AVAILABLE = false`, src/shared/cloudApi.ts:28; the Cloud adapter refuses every call, src/main/ai/providers/cloud.ts:60).
Operator steps (Lemon Squeezy store, packs, deploy) are open (CLAUDE.md:31).

## Author decisions so far (2026-10-07)
- M1: the app is a **$30 one-time purchase** (the spec's default). The $39 Supporter license is superseded.
- C1 wins: remove the edit-pass "vs a professional editor" price comparison.
- Merchant of record: **Lemon Squeezy** (already integrated), re-shaped to dollar packs.
- Gateway: **OpenRouter for both** the hosted proxy and the default own-key provider (OpenAI kept as an option).

## Monetization
| ID | Status | Evidence |
|---|---|---|
| M1 | missing (conflict) | App is free; only one-time purchase is the $39 cosmetic Supporter license (cloud/migrations/0004_supporter.sql; CLAUDE.md:22). |
| M2 | done | ownKey/local call the provider directly (src/main/ai/registry.ts:60–85); local priced at 0 (registry.ts:25). |
| M3 | done | Balance in micro-USD, $1 paid = $1 balance (cloud/src/credits.ts:77). UI still says "Credits" (AccountSettingsTab.tsx:148). |
| M4 | partial | Packs from env `LEMONSQUEEZY_PACKS` (cloud/src/index.ts:44,75); documented $5/$20 (cloud/README.md:172); no $10 minimum. |
| M5 | done | No expiry in 0002_credits.sql or credits.ts. |
| M6 | partial (conflict) | Cost × `CLOUD_RATE_MULTIPLIER = 2` (src/shared/cloudRates.ts:11) = 100% markup, not 20%. |
| M7 | missing | No trial grant anywhere. |
| M8 | partial | Model set per tier per provider (src/shared/ai.ts:81–96); no per-request/per-task choice, no Auto. |

## Architecture
| ID | Status | Evidence |
|---|---|---|
| A1 | done | Only providers/openai.ts imports the SDK; all features use `runAiRequest` (src/main/ai/request.ts:269,299); eval harness is the exception. |
| A2 | partial | hosted = `cloud`; byok = OpenAI only, not OpenRouter (registry.ts:75); local = OpenAI-compatible server (registry.ts:18). |
| A3 | done | No feature hidden per source; local shows a quality warning (aiSettings.ts `LOCAL_QUALITY_WARNING`). |
| A4 | partial | in/out tokens on every call (providers/types.ts:14,39); cached tokens never read (`cachedTokens: null`, request.ts:174,210; openai.ts:85 ignores `prompt_tokens_details`). |
| A5 | partial | Magic link (cloud/src/auth.ts:76–180) issues one 90-day session token (cloudApi.ts:36); no short-lived access / refresh token. |
| A6 | partial | Auth, size caps, streaming, post-answer metering (cloud/src/ai.ts:75–110); no hold, no per-user rate limit. |
| A7 | partial | `credit_events` is the ledger but balance comes from the mutable `credits` row (0002_credits.sql; store.ts:388). |
| A8 | done | Lemon Squeezy hosted checkout URL (credits.ts:115–128); no card data. |
| A9 | partial (conflict) | Upstream is OpenAI direct (cloud/src/openai.ts; index.ts:127); a new model is a code change to `MODEL_PRICING`. |

## Flows
Sign-in & purchase: 1 partial (magic link + poll; token in safeStorage, accountService.ts:29,42) · 2 done (accountStore.ts:166;
credits.ts:115) · 3 done (HMAC, idempotent on `order_ref`, credits.ts:185–234; store.ts:395–433) · 4 partial (refresh on tab
mount + button, AccountSettingsTab.tsx:139–149; not on window focus).

Hosted request: 1 partial (retrieval, explicit maxTokens, token estimate; request.ts:121–129) · 2 partial (estimates only for edit
passes/import, at provider not Cloud price; no general quote threshold) · 3 partial (bearer, no Idempotency-Key) · 4 missing
(only `hasCredit` balance>0, no transaction, no hold; credits.ts:299; ai.ts:86) · 5 done (NDJSON stream, ai.ts:142–245) · 6
partial (usage read, one charge row; no hold) · 7 partial (upstream failure charges nothing; a stream with no usage chunk charges
≥1 micro; cancelled stream charges nothing) · 8 partial (cost line + `account:balanceChanged`; balance not always visible).

Own-key & local: 1 done · 2 done (usage + `priceFor` cost; local 0).

## Ledger
| ID | Status | Evidence |
|---|---|---|
| L1 | partial | `credit_events` insert-only (store.ts:399) but `credits` row UPDATEd in the same batch (store.ts:416–428). |
| L2 | done | Integer micro-USD throughout. |
| L3 | partial | Kinds `purchase`, `refund`, `charge`; no `trial_grant`, `adjustment`. |
| L4 | partial | user, kind, amount, feature, model, tokens, request_id, created_at; unique key only `order_ref`; no provider cost / markup stored. |
| L5 | missing | No holds table. |
| L6 | partial | Balance = `credits.balance_micros`; no holds. |
| L7 | missing | 0002 comment explicitly allows overdraw. |
| L8 | partial | Webhook idempotent (UNIQUE `order_ref`); proxy requests not. |

## Pricing math
| ID | Status | Evidence |
|---|---|---|
| P1 | partial | `MODEL_PRICING` (src/shared/ai.ts:396): in/out only; no cached price, no multiplier; compiled, not server-held. |
| P2 | done | cloudRates.ts:44. |
| P3 | partial | ceil + 1-micro minimum (cloudRates.ts:45); markup 2x. |
| P4 | missing | No hold math. |
| P5 | missing (conflict) | Prices hardcoded and bundled (ai.ts:396; CLAUDE.md:32). |
| P6 | partial | Price changes need a Worker deploy; displayed rates need an app release. |

## Estimates & display
| ID | Status | Evidence |
|---|---|---|
| E1 | partial | Balance only in the Account tab (AccountSettingsTab.tsx:156); status bar shows warnings only (CreditNotice.tsx). |
| E2 | missing | Days-left projection, not words left (shared/cloudUsage.ts:121). |
| E3 | missing | Packs labelled "Buy $X" only. |
| E4 | missing | No safety factor. |
| E5 | missing | Raw per-1M rate table (AccountSettingsTab.tsx:241), no multiplier labels. |
| E6 | partial | Hardcoded $1.00 (`LOW_BALANCE_MICROS`, cloudUsage.ts:98) + run-out/empty warnings; no auto top-up. |
| E7 | partial | Cloud: 30-day per-feature aggregate (credits.ts:89–108); local ledger: last 10 requests; no `/usage` route. |

## Request design
| ID | Status | Evidence |
|---|---|---|
| R1 | partial | Edit passes chunk per scene/paragraph, each its own request (src/main/ai/editPass.ts:60–66; shared/editPass.ts `chunkText`). |
| R2 | partial | Resume per finished scene (editPass.ts:578,628,687); finished chunks re-served from the local cache at 0 cost. |
| R3 | partial | Edit-pass estimate sums chunks, at provider price even on Cloud. |
| R4 | partial (conflict) | Two tiers fixed per feature (`TIER_USE`, ai.ts:25; `EDIT_PASS_TIER`); user overrides only model per tier. |
| R5 | done | Ranked retrieval (context/queryContext.ts:24–47), continuity refs. |
| R6 | partial | OpenAI automatic prefix caching implicit; cached tokens not measured; billed at full input rate (ai.ts:390–395). |

## Security & privacy
| ID | Status | Evidence |
|---|---|---|
| S1 | done | Operator key only a Worker secret (index.ts:49,127); bundle not searched. |
| S2 | partial (conflict) | Electron safeStorage (src/main/ai/keyStore.ts:42–78), plain-text fallback on Linux `basic_text` (keyStore.ts:48); never sent to backend. |
| S3 | done | `logAnswer` logs ids and numbers only (+ feature id) (ai.ts:40–54). |
| S4 | partial | Input caps 200k chars / 64 msgs / 4000 max tokens (cloudApi.ts:220–222), constants not config; no req/min limit. |
| S5 | partial | HMAC timing-safe (credits.ts:185–189); no staleness check. |
| S6 | partial | 90-day session, revocable via `/auth/signout` (auth.ts:224); no short-lived access token. |

## API surface
| Spec route | Status | Existing |
|---|---|---|
| POST /auth/start | done | `/auth/start` (index.ts:139) |
| POST /auth/verify | partial | `GET /auth/verify` + `POST /auth/poll` (index.ts:140–141); no code exchange |
| POST /auth/refresh | missing | — |
| GET /v1/balance | partial | `GET /credits` (index.ts:145); no holds |
| GET /v1/pricing | missing | rates bundled in app (`CLOUD_RATES`, cloudRates.ts:73) |
| GET /v1/usage | missing | aggregate only inside `/credits` |
| POST /v1/checkout | done | `POST /billing/checkout` (index.ts:146) |
| POST /v1/completions | partial | `POST /ai/complete` (index.ts:154); no idempotency/holds |
| POST /webhooks/payments | done | `POST /billing/lemonsqueezy` (index.ts:147) |

Error codes partial (cloudApi.ts:174–211): insufficient_balance → `INSUFFICIENT_CREDITS` (402); rate_limited → `RATE_LIMITED`
(upstream busy only); upstream_error → `UPSTREAM`; request_too_large and model_unavailable both collapse into `BAD_REQUEST`.

## Copy rules
| ID | Status | Evidence |
|---|---|---|
| C1 | missing (violated) | "A professional line edit … typically costs $X to $Y" (EditPassWorkspace.tsx:182; EditPassReport.tsx:122; `PRO_RATES_PER_WORD`, shared/editPass.ts:175–191). |
| C2 | partial | "charged to your credits at the published rate"; only 3 OpenAI models. |
| C3 | missing | No privacy statement in the Credits section. |
| C4 | partial (violated) | Tokens column (AccountSettingsTab.tsx:199), per-1M rates (:241), tokens in the edit-pass report. |

## Config defaults
`app_price_usd` missing · `pack_sizes_usd` partial (env) · `markup` conflict (2.0 hardcoded) · `trial_grant_usd` missing ·
`quote_threshold_usd` missing · `estimate_safety_factor` missing · `low_balance_warning_usd` partial ($1.00 hardcoded) ·
`hold_expiry_minutes` missing. Not in spec: an app-side daily spend cap ($2 default, all sources; ai.ts:428; request.ts:137–141).

## Non-goals
All met in code (no subscription, no expiry, no auto top-up, no manuscripts on servers, no team balances, no in-app card form).
CLAUDE.md:6,22 still says "subscription" — doc fix only.

## Acceptance checks
1. Concurrent requests, balance for one: **fail** (both pass `hasCredit`; overdraw).
2. Webhook twice credits once: **pass**.
3. Retry with same idempotency key charged once: **fail** (no key).
4. Failed upstream leaves balance unchanged: **pass** (error path).
5. Charge never > hold: **n/a** (no holds).
6. Ledger sum = balance + holds: **partial** (equal by construction; no holds).
7. Own-key/local with backend blocked: **likely pass by design**; no test.
8. No provider key / manuscript text in bundle or logs: **unverified**.
9. Interrupted full-manuscript job resumes without re-billing: **partial** (per scene; chunks from cache).

## Conflicts (exists → spec → options)
1. **Revenue model.** Free app + $39 cosmetic Supporter → $30 one-time app (M1). *Decided: $30 one-time.* Open: how the purchase
   gates the app (trial? which features?) — conflicts with "every feature works without it" copy (AccountSettingsTab.tsx:32).
2. **"Subscription" in CLAUDE.md.** Doc says Cloud subscription; code has none → fix the doc.
3. **Markup & packs.** 2x; $5/$20 → +20%; $10/$25/$50. Check 20% covers Lemon Squeezy (~5% + 50¢; ~10% on $10).
4. **Hardcoded MODEL_PRICING** → server price table + `/pricing`, app caches (keep bundled table as own-key estimate fallback).
5. **Gateway/BYOK.** OpenAI direct → OpenRouter. *Decided: OpenRouter for both.* OpenRouter is OpenAI-compatible (openai.ts with
   `baseURL`, as the local adapter does).
6. **Charge-after vs holds.** Overdraw by design → transactional holds + expiry job (D1 batch with conditional insert + Cron
   Trigger). Acceptance check 1 needs this.
7. **C1.** *Decided: remove the comparison* (`PRO_RATES_*`, `proLowUsd`/`proHighUsd`, UI lines, tests). Pass names and the
   prompt wording "a professional editor edits it" (prompts/editPass.v1.ts:13) are not price claims — confirm.
8. **Tiers vs Auto routing (R4, M8).** Option (a): tiers become the routing table (Auto = default tier map), per-feature model
   overrides in AiSettings, hosted map from server config — keeps the CLAUDE.md "tier, never model name" rule.
9. **Tokens shown to hosted users (C4, E2, E5).** Rework Credits section and F-15.11 rate lines; words-left needs measured constants.
10. **Key storage (S2).** safeStorage (keychain-backed) with Linux plain-text fallback → accept safeStorage and refuse saving in
    `basic_text`, or add a native keychain dependency.
11. **Session model (A5, S6).** 90-day revocable token → short access + revocable refresh token, or accept current.
12. **Idempotency, rate limits, webhook staleness, error codes** — additive changes (unique idempotency key on charges, D1 counter
    or Durable Object limiter, event `created_at` staleness check, `REQUEST_TOO_LARGE` / `MODEL_UNAVAILABLE`).
13. **Trial grant (M7)** — `trial_grant` event on first verified account, unique per email.
14. **Low-balance threshold** $1.00 → $2.00 from config (keep run-out warning as extra).
15. **Refund behaviour** — full-pack debit today; spec open decision.
16. **"Credits" wording** → "Balance" (amounts already USD).
17. **Quote threshold & estimates** — confirm jobs > $0.25 with 20% safety factor; price estimates through the provider's price;
    keep or drop the daily cap.
18. **Job resume per chunk (R2)** — record finished chunk indexes so a cache miss never re-bills.
19. **Local provider** — matches A2; warn on a non-loopback URL if "nothing leaves the machine" is promised (`isLoopbackUrl`, ai.ts:68).

## Spec open decisions
- Merchant of record — *decided: Lemon Squeezy.*
- OpenRouter vs direct — *decided: OpenRouter for both.*
- Default model and Auto routing table — currently gpt-5.4-mini (fast) / gpt-5.4 (strong).
- Measured per-word cost constants (E2/E3) — none exist; must come from real measurements.
- Refund policy for unused balance — currently full-pack debit on refund.
