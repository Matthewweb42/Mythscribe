# MythScribe — Expansion Plan: AI, Voice, and Business

Companion to `FEATURES.md` (the spec) and `CLAUDE.md` (how we build). This document holds the
reasoning: why the AI is shaped the way it is, how it is built, how the business works, and what
can go wrong. Feature IDs referenced here are defined in `FEATURES.md`.

---

## 1. The thesis

Every AI writing tool on the market pulls the author toward the model's voice. Sudowrite and its
clones generate prose; the author curates. That is fast, and it produces books that read like the
model. Authors who care about their voice, which is the audience that pays for a Scrivener-class
tool, are the ones most hostile to that.

MythScribe's position: **the author is the writer; the AI is the reader, the researcher, and the
copyeditor.** Generation exists, but it is the least important AI feature, it is always a proposal,
and it is always constrained by the author's own voice and stated intent.

Three promises, in priority order, that every AI feature must satisfy:

1. **Voice.** Anything the AI proposes sounds like this author, on this book, in this POV. Measured, not hoped for.
2. **Intent.** The AI works toward what the author said the scene is for. It does not invent plot, characters, or facts unless asked.
3. **Control.** Nothing enters the manuscript without an explicit accept. The author can see, forever, which words were machine-proposed. The author can turn any AI capability off, globally or per feature, and can choose who sees their text (their own API key, our service, or nobody with a local model).

The product wedge that follows from this is **Story Intelligence** (F-5.7): the AI knows the
manuscript better than the author's memory does. Ask "where did Emma first suspect Tomas?" and get
a cited answer that opens the scene. No competitor does this well because it needs the structured
data (tags, summaries, entities, timeline) that MythScribe already models.

---

## 2. AI design: voice, intent, control

### 2.1 Voice Profile (F-14.1, F-14.2, F-14.7)

A per-project object, with optional per-POV-character overrides, built from three sources:

| Source | How it is built | Used for |
|---|---|---|
| **Exemplars** | 6–12 passages the author marks as "this is my voice" (or auto-picked: the scenes the author edited least after writing) | Few-shot examples in every generation prompt; retrieval picks the 2–3 exemplars most similar in situation (dialogue, action, interiority) |
| **Stylometrics** | Computed locally from the manuscript: sentence length distribution, paragraph length, dialogue-to-narration ratio, tense, person, adverb rate, comma/em-dash/semicolon habits, vocabulary richness, most-used verbs, tag verbs ("said" vs. alternatives) | Rendered into plain-language prompt rules ("short sentences, median 11 words; almost never uses semicolons; dialogue tags are 'said' 90% of the time") and used as the **fidelity check** on output |
| **Author rules** | Free-text rules the author writes ("no rhetorical questions in narration", "Mira never swears", British spelling) plus a banned-phrases list seeded with known AI-isms ("a testament to", "delve", "tapestry", "I couldn't help but", stacked triplets, "little did they know") | Hard constraints in the prompt; post-filter that flags or auto-regenerates violations |

**Fidelity check (F-14.7):** every proposal is scored against the stylometric profile before it is
shown. Out-of-band proposals (sentence length way off, banned phrase present, adverb rate doubled)
are regenerated once with the violation named in the prompt, then shown with a warning badge if
still off. This is cheap, local, deterministic, and it is the thing that keeps the AI from drifting
the voice over a 90,000-word draft.

**Cold start:** a new project has no text. Fall back to author rules plus exemplars the author
pastes from previous work; show a "voice confidence" indicator that rises as the manuscript grows.

### 2.2 Intent (F-14.3)

Scene metadata grows a **scene brief**: goal, conflict, turn/outcome, emotional beat, what the
reader should know after. Optional, one line each, with AI-assisted drafting from the scene text
("here is what I think this scene is doing; correct me"). Every generation and critique prompt
includes the brief for the current scene and the one-line summaries of the surrounding scenes.
The Author-mode prompt is explicit: *"Serve the brief. Do not introduce named characters, places,
or facts that are not in the story bible unless the author's instruction asks for them."*

The brief also unlocks the most voice-safe AI feature there is: **"Is this scene doing what I
wanted?"** (F-14.8). Critique against stated intent is enormously useful and adds zero AI words to
the book.

### 2.3 Control (F-14.4, F-14.5, F-14.6, F-14.10)

