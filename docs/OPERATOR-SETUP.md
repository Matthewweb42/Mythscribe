# Operator setup: OpenRouter, Lemon Squeezy, and turning MythScribe Cloud on

Written 2026-10-07 for the business model in `docs/research/AI-BILLING-SPEC.md` ($30 one-time app with a 30-day trial;
own key / local model free; hosted AI as a prepaid US-dollar balance at provider cost + 20%). Everything here is done by you, on
your accounts; nothing in this guide has been run yet. The code side is finished and tested.

Menu names on the OpenRouter and Lemon Squeezy websites change from time to time. If a label here doesn't match exactly, look
for the nearest equivalent.

**Order matters.** Follow the parts in this order:

1. OpenRouter.
2. Lemon Squeezy in test mode.
3. The license key pair.
4. Deploy the Worker.
5. Test end to end in test mode.
6. Go live.
7. Release.

---

## Part 1 — OpenRouter (the AI gateway)

OpenRouter sells access to many models (DeepSeek, OpenAI, Anthropic, Google…) through one OpenAI-compatible API. MythScribe
uses it in two separate ways, and they need **two separate keys**:

- **Hosted AI (MythScribe Cloud):** the Cloud server (the Worker) calls OpenRouter with *your operator key* and charges the
  writer's balance at cost + 20%.
- **Your own writing:** the desktop app's "My own key" source calls OpenRouter directly with *your personal key*. Nothing goes
  through the Worker.

Keeping two keys means your own writing never shows up in the business's spend, and you can cap the business key separately.

### 1.1 Account and credit
1. Sign up at https://openrouter.ai and verify your email.
2. Open **Credits** and add a small amount to start (for example $10–20). OpenRouter is prepaid: requests fail when the credit runs
   out. A small fee may be added when you buy credit; the Credits page shows it.
3. Optional, for the operator account only: turn on **auto top-up** with a sensible threshold, so hosted AI never stops because
   the operator balance ran dry. Users of MythScribe never get auto top-up; that rule is about *their* balance, not yours.

### 1.2 Privacy settings (important: this backs the promise on the website)
The site and the purchase screen promise that hosted requests are "passed through, not stored or logged by us". That covers
**our** server. What OpenRouter and the model providers keep is set in OpenRouter's privacy settings:

1. Open **Settings › Privacy** (sometimes called "Data policy").
2. Turn **off** anything that allows providers to train on your prompts, or to use them for model improvement.
3. If OpenRouter offers a "zero data retention" or "no prompt logging" option, consider turning it on. Be aware this can narrow
   which providers serve a model, and some cheap providers may drop out.
4. DeepSeek models on OpenRouter are often served by several providers. With training turned off, OpenRouter only routes to
   providers that respect that. If requests then fail with "no provider available", go back to Privacy and loosen the setting
   deliberately; don't do it by accident.

The research report flags this exact risk (§7.8): never claim more privacy than the upstream actually gives. If you can't get
"no retention" from the providers you use, the privacy page should say "our servers don't store or log it; the model provider's
retention policy applies".

### 1.3 Keys
1. Open **Keys › Create key**.
2. Create **"mythscribe-cloud-worker"**. Give it a **credit limit** (for example $50 to start) so a bug can never empty the account.
   Copy it right away; it's shown only once.
3. Create **"matthew-personal"** for your own writing, with its own limit.

### 1.4 Put the operator key on the Worker
From the repo root, in WSL:
```bash
cd cloud
npx wrangler secret put OPENROUTER_API_KEY     # paste the mythscribe-cloud-worker key
cd ..
```
- The secret lives only on Cloudflare. It is never in the app, `wrangler.toml`, or git (spec S1).
- While `OPENROUTER_API_KEY` is set, the Worker uses it instead of the older `OPENAI_API_KEY`. You can delete the old one later
  with `npx wrangler secret delete OPENAI_API_KEY`.
- Rotating the key means running the same `secret put` with the new value; no redeploy is needed.

### 1.5 Use your personal key in the app
1. In MythScribe, open **Settings › AI**.
2. Set **Source** to **My own key**, and set **Provider** to **OpenRouter** (the default for new keys).
3. Paste the "matthew-personal" key, then press **Test connection**.
4. Leave **Auto** routing on: DeepSeek V4 Flash for background work, DeepSeek V4 Pro for writing tasks.

The key is stored only in Windows' secure store; MythScribe refuses to save it anywhere less safe.

### 1.6 The models and their prices
The defaults (approved 2026-10-07) are `deepseek/deepseek-v4-flash` (fast tier) and `deepseek/deepseek-v4-pro` (strong tier).
List prices (F-16.1, corrected 2026-10-11), per million tokens, with no cached-input discount assumed:
- flash: $0.14 in / $0.28 out
- pro: $1.74 in / $3.48 out

The 2026-10-07 figures ($0.03 / $1.28 and $0.21 / $0.42) were wrong: Flash's $0.03 input most likely came from a
`-latest` listing, and Pro's was an expired promotion (about an eighth of list). Both the app's own-key table and the
Worker's default `models` read one generated module, `src/shared/modelPrices.ts`.

**Check them with the probe.** `OPENROUTER_API_KEY=sk-or-… npm run ai:probe -- -u` (about 5¢, one live run) reads
OpenRouter's listing and per-provider prices, measures prompt-cache hits and thinking tokens, writes a dated report and its
numbers to `docs/research/story-memory-2026-10-11/probe/`, and, only where OpenRouter's prices differ from the table,
rewrites `src/shared/modelPrices.ts` (check with `git diff`). A cached-input price is written only when the runs show cache
hits billed lower than the listed price. Then run `npm run eval:ai -- -u` and update the `models` row (4.3) from the report.
Without `-u` the same run only compares: it passes when the prices match and fails showing the differences. To accept those
afterwards without spending again, replay the saved numbers:
`AI_PROBE_REPLAY=docs/research/story-memory-2026-10-11/probe/ai-probe-<date>.json npm run ai:probe -- -u` (no calls).
The probe also takes `OPENAI_API_KEY` when `OPENAI_BASE_URL=https://openrouter.ai/api/v1` (the older form).

**One key for every live run (F-16.22).** The same `OPENROUTER_API_KEY` drives every live check; none of them touches the
app, its key store or a project, and none writes a key or prompt text to its report:
```bash
OPENROUTER_API_KEY=sk-or-… npm run ai:probe -- -u                              # prices (about 5¢)
MYTHSCRIBE_EVAL_LIVE=1 OPENROUTER_API_KEY=sk-or-… npm run eval:ai -- prompts   # live fidelity of every prompt version
MYTHSCRIBE_EVAL_LIVE=1 OPENROUTER_API_KEY=sk-or-… npm run eval:ai -- memory    # story memory's planted errors (stops at 50¢)
MYTHSCRIBE_EVAL_LIVE=1 OPENROUTER_API_KEY=sk-or-… npm run eval:ai -- knows     # who knows what, two passes (stops at 50¢)
MYTHSCRIBE_EVAL_LIVE=1 OPENROUTER_API_KEY=sk-or-… npm run eval:ai -- scribe    # Ms Scribe's 31 test-book questions (stops at $1)
```
`MYTHSCRIBE_EVAL_LIVE=1 OPENROUTER_API_KEY=sk-or-… npm run eval:ai` runs the four eval runs together. The Ms Scribe run
reads the test book's memory with the oracle (free) unless `MYTHSCRIBE_EVAL_READ=live` is set, which reads it with the live
reader and checker first (about 13¢ more; an environment variable because vitest refuses unknown flags such as `--read`). They use V4 Flash
and V4 Pro unless `MYTHSCRIBE_EVAL_FAST_MODEL` / `MYTHSCRIBE_EVAL_STRONG_MODEL` name others; `OPENAI_API_KEY` (with
`OPENAI_BASE_URL` for OpenRouter or another OpenAI-compatible server) still works when `OPENROUTER_API_KEY` is not set.
Reports: `test-results/eval-ai/live-report.md`, `test-results/eval-memory/planted-<date>.md` and
`test-results/eval-knows/knows-<date>.md` and `test-results/eval-scribe/scribe-<date>.md` (each with a `.json`); copy the
story-memory ones into `docs/research/story-memory-2026-10-11/eval/` and commit them. In a cloud session the key is an environment secret, and
`openrouter.ai` must be allowed in the environment's network access.