**The AI dial** (F-14.4), per project, monotonic (a lower level disables everything above it):

| Level | What the AI may do | What leaves the machine |
|---|---|---|
| 0 Off | Nothing | Nothing |
| 1 Ask | Story Intelligence queries, summaries, tag suggestions, critique | Scene text and story bible |
| 2 Suggest | Level 1 + VibeWrite ghost text, rewrite-in-my-voice on selection | Same, plus the last ~500 characters at the caret |
| 3 Draft | Level 2 + Author mode (multi-paragraph proposals) | Same |

Plus per-feature toggles under the dial and a **data-sharing panel** listing exactly which
features send which text to which provider.

**Proposal review** (F-14.5): every AI output is a `Proposal` object (source feature, prompt
version, model, tokens, text, optional target range). Ghost text is one rendering; a **diff view**
for rewrites is another; chat is a third. Accept, accept-partial (word/sentence), edit-then-accept,
reject, or regenerate-with-note ("less formal", "she's angrier here"). Rejections with notes feed
back into the voice profile as negative examples.

**Provenance ledger** (F-14.6): accepted AI text is recorded as spans in the document model
(`ai-origin` mark with proposal ID). Editing an AI span by more than a threshold clears the mark
(the author has made it theirs). The manuscript shows an **AI-origin percentage** per scene and
project, and can export a disclosure report. This matters three ways: the US Copyright Office's
position is that AI-generated material without sufficient human authorship is not protectable, so
authors need to know; publishers and contests increasingly require disclosure; and it is the
honest way to sell "you are still the writer".

**Rewrite in my voice** (F-14.10): select any passage (including AI-origin spans) and ask for a
rewrite constrained by the voice profile, shown as a diff. This is the "de-AI" button.

### 2.4 The AI as reader and editor (F-14.8)

These are the features that protect voice by adding no words, and they are the ones authors will
talk about:

- **Editor's notes** on a scene: pacing, clarity, show-vs-tell, POV slips, filter words, repeated
  words in proximity, dialogue attribution clutter. Each note cites the passage; "fix" is always a
  proposal via diff.
- **Beta reader**: "read" the manuscript up to this scene as a first-time reader; report what the
  reader knows, believes, and expects; flag confusion and lost threads. Powered by scene summaries
  in order, so it stays cheap.
- **Continuity checker** (F-13.4): entity facts (eye color, ages, timeline, who knows what) vs.
  scene text; contradictions listed with both citations.
- **Consistency of voice** across the book: the fidelity check run over the manuscript to find
  scenes that drift (often the ones written tired, or with too much AI).
- **Honesty setting**: critique calibrated from "encouraging" to "brutal"; default is "specific and
  direct". Sycophancy is the failure mode; the prompt forbids praise without a cited passage.

### 2.5 Story Intelligence (F-5.6, F-5.7)

Retrieval plus structured data, not a long-context dump:

1. **Index** — on save (debounced, background, cheap model): scene summary (~100 tokens), key
   events, characters present, places, open threads. Also local embeddings of each scene chunk.
2. **Query** — classify the question (who/where/when/what-does-X-know/theme); filter candidates
   by tags, entities, and timeline; rank by embedding similarity; load full text for the top N
   within a token budget; answer with citations `[Ch 4, "The Ferry"]`; every citation is a link
   that opens the scene and highlights the passage.
3. **Grounding** — the prompt forbids answering from outside the provided text; "not found in the
   manuscript" is a valid answer and is shown as such.

Embeddings: prefer a local model (small, runs on CPU, no text leaves the machine) with a provider
embedding as an option. Store vectors in SQLite (sqlite-vec) so the project stays one folder.

---

## 3. AI architecture (low level)

```
Renderer                         Main process                            Outside
────────                         ────────────                            ───────
feature UI ─► ai.request(task) ─► Task router ─► Context builder ─► Prompt template (versioned)
                                       │              │  voice profile, scene brief,
                                       │              │  story bible (tags/entities/summaries),
                                       │              │  retrieved exemplars + scenes, recent text
                                       │              ▼
                                       │        Provider adapter ───────────────► Anthropic / OpenAI /
                                       │         (stream, complete, embed,        OpenRouter / Ollama /
                                       │          countTokens, cost)              MythScribe Cloud
                                       ▼
                                Post-processors: banned phrases, fidelity score, format/JSON parse
                                       ▼
                                Proposal ─► renderer (ghost | diff | chat | chips)
                                       ▼
                                Usage ledger (tokens, cost, feature, model) + response cache
```