Prices move. To check today's prices without logging in:
```bash
curl -s https://openrouter.ai/api/v1/models | python3 -c "import json,sys;[print(m['id'],float(m['pricing']['prompt'])*1e6,float(m['pricing']['completion'])*1e6) for m in json.load(sys.stdin)['data'] if m['id'].startswith('deepseek/deepseek-v4')]"
```
When a price changes, update the server's price table (see 4.3). This needs no app release: the app fetches prices from the
server (spec P5).

### 1.7 Monitoring
- OpenRouter's **Activity** page shows spend per key and per model. Compare it now and then with the ledger (4.4): hosted
  revenue should be about 1.25× the operator key's spend, minus payment fees. (The Worker's ledger keeps its own price-table
  cost per request, not OpenRouter's reported cost; the app's ledger records the charge.)
- Set a low-credit email alert on the operator account if OpenRouter offers one.

### 1.8 Reasoning and routing (story memory, 2026-10-11)
How much each model may think is server config: the `reasoning` field of its entry in the `models` row (4.3), sent upstream
as OpenRouter's `reasoning` parameter. `off` turns thinking off, `low` asks for a little, and leaving it out is the model's
default. The default table sets V4 Flash to `off`: the fast tier runs the app's background JSON (summaries now, the
story-memory reader later) under small output caps, where thinking would eat the whole cap. As JSON in the `models` row:
```json
{ "id": "deepseek/deepseek-v4-flash", "label": "DeepSeek V4 Flash", "inputUsdPerM": 0.14, "outputUsdPerM": 0.28,
  "cachedInputUsdPerM": null, "displayMultiplier": 1, "aliases": [], "reasoning": "off" }
```
- **The app may ask for less thinking, never more.** A request can carry `reasoning: "off"` or `"low"`. The Worker sends the
  lower of that and the table's entry (`lowerReasoning`, in the order off < low < default). The app sends `off` only for
  features that never think (`NO_REASONING_FEATURES`); every other request sends nothing, so the table decides.
- **Caveat.** The rule assumes `default` thinks the most. That holds for V4 Pro and the OpenAI reasoning models; the price
  probe (`npm run ai:probe`) checks it for Pro. Give a model that does not think by default `"reasoning": "off"` in its
  entry, so a `low` from the app can never add thinking.
- **No `routing.features` overrides are needed.** The app's own feature → tier choices hold: the story-memory reader,
  verifier, judge, navigator and citation requests run on the fast tier; the chat agent runs on strong; filing an upload into
  sheets runs on strong with reasoning off (the author's decision 6, 2026-10-11).
- **Ms Scribe (P3, 2026-10-13).** In a story memory v2 project the chat sends three feature ids: `navigator`
  (`navigator.v1`, fast, reasoning `off`, at most three short steps a message), `agent` (`agent.v9`, strong, one answer call
  with `reasoning: "off"` on answer, lookup, idea and to-do turns and `"low"` on edit, draft and what-if turns) and `cite`
  (`cite.v1`, fast, reasoning `off`, one short check per cited answer). The Worker already honours the lowering rule above and
  any well-formed feature id, so nothing new needs deploying; `route` and `query` are sent only by v1 projects.
- **Providers.** Leave OpenRouter's `provider.order` unset, but every provider DeepSeek routes to must meet 1.2's privacy
  settings.
- **Deploy order.** Deploy the Worker (lenient feature ids, the `reasoning` field, the corrected default prices) before any
  app build that sends a new feature id. An older Worker refuses an unknown feature id; the `reasoning` field is simply
  dropped by an older Worker, because the body parser strips unknown keys. The Worker now accepts any well-formed feature id
  (a lowercase letter, then 1–39 letters or digits) and meters it under its own name.
- **Prices first.** The Worker is not deployed yet, so its first deploy already carries the corrected default prices
  (F-16.1). If it ever goes live before that change, set the `models` row (4.3) first, or V4 Pro is charged at about an
  eighth of its cost.
- **The probe before the first deploy.** Until the probe (1.6) has run, both default models carry
  `cachedInputUsdPerM: null`, so the Worker bills cached prompt tokens at the full input rate. Most strong-tier input is a
  cached prefix, so Cloud would charge well above provider cost + 25 % for it. Run the probe and commit its price module
  before the Worker's first deploy, or set `cachedInputUsdPerM` by hand in the `models` row (4.3) from OpenRouter's listed
  `input_cache_read` price once you have seen cache hits billed lower on the Activity page (1.7).

---

## Part 2 — Lemon Squeezy (checkout, tax, payouts)

Lemon Squeezy is the merchant of record. It takes the card, charges sales tax and VAT, pays you out, and calls our webhook
when someone pays or gets a refund. MythScribe never touches card data (spec A8).

You sell **five one-time products**:

| Product | Price | What it does |
|---|---|---|
| MythScribe (app license) | $30 | Unlocks the app after the 30-day trial |
| MythScribe AI balance — $10 | $10 | Adds $10 to the account's hosted-AI balance |
| MythScribe AI balance — $25 | $25 | Adds $25 |
| MythScribe AI balance — $50 | $50 | Adds $50 |
| MythScribe AI starter — $5 | $5 | Adds $5. One per account ever, even after a refund; below the $10 minimum on purpose; needs no app license |

$1 paid is $1 of balance. The 25% markup is charged on usage, not on the pack price. New accounts start at $0 (no free
grant since 2026-10-08); the starter pack is how they try hosted AI.

### 2.1 Store, identity, payouts
1. Sign up at https://lemonsqueezy.com and create a store (for example "MythScribe"). The store's subdomain becomes part of
   every buy link (`https://<store>.lemonsqueezy.com/buy/…`).
2. Complete **identity verification** and **payout details** (bank or PayPal). Lemon Squeezy reviews new stores before they can
   sell live, which can take a few days, so start this first.
3. Under the store's settings, set the support email, store name, and logo. These appear on receipts.
4. Turn on **Test mode** (the toggle is usually at the bottom-left of the dashboard). Do everything below in test mode first.

### 2.2 Create the products
For each of the five products:
1. Go to **Products › New product**.
2. Name it, and add a short description. For packs, for example: "Adds $10 to your MythScribe AI balance. Balance never
   expires. Unused balance is refundable within 30 days of purchase." For the starter: "Try the AI for $5. Any unused
   balance is refundable for 30 days. One per account."
3. Set **Pricing: single payment** (one-time), not subscription.
4. Choose the tax category for software / digital goods if asked.
5. **Don't** enable Lemon Squeezy's own "license keys" feature. MythScribe issues its own signed license.
6. **Don't** attach a file. The download comes from the website, not the checkout.
7. Save, then note two values:
   - **Variant ID**: open the product's variant. The number is in the URL or behind a "copy ID" button.
   - **Buy link**: use the product's **Share** button to copy the checkout URL (`https://<store>.lemonsqueezy.com/buy/<uuid>`).

Each product has one variant; its ID is what the webhook matches on.

### 2.3 Tell the Worker about the products
**The easy way:** run `npm run cloud:products`. It asks for each product's buy link, variant ID and price, checks them as you
go, writes the three lines below into `cloud/wrangler.toml`, and asks before deploying. For the variant ID, you can paste the whole
variant page URL; it pulls out the number. Re-run it any time; pressing Enter keeps what's already there.

**By hand,** if you prefer:
Edit `cloud/wrangler.toml`, section `[vars]`. Uncomment the example lines and fill in your values. These aren't secret:
variant IDs and buy links are public.
```toml
LEMONSQUEEZY_PACKS = '[{"variantId":"111111","url":"https://<store>.lemonsqueezy.com/buy/<uuid-10>","priceCents":1000},{"variantId":"222222","url":"https://<store>.lemonsqueezy.com/buy/<uuid-25>","priceCents":2500},{"variantId":"333333","url":"https://<store>.lemonsqueezy.com/buy/<uuid-50>","priceCents":5000}]'
LEMONSQUEEZY_APP_LICENSE = '{"variantId":"444444","url":"https://<store>.lemonsqueezy.com/buy/<uuid-app>","priceCents":3000}'
LEMONSQUEEZY_STARTER = '{"variantId":"555555","url":"https://<store>.lemonsqueezy.com/buy/<uuid-starter>","priceCents":500}'
```
- `priceCents` must match the price in Lemon Squeezy. It is the amount the balance grows by.
- Packs under $10 are refused (`min_pack_usd`). The starter is the one exception, and only as `LEMONSQUEEZY_STARTER`.
- Do not offer discount codes on the AI packs or the starter. A self-serve refund is capped at what was paid, but a full refund issued from the Lemon Squeezy side debits only what was paid, so the discounted part of the balance would stay spendable.
- Leave `LEMONSQUEEZY_SUPPORTER` commented out. The $39 Supporter product is superseded by the $30 app license.
- A malformed value is logged, and the app then says "nothing on sale" instead of crashing. Check the JSON carefully.

The Worker builds the checkout from the buy link and adds the user's id and email (`custom[user_id]`), so the webhook knows
whose balance to credit.

### 2.3b The API key (refunds)
Self-serve refunds from the app, and the automatic refund of a starter order the Worker refuses (a second one, or from an
unverified account), call the Lemon Squeezy API. In Lemon Squeezy, go to **Settings › API**, create a key (test mode first;
live mode needs its own key later), and put it on the Worker:
```bash
cd cloud && npx wrangler secret put LEMONSQUEEZY_API_KEY && cd ..
```
Without it the app's Refund button answers "Refunds are not configured on the server yet." and nothing else changes. Lemon
Squeezy keeps its platform fee on every refund, and a dispute costs $15.

### 2.4 The webhook
1. Generate a signing secret:
   ```bash
   openssl rand -hex 32
   ```
2. In Lemon Squeezy, go to **Settings › Webhooks › Add endpoint**:
   - URL: `https://api.mythscribe.app/billing/lemonsqueezy`
   - Signing secret: the value from step 1
   - Events: `order_created` and `order_refunded`. Nothing else is needed.
3. Put the same secret on the Worker:
   ```bash
   cd cloud && npx wrangler secret put LEMONSQUEEZY_WEBHOOK_SECRET && cd ..
   ```

How the webhook behaves:
- **Wrong signature:** answers 401.
- **No secret configured:** answers 503.
- **Event older than 72 hours:** refused (`STALE_WEBHOOK`).
- **Unknown variant or user:** answers 200 and logs a warning. Lemon Squeezy would otherwise retry for days for nothing.
- **Replays:** a replayed event never credits twice, because every ledger row has a unique key.
- **Refunds and disputes:** `order_refunded` takes the refunded amount off once, never more than the order added. A refund
  of money already spent (your call, or a lost dispute) leaves the balance below zero, and hosted AI stays blocked until the
  account buys a pack.

---

## Part 3 — The license key pair (the $30 app license)

Until this is done, every build ships a **placeholder** public key. Such a build can't verify a license, so it **never ends
the trial** (that safeguard keeps your own installed app writable). Once you paste the real key, builds enforce the trial.

1. From the repo root, run `npm run cloud:license-keygen`. It prints a **private** JWK and a **public** JWK, and stores neither.
2. Put the private key on the Worker. Paste the one-line private JSON exactly as printed:
   ```bash
   cd cloud && npx wrangler secret put LICENSE_SIGNING_KEY && cd ..
   ```
3. Replace `LICENSE_PUBLIC_KEY_JWK` in `src/shared/license.ts` with the **public** block, then commit.
4. Keep the private key somewhere safe and offline (a password manager). Losing it means re-issuing every license; leaking it
   means anyone can forge one.

---

## Part 4 — Deploy the Worker

### 4.1 Migrate and deploy
Before the first deploy, run the price probe and commit its price module (1.6; why in 1.8, "The probe before the first
deploy").
```bash
npm run cloud:migrate     # applies 0003–0005 to the live D1 database (0005 = ledger, holds, config)
npm run cloud:deploy      # deploys the Worker and registers the 5-minute cron that releases expired holds
```
Check it's up:
```bash
curl -s https://api.mythscribe.app/                  # {"service":"mythscribe-api"}
curl -s https://api.mythscribe.app/pricing | head    # price table, packs, markup, routing
```
`/pricing` should list `deepseek/deepseek-v4-flash` and `deepseek/deepseek-v4-pro`, a markup of `0.25`, and your three packs.

### 4.2 Sign-in email
Sign-in needs Resend (`RESEND_API_KEY`). It was already set up for F-15.2. If sign-in emails don't arrive, see "Setting up
Resend" in `cloud/README.md`.

### 4.3 Changing prices, markup, or models later (no deploy, no app release)
Every billing setting has a default in code. A row in the `billing_config` table overrides it on the next request:
```bash
# Example: change the markup to 25 %.
npx wrangler d1 execute mythscribe --remote --config cloud/wrangler.toml --command \
  "INSERT INTO billing_config (key, value, updated_at) VALUES ('markup', '0.25', unixepoch() * 1000)
   ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at"
```
The keys you can set:

| Key | What it controls |
|---|---|
| `markup` | Markup on provider cost (default 0.25) |
| `trial_grant_usd` | One-time grant per verified email (default 0: the starter pack replaced it) |
| `quote_threshold_usd` | Jobs above this ask for confirmation (default 0.25) |
| `estimate_safety_factor` | Padding on displayed estimates (default 1.2) |
| `low_balance_warning_usd` | Low-balance warning threshold (default 2) |
| `hold_expiry_minutes` | How long a hold lasts (default 10) |
| `requests_per_minute` | Per-user rate limit (default 60) |
| `max_input_chars` | Largest request accepted |
| `refund_window_days` | Refund window for unused balance, every pack and the starter (default 30; 0 turns self-serve refunds off) |
| `webhook_max_age_hours` | Oldest webhook event accepted (default 72) |
| `models` | Price table: input, output and cached-input price, display multiplier, and `reasoning` (`off`, `low`, or absent for the model's default; 1.8) |
| `routing` | Which model serves the fast and strong tiers |
| `word_costs` | Measured per-word costs. Null hides the "words left" line and the pack examples |

`cloud/README.md` › "Billing config" has the exact JSON shapes. A row that fails validation is logged and ignored.

### 4.4 Reading the money
```bash
# The last 20 ledger rows.
npx wrangler d1 execute mythscribe --remote --config cloud/wrangler.toml --command \
  "SELECT datetime(created_at/1000,'unixepoch') AS utc, type, amount_micros/1e6 AS usd, user_id
     FROM ledger_entries ORDER BY created_at DESC LIMIT 20"
```
A correction is always a **new** row (type `adjustment`), never an edit; the database refuses edits. `cloud/README.md` has the
exact statement for a manual credit.

---

## Part 5 — Test everything in test mode

1. In `src/shared/cloudApi.ts`, set `CLOUD_AI_AVAILABLE = true` **in a local build only**. Don't commit it yet.
2. Run the app: `npm run dev`.
3. Open **Settings › Account**, sign in with your email (link or 6-digit code). The balance should show **$0.00** and the
   offer "Try the AI for $5. Any unused balance is refundable for 30 days." Buy the starter with the test card (step 5): the
   balance shows $5.00 and the offer disappears; a second try is refused.
4. Open **Settings › AI**, set **Source** to **MythScribe Cloud**. Ask the chat something. The balance should drop by a few
   cents; the answer's cost line shows dollars.
5. **Buy a $10 pack.** It opens the Lemon Squeezy checkout in your browser. Pay with the test card `4242 4242 4242 4242`, any
   future date, any CVC. Back in the app, the balance should rise by $10 within a few seconds; it refreshes on window focus.
6. **Check the webhook log** in Lemon Squeezy (**Settings › Webhooks** › your endpoint): one delivery, response 200.
   Press "Resend" on the same event: the balance must **not** change again.
7. **Refund from the app.** Spend a little, then open **Refund unused balance** on the Account tab and refund the $10 pack:
   the refund is the unused part only, Lemon Squeezy shows a partial refund on the order, and the balance drops by exactly
   that. The webhook's `order_refunded` that follows must not change the balance again. Also try a refund from the Lemon
   Squeezy dashboard on another order: the balance follows it once.
8. **Buy the $30 app license** from the Account tab. The license section should show it as active.
   - Optional check with a test build: set the trial clock back in `%APPDATA%/MythScribe/app-state.json` to see the read-only
     banner, then refresh the Account tab to see it clear.
9. Replaying a real event body against a local Worker: `cloud/README.md` › "Replaying a signed event against wrangler dev".

If something fails, the Worker's live log helps: `cd cloud && npx wrangler tail`. It logs ids, models, token counts and costs,
never prompt text.

---

## Part 6 — Go live

1. When Lemon Squeezy has approved the store, switch **Test mode off**.
2. **Check the live products and the webhook.** Lemon Squeezy can keep test and live data separate. Make sure the four products
   exist in live mode, and compare their variant IDs and buy links with `wrangler.toml`. Update the file and redeploy if they
   differ. Also make sure the webhook endpoint exists in live mode with the same secret and events.
3. Make one real $10 purchase yourself, refund it, and check the ledger shows a `topup` and then a `refund`.
4. Commit `CLOUD_AI_AVAILABLE = true` and the real public key from Part 3.
5. **Release** (`docs/RELEASING.md`): signing accounts, the first tag, then the website's download buttons. When you approve,
   deploy the website with `npm run site:deploy`.

---

## Part 7 — Day-to-day

- **Refund requests:** unused balance is refundable within 30 days of each purchase, the starter included. Authors do it
  themselves on the Account tab (it needs `LEMONSQUEEZY_API_KEY`). By hand, in Lemon Squeezy, refund the *unused amount* of
  that order; the webhook records exactly that amount. Spent money isn't refunded unless you decide to make an exception
  (the balance then goes below zero and hosted AI stays blocked until the account tops up).
- **App-license refunds:** refunding the $30 order revokes the license automatically on the user's next check.
- **Price drift:** check OpenRouter's prices monthly (1.6) and update `models` (4.3) so the 25% stays 25%.
- **Fees:** Lemon Squeezy takes a percentage plus a fixed fee per order, about 10% of a $10 pack. That is why packs start at
  $10. Watch it in the payout reports.
- **Measured costs (later):** once you're ready, measure real per-word costs on a manuscript with your personal OpenRouter key.
  Set `word_costs` (4.3), and the "about N words left" line and the pack examples appear in the app on their own.