Design rules:

- **One `AIProvider` interface**, five adapters. The MythScribe Cloud adapter speaks the same
  interface to our proxy, so the app code does not know whether the user is BYOK or paying us.
- **Model tiers, not model names**, in feature code: `fast` (ghost text, tags, summaries,
  embeddings), `strong` (Author mode, critique, queries). Tier → model mapping is a setting with
  sane defaults per provider; the `/claude-api` skill is the reference when choosing defaults.
- **Prompt templates are files** under `src/main/ai/prompts/`, versioned, with golden-output tests
  and a `promptVersion` recorded on every Proposal. Changing a prompt is a reviewed change.
- **Streaming everywhere** users wait (ghost text, chat, rewrites). Background tasks use the
  provider's batch API when available (roughly half price) and never block typing.
- **Prompt caching**: the story bible plus voice profile is a stable prefix; structure prompts so
  provider caching applies (Anthropic cache control on the prefix). This is the single biggest
  cost lever for chat and queries.
- **Budgets**: per-feature token budgets; per-day spend caps (user-set for BYOK, plan-set for
  Cloud); ghost text has a minimum of new characters typed since the last request and a hard
  minimum interval; identical context hits the local cache.
- **Keys**: stored with Electron `safeStorage`; never in the project file, never in the renderer.
- **Job queue** for indexing: SQLite-backed, resumable, rate-limited, cancellable, visible in a
  small status indicator ("Indexing 3 of 12 scenes").
- **Evaluation harness**: a fixtures project (a few chapters of public-domain text with a fake voice
  profile) and scripted tasks; run before changing prompts or default models; reports fidelity
  scores and cost.

---

## 4. Business model

### 4.1 Two ways to pay for AI

| | **Bring your own key** | **MythScribe Cloud** |
|---|---|---|
| Who | Technical or cost-conscious authors; privacy-focused; people already paying a provider | Everyone else: no API accounts, no billing surprises, works on install |
| How | Keys for Anthropic / OpenAI / OpenRouter / Ollama entered in Settings; app calls providers directly | Account + subscription; app calls our proxy; proxy calls providers with our keys |
| Our cost | Zero AI cost | Provider tokens plus infrastructure |
| Our revenue | App license (see below) | Subscription with included credits; overage packs |
| Data path | Author → provider | Author → our proxy (no storage, no logs of content) → provider |

Both paths ship. BYOK is the trust story ("we never need to see your book"); Cloud is the money.

**The author chooses at project setup (F-15.11, decided 2026-09-15).** Creating a project asks
"Use your own key, or MythScribe's?" and the AI tab lets them switch any time. Own key: paste it,
nothing is paid to us. MythScribe's key: sign in, buy credits, and every request is charged at the
rate of the model that answered, so the author sees what the strong tier costs before choosing it.

### 4.2 Pricing shape (numbers are starting points, validate with early users)

- **App**: free to download and use for writing with AI off or BYOK. This maximizes the top of the
  funnel and makes the privacy story unambiguous. Optional one-time **Supporter license** (~$39)
  that unlocks cosmetic extras (themes, focus backgrounds pack) and shows up as "BYOK power users
  who want to support the project".
- **Cloud Scribe** (~$9/mo): credits sized for roughly 20–30k words of assisted drafting plus
  unlimited fast-tier features within fair use; `fast` tier models only for ghost text; `strong`
  tier for queries and critique with a monthly cap.
- **Cloud Pro** (~$19/mo): larger credit pool, strong-tier models everywhere, priority indexing,
  beta-reader and continuity passes on the full manuscript.
- **Usage pricing by model (decided 2026-09-15, replaces plans as the first thing on sale):** a
  prepaid credit balance, metered per request at the answering model's rate (provider price plus a
  margin), one published rate per model, shown in the app. The Scribe/Pro plans above are a later,
  second way to buy the same credits, not a prerequisite.
- **Credit packs** for overage, non-expiring within 12 months.
- Annual plans at ~2 months free.

Cost sanity: with prompt caching and fast-tier models for the high-frequency features, the
provider cost of a heavy Scribe user should land well under a third of the subscription. Model
the actual numbers in a spreadsheet before launch using current per-token prices (they change;
check at implementation time) and the usage ledger from beta users. Ghost text is the cost risk:
cap it by design (interval, minimum typed characters, cache), not by hoping.

**Provider choice (decided):** OpenAI-first for Cloud and the default BYOK setup, on price. The
adapter layer keeps Anthropic or others a config change away; revisit if fidelity or refusal
rates on fiction argue for it.

### 4.3 Cloud backend (F-15.x)

Deliberately small; a solo side business cannot run a big service:

- **Auth**: email magic link plus Google/Apple sign-in. No passwords to leak.
- **Billing**: **Lemon Squeezy** (merchant of record, decided) rather than raw Stripe. They
  handle global sales tax/VAT, invoices, and refunds, which is the difference between a side
  hustle and an accounting job. Webhooks set the plan and credit balance.
- **Proxy**: one serverless service (Cloudflare Workers or a single small VM) exposing the
  `AIProvider` operations; validates the session, checks credits, streams from the provider,
  meters tokens, writes a usage row. **No manuscript content is stored or logged.** State this in
  the privacy policy and enforce it in code review.
  The operator's provider key is a Worker secret (`OPENAI_API_KEY` in `cloud/`, set with
  `wrangler secret put`; `cloud/.dev.vars` locally); it never ships in the desktop app, which
  only ever holds the author's own key or a MythScribe session token.
- **Entitlements**: signed license token cached in the app with an offline grace period (say 14
  days) so writing never blocks on the network. Since Cloud became prepaid credits, the only
  entitlement is the Supporter license, so the token is built with it (F-15.6 folded into F-15.9
  on 2026-09-21); the account session already survives being offline.
- **Ops**: uptime monitor, error tracking (Sentry, content-scrubbed), a status page, a support
  inbox. Budget a few hours a month.

### 4.4 Distribution and trust

- Windows first (author's platform), then macOS, then Linux. Code-sign Windows builds (Azure
  Trusted Signing is the cheap route; an unsigned Electron app triggers SmartScreen and kills
  conversion) and notarize macOS ($99/yr developer account). Auto-update via `electron-updater`
  with stable and beta channels.
- Website with the three promises up front, a two-minute video of Story Intelligence answering a
  question with citations, and a plain-English "what leaves your computer" page.
- Community: a Discord and a public roadmap. Writers recruit writers.
- Timing: NaNoWriMo-style November pushes and writing-community launches (r/writing, r/fantasywriters,
  writing Discords, author newsletters). Early access with a founding-member discount.
- Competitive frame (verify current prices before quoting them anywhere): Scrivener (one-time,
  no AI, the organizer benchmark), Sudowrite (subscription, generation-first), NovelCrafter
  (subscription, BYOK, closest in spirit, web-only), Dabble/Novlr (subscription, cloud-first).
  MythScribe's line: *local-first, your voice, your keys or ours, and the only one that can answer
  questions about your book with citations.*

### 4.5 Legal and policy checklist

- Business entity and a separate bank account before taking money.
- Terms of service, privacy policy (explicit: no content storage on Cloud, no training, list of
  sub-processors), refund policy, AI usage disclosure page.
- Provider terms: our Cloud use of Anthropic/OpenAI must comply with their usage policies; fiction
  routinely contains violence and sexual content, so test refusal rates early and document what
  the service can and cannot do. Route mature content through the provider and model with the
  most appropriate policy; never silently drop a request.
- Copyright: the provenance ledger and disclosure export are product answers to a legal
  question; do not give legal advice in the app.
- Age gating for the Cloud service (13+ or 16+ depending on jurisdiction).

---

## 5. Problems and how the plan handles them

| Problem | Why it is real | Mitigation |
|---|---|---|
| **Voice drift over a long draft** | Every accepted AI sentence nudges the exemplars; models regress to their mean | Fidelity check on every proposal; exemplars are author-marked, not auto-updated from AI spans; voice-consistency report over the book |
| **Sycophantic critique** | Models praise by default; useless to a writer | Critique prompts forbid uncited praise; honesty setting; structured output (issue, passage, why, suggestion) |
| **Hallucinated story facts** | Long-context summarization invents connections | Retrieval with citations; "not found" as a first-class answer; entity sheets are the ground truth, summaries are derived and re-generated on edit |
| **Ghost-text cost** | A 2-second idle trigger can fire hundreds of times an hour | Minimum typed characters + interval + local cache + fast tier + daily cap; off by default at dial ≤1 |
| **Cold start** | No manuscript, no voice | Author rules and pasted exemplars; confidence indicator; features degrade to "generic but constrained" rather than refusing |
| **Content policy refusals** | Fiction has dark scenes | Test early; provider/model choice per plan; clear error message that names the policy; BYOK users can choose permissive providers |
| **Key and data safety** | Desktop apps leak secrets; proxies tempt logging | `safeStorage`; keys never in project files; proxy stores nothing; content-scrubbed error tracking; privacy page that is actually true |
| **Solo-dev bandwidth** | A backend, billing, and support are a second product | BYOK ships first (M2 to M3) with a Cloud waitlist; Cloud (M-Cloud) only after the desktop app has retained users; merchant of record; serverless |
| **Model churn** | Default models are deprecated every few months | Tier abstraction; prompt tests; eval harness; model defaults in a remotely updatable config for Cloud users |
| **Local-first vs. cloud features** | Accounts and sync pull toward a server holding manuscripts | Cloud is compute only; sync (if ever) is end-to-end encrypted or via the author's own cloud folder (F-8.4) |
| **Electron trust on Windows** | SmartScreen warnings kill installs | Sign builds from the first public beta |
| **Author backlash against AI tools** | Many writing communities are hostile | Lead with organizer, focus mode, and Story Intelligence; AI off by default at install; the provenance ledger as proof of intent; never market "write your novel with AI" |

---

## 6. Roadmap (revises `FEATURES.md` §6)

| Milestone | Outcome | Business step |
|---|---|---|
| **M0 Foundation** | Scaffold, typed IPC, migrations, tests, dialog service, tokens | Register the domain; entity paperwork can wait |
| **M1 Write** | Organizer + editor good enough to draft a novel in, AI off | Private alpha with 3–5 writers you know |
| **M2 Organize and assist** | v0 parity: tags, focus mode, BYOK AI with presets, ghost text, chat | Public beta (unsigned is acceptable for a closed beta, signed for public) |
| **M2.5 Voice and control** | Voice profile, fidelity check, AI dial, proposal review, provenance ledger, rewrite-in-my-voice, editor's notes | This is the marketing story; landing page and waitlist go live here |
| **M3 Story Intelligence** | Summaries, embeddings, cited queries, beta reader, continuity | Launch v1 with BYOK; Supporter license on sale |
| **M-Cloud** | Accounts, subscription, proxy, entitlements, usage meter | Cloud plans on sale; merchant of record live |
| **M4 Entities, search, goals** | Structured story bible (feeds the AI), global search, goals | Retention features |
| **M5 Safety and output** | Backups, drafts, snapshots, export, import | Removes the last "why not Scrivener" objections |
| **M6 Polish** | Themes, outline, timeline | Steady state; ship monthly |

**Launch line (decided: launch as soon as possible).** v1 ships after M3 with exactly: M0, M1,
M2 minus local models, M2.5, and the Story Intelligence core (F-5.6, F-5.7, F-5.8) from M3. Beta
reader, continuity, granular tagging, and everything in M4+ are post-launch. Cloud (M-Cloud)
follows v1 by weeks, not months, because it is the revenue; its backend is small enough to build
while v1 is in beta.

M2.5 sits before M3 on purpose: the voice and control layer must exist before the AI does anything
larger than ghost text, or the "author stays the writer" claim is marketing rather than product.

---

## 7. Decisions (made 2026-09-10)

1. **Cloud and default provider: OpenAI-first**, for price. Anthropic stays an optional adapter.
2. **Free app + paid Cloud + Supporter license.**
3. **Lemon Squeezy** as merchant of record.
4. **Local models deferred** past launch; the founder's OpenAI key is the development and BYOK default.
5. **Name: MythScribe. Launch as soon as possible**; scope is cut to the launch line in §6.

Still open: stack approval (see `CLAUDE.md`), pricing numbers after beta usage data, Cloud content-policy testing results on dark fiction.
