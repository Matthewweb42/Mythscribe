# MythScribe — Claude Code project guide

MythScribe is a local-first desktop novel-writing app (Scrivener-style organizer + distraction-free
editor + story tagging + AI that understands the author's manuscript while keeping the author's
voice, intent, and control). It is also a business: free app, bring-your-own-key AI, and a paid
MythScribe Cloud subscription.

## The one rule

**`FEATURES.md` is the single source of truth.** Features have IDs (`F-3.2`), status checkboxes,
and a milestone order. Build only what is in it; tick a box only after verification. Update the
spec in the same change when reality changes.

`PLAN.md` holds the reasoning: AI design (voice, intent, control), AI architecture, business model,
risks, roadmap. Read it before working on anything under `FEATURES.md` §2.5, §2.14, or §2.15.

The original prototype was deleted on purpose (git tag `v0-legacy`). Do not resurrect its code.
`FEATURES.md` §5 lists its mistakes; do not repeat them.

## Decisions made (do not re-open)

- **Business (2026-10-07, `docs/research/AI-BILLING-SPEC.md`):** the app is a **$30 one-time purchase** with a 30-day free trial (no subscription; the $39 Supporter license is superseded). Own key and local models are free, with no markup, and never touch our servers. Hosted AI (MythScribe Cloud) is paid from a prepaid **dollar balance** ("Balance", never "credits"): packs $10/$25/$50, provider cost + 25 % (changed from 20 % by the author 2026-10-08), never expires, unused balance refundable for 30 days (confirmed 2026-10-07). Billing via **Lemon Squeezy** (merchant of record).
- **AI provider:** **OpenRouter** for both the default own-key provider and the hosted gateway (OpenAI kept as an own-key option). Defaults approved 2026-10-07: DeepSeek V4 Flash (fast) and V4 Pro (strong). The provider interface stays generic. Local models (F-5.15) were built 2026-10-06 at the author's request (any OpenAI-compatible server, e.g. Ollama).
- **Name:** MythScribe. **Goal: launch as soon as possible.** Scope is cut toward the launch line in `FEATURES.md` §6, not expanded.
- **Stack:** approved 2026-09-10 and scaffolded (see Stack below). M0 is built.

## Next up (keep this current; it is the handoff between sessions)

0. **State (2026-10-09):** M7 Knowledge model is built and on `main` (reviewed, unticked until the author verifies in the installed app): F-8.7 pre-migration backup, F-9.12 local index, F-9.13 dated facts + Changes, F-9.14 scene cards/relationships/threads + the one-time conversion (summary.v4), F-9.16 To do list (book check only on the button), F-5.24 lookup ladder (agent.v6), F-9.15 sections + one Changes log. Also on main: F-8.1 Google Drive working copy (the author's project is in Drive), review deck UI, the stricter AI tag rule (`src/shared/tagTerms.ts`), the $5 starter pack + self-serve refunds (server not deployed), the "Just write" site (deployed). Since 2026-10-10 also: side work (Organise/upload review in the assistant column via the status bar), focus mode keeps the caret and its Notes window carries the synopsis, F-5.25 chat bulk tools (clear card, agent.v7; fixes 5/7/8 of the audit open in QUESTIONS.md; plan `plan-side-work-and-bulk-delete.md`). Plans: `~/.claude/projects/<project>/plans/plan-knowledge-model.md`, `plan-todo.md`, `plan-review-ux.md`, `plan-starter-pack.md`.
1. **Next:** branch `claude/gallant-pasteur-sn3vn0` (2026-10-10, not yet on `main`) holds the author's QUESTIONS.md review (older entries confirmed or changed; the 2026-10-10 entries are the open ones) and: scene-first create menu + small plus buttons, grip on the section picker row (F-2.2, F-7.3); license dev exemption via the author's secret, 90-day offline grace, extras in the trial (F-15.13); Drive conflict asks (F-8.1); scene mood/theme (summary.v5, rewrite.v4, editPass.v2); Rewrite on `strong`; no unverified mark in Plan; upload review starts accepted; agent.v8 chat tools (F-5.25); activity bar + drops (F-7.12); Ms Scribe name (F-7.13); section shading (F-7.14); Organise applies and closes at the deck's end; one List/Cards choice, two-way sheet sync, Story bible settings (F-9.17–9.19, migration 0026). Then: the author reinstalls (backup first) and checks these in the app. Live fidelity (`MYTHSCRIBE_EVAL_LIVE=1`) is unrun for summary.v4/v5, todo.v1, todoSuggest.v1, agent.v6–v8, rewrite.v4, editPass.v2, sheetWriteUp.v1, sheetRefile.v1. The e2e typewriter step (smoke.spec.ts ~4388) failed 2 of 5 runs on 2026-10-10: watch it.
1b. **Story memory redesign (2026-10-11): approved by the author 2026-10-11, building.** Names/nicknames replace tags, quote-proved facts are read when a scene settles, one This scene panel, a Research section. Spec `FEATURES.md` §2.16 (F-16.1–16.38), milestones M8 (P0–P4 + switch-over, before the moved launch line, about 10 weeks) and M9 (P5–P9, after); design `docs/research/story-memory-2026-10-11/design.md` (its "Decisions (2026-10-11)" section: defaults approved, decision 3 changed by the author); approval and superseded entries in `QUESTIONS.md` (2026-10-11 · F-16). **Phase status: P0 done** (F-16.1–16.3 built, reviewed, ticked 2026-10-11; plan `docs/research/story-memory-2026-10-11/plans/P0.md`). The author's one P0 step is still open: `OPENROUTER_API_KEY=… npm run ai:probe -- -u` once, then `npm run eval:ai -- -u` and commit (QUESTIONS.md P0 entry); the Worker's first deploy waits for it (`docs/OPERATOR-SETUP.md` 1.8). **P1 done 2026-10-12** (Names and documents, F-16.4–16.15, plan `docs/research/story-memory-2026-10-11/plans/P1.md`: six slices on branch `claude/gallant-pasteur-sn3vn0`, each reviewed, then ticked after one final verification: full gates, `e2e/memory.spec.ts` on v2 beside the v1 smoke; migrations 0029–0033, additive; calls in `QUESTIONS.md` "P1 slice 1" to "P1 slice 6" and the slice reviews). What it holds, v2 only: records with nicknames and the twin gate, the local name scan and passage index, the Research section with Not canon pages, one-view sheets (Pinned, Ideas), labels and typed scene details, the This scene panel with Needs a look, My to-dos, Dismissed and Rename in book, the chat agent in v2 with its tag and sheet tools refused, the Story notes block in 11 v2 prose versions, filing a Research page into Pinned (`contextImport.v3`/`reviewChat.v3`), and the switch-over flow on a test copy (Help › Try the story-memory switch-over on a copy…, development builds only), with imports writing records and labels. **Still owed by the author:** a check of each in a development build (`MYTHSCRIBE_STORY_MEMORY=v2 npm run dev` on a new project or a copy, since the override runs every project it opens on v2; installed builds stay on v1), the switch-over trial on a copy of the real project, and live fidelity for the 14 new versions (the 11 prose versions, `contextImport.v3`, `reviewChat.v3`, `importStructure.v2`). **P2a done 2026-10-12** (Evidence reader, F-16.16–16.21, plan `docs/research/story-memory-2026-10-11/plans/P2a.md`: five slices, each reviewed, then ticked after one final verification on the reviewed code: full gates, `e2e/memory.spec.ts`'s three P2a tests at the fake provider beside the v1 smoke; migrations 0034–0035, additive; QUESTIONS "P2a ticked before your checks in the app"): slice 1 (the evidence data, no AI: migration 0034, the gate, windows, literal proof, anchors, reconcile, as-of, the anchors job) built and its review fixed 2026-10-12 (QUESTIONS "P2a slice 1 review"); slice 2 (`reader.v1`, `verify.v1`, the reading pipeline, *Read now* over `memory:readNow`, eval cases, the offline oracle and adversarial replays) built and its review fixed 2026-10-12 (QUESTIONS "P2a slice 2", "P2a slice 2 review"); slice 3 (when a scene is read: leave and idle triggers in the renderer, the reader's queue owning `jobs:*` in v2, the backlog, the back-fill, the health gate, spot checks, *Rebuild memory*, the Cloud monthly cap, `summary.v5` off in v2) built and its review fixed 2026-10-12 (QUESTIONS "P2a slice 3", "P2a slice 3 review"); slice 4 (the UI: Here, Mentioned and True now in the panel, ⓘ and *Not right* on every line, sheets as of a scene, the card in scene details with decision 4's conflict, the footer with *Read now*, Settings › AI › Story memory, the *Rebuild memory* dialog) built and its review fixed 2026-10-12 (QUESTIONS "P2a slice 4", "P2a slice 4 review"); slice 5 (the beta reader, synopsis and notes suggestions, the story map, scene mood and the chat's tools read cards; the Story notes block gains the scene's values and mood; the Outline and cork board show the card line; plan links applied automatically in code, `planLinks.v2` only for a close pair, *Keep* and *Unlink* to Dismissed; the summary and v1 plan-link channels are `v1`) built 2026-10-12 with the final verification (QUESTIONS "P2a slice 5"), and its review fixed 2026-10-12 (QUESTIONS "P2a slice 5 review": plan links matched again after every reading, a name counted once, per draft through migration 0035, *Undo* of *Unlink*; no reader takes an Idea scene's card). **P2b building** (F-16.22–16.23, plan `docs/research/story-memory-2026-10-11/plans/P2b.md`): slice 1 (who-knows-what data, threads, years and ages; migration 0036) and slice 2 (`reader.v2`, `verify.v2` and the pipeline: knows lines, thread steps, silent secrets and threads, same-as merges) built 2026-10-12 and its review fixed 2026-10-13 (QUESTIONS "P2b slice 2 review": the roster's ceiling and smaller pages, no Idea-scene reveals, no secret from a rumour, rebuilds re-check reveals); slice 3 (the offline knows replays in book and reverse order and the adversarial one, `knows.eval.ts` over the shared oracle `memoryOracle.ts`; the live knows run built for the author; one key, `OPENROUTER_API_KEY`, for every live path through `liveProvider.ts`, each live path driven end to end offline against a fake OpenRouter; a told, overheard or read line in its source's own first person settles its learner in reach) built 2026-10-13 (QUESTIONS "P2b slice 3"), nothing ticked; owed by the author after the whole build: live fidelity for `reader.v2`/`verify.v2` and the live knows run, F-16.22's merge condition: `MYTHSCRIBE_EVAL_LIVE=1 OPENROUTER_API_KEY=sk-or-… npm run eval:ai -- knows` (two passes, stops at 50¢, about 3¢ expected; report in `test-results/eval-knows/`). **Next:** P2b slices 4–5, then P3 (F-16.24–16.26). **Still owed by the author for P2a:** a check of each feature in a development build (`MYTHSCRIBE_STORY_MEMORY=v2 npm run dev`; each F-16.16–16.21 entry names what to look at; the Cloud cap needs a Cloud account, the e2e has none). **Owed by the author before the switch-over:** the live planted-error run, P2a's merge condition, which needs a key: `MYTHSCRIBE_EVAL_LIVE=1 OPENROUTER_API_KEY=sk-or-… npm run eval:ai -- memory` (the old `OPENAI_API_KEY` with `OPENAI_BASE_URL` form still works; stops at 50¢; report in `test-results/eval-memory/`: its pass bars, support precision included, and the unreviewed facts to read), plus live fidelity for the seven P2a versions (`reader.v1`, `verify.v1`, `betaReader.v2`, `betaReaderRegen.v2`, `synopsis.v2`, `notesSuggest.v4`, `planLinks.v2`). Everything new sits behind `storyMemory: 'v1' | 'v2'`; installed builds stay on v1 until the author starts the switch-over (F-16.31); migrations stay additive (0028+, now through 0035). Tag/entity/knowledge/Organise/To do code is frozen for edit lists during the build: log such requests as superseded in `QUESTIONS.md`. The unticked M7 features and F-9.17–9.19 are replaced (never ticked).
1c. **Live tests with the author's key happen AFTER the whole build (author's plan, 2026-10-12).** When P2b, P3, P4 and the switch-over code are built: the author adds `OPENROUTER_API_KEY` as an environment secret and allows `openrouter.ai` in the environment's network access, then starts a new session. That session runs, in order: `npm run ai:probe -- -u` (prices); the live planted-error run (`MYTHSCRIBE_EVAL_LIVE=1 npm run eval:ai -- memory`), the live knows run (`… -- knows`) and the live fidelity runs for every new prompt version (`… -- prompts`), all reading `OPENROUTER_API_KEY` alone since P2b slice 3 (`src/main/ai/eval/liveProvider.ts`; `OPENAI_API_KEY` still works); fixes what they find; then the author tries the switch-over on a copy and then for real. Do not start a second session that pushes to `main` while a build session is running.
2. **Launch (on hold until the author says go):** operator steps in `docs/OPERATOR-SETUP.md` (starter product, `LEMONSQUEEZY_API_KEY`, `npm run cloud:migrate` incl. 0006, `npm run cloud:deploy`, one test-mode refund), signing accounts and the first release (`docs/RELEASING.md`).
3. The author's edit lists arrive from the installed app (`docs/PERSONAL-USE.md`): one commit each, gates, push `main`. Max three agents at once on the author's PC (no cap in cloud sessions); every Node-heavy command under `flock /tmp/mythscribe-heavy.lock`; lint per folder.
4. Gotchas are under Known gotchas in `docs/ARCHITECTURE.md`. Read them before touching the e2e or a store test.

## Workflow

- Unattended runs (default since 2026-10-05): on a branch `auto/<milestone>`, in auto mode, `/goal F-a, F-b, … are each ticked in FEATURES.md and committed via the /feature workflow; the last commit's full gate suite exited 0; open decisions are logged in QUESTIONS.md. Stop after <N> turns.` Claude chains features on its own and auto-compacts; never `/clear` mid-run.
- `/feature F-x.y` (or `/feature next`) — one feature end to end (plan → build → review → verify → tick the box → commit), then on to the next.
- `/audit` — reconcile `FEATURES.md` statuses with the code.
- Work in milestone order (`FEATURES.md` §6). Launch-line features first; anything past the line waits.
- Small, complete slices. A feature is done when it works in the running app, passes the gates, and its checkbox is ticked.
- Schema, IPC contract, prompt, or >8-file changes: save the plan file first, then build without waiting; decisions go into the spec ("decided by Claude, unconfirmed") and `QUESTIONS.md` (repo root) for the author's review. Prompt changes still need the eval `-u` run and the token-report diff in the commit message.

## Development standards

- **Types are the contract.** No `any`, no `as unknown as`, no `@ts-ignore`. IPC channels are defined once in `src/shared/ipc/` with zod schemas and typed on both sides.
- **Tests with the code.** Data layer, editor commands, prompt builders, and post-processors get unit tests in the same change. Every feature with a UI path gets an e2e step in the smoke test or a documented manual check.
- **One owner per piece of state.** Normalized stores; update the changed record, never reload the world.
- **Reuse before you write.** Look for the existing helper, hook, or pattern first. Parallel implementations are a review failure.
- **No dead ends.** No stubs, no "coming soon", no `TODO` standing in for required behavior, no `console.log` left behind, no native `alert`/`confirm`/`prompt`.
- **Migrations are numbered and tested.** Never edit a shipped migration.
- **Errors are handled where the user can act.** Surface AI/provider errors with the cause (no key, bad key, rate limit, quota, policy refusal) and the next step.
- **Keep dependencies boring and few.** Pin versions. Justify any new dependency in the commit message.
- **Commit messages** are imperative and reference the feature ID (`F-3.2: autosave with debounce`). Never commit `.env` or keys.

## AI feature rules: author control and token efficiency

Every AI feature is a cost line on the Cloud plan and a trust line with the author. These rules
apply to all of `FEATURES.md` §2.5, §2.14, §2.15 and are checked in review.

**Author control**
1. AI output is always a `Proposal`; nothing enters the manuscript without an explicit accept (F-14.5), except in the chat's Auto mode (F-5.21; decided by the author 2026-10-06, modes Auto / Ask / Plan since 2026-10-07): there the chat agent (F-5.22) applies its non-deletion edits itself, each logged in the chat with its own Undo; deletions always ask, and off-voice prose asks too. Accepted text carries provenance (F-14.6). The one exception is derived index data the author never accepts (scene summaries F-5.6, observed facts F-5.16, auto-applied tags F-4.13, continuity findings F-13.4 whose fixes stay proposals, To do items F-9.16 whose suggestions the author picks and confirms; decided 2026-10-01, `PLAN.md` §2.6): stored apart from the author's own text and sheets, marked as AI-made, removable, costed in the ledger, never in the manuscript.
2. Every prompt that generates prose includes the voice profile, the scene brief, and retrieved exemplars (F-14.1–14.3); every generated proposal passes the fidelity check (F-14.7) before display.
3. Respect Use AI (on/off, Settings › AI only), the chat mode (Auto / Ask / Plan; it governs only the chat: Plan never edits, Ask asks before every edit, edit passes always return tracked changes), and the per-feature toggles (F-14.4). Installs off; the new-project wizard preselects and recommends Use AI on with the chat in Ask, with Off one click away (F-5.18). A feature must not send text the data-sharing panel does not list.
4. Grounded answers only: Story Intelligence answers cite manuscript passages or say "not found" (F-5.7). Critique cites a passage for every claim; no uncited praise (F-14.8).

**Token efficiency** (measure with the usage ledger, F-5.14; budgets are per feature)
1. **Tiers, not names.** Request `fast` or `strong` (F-5.11). Ghost text, tags, summaries, embeddings, and classification use `fast`. Only Author mode, Rewrite in my voice (F-14.10; author's choice 2026-10-10), critique, queries (the chat agent, F-5.22), and Check consistency on demand (F-13.4) may use `strong`.
2. **Retrieve, do not dump.** Never send the whole manuscript. Context is built from scene summaries (~100 tokens each), entity sheets, and the top-k retrieved chunks within a fixed budget (default: 3 full scenes + 10 summaries, hard cap per feature). Recent text at the caret is capped (~500 characters for ghost text).
3. **Stable prefix first.** Order prompts as: system rules → voice profile → story bible → task-specific context → user turn, so provider prompt caching applies to the stable part. Do not interleave dynamic text into the prefix.
4. **Cache locally.** Identical (feature, prompt version, context hash) requests return the cached proposal. Summaries and embeddings are invalidated by content hash, not by time.
5. **Trigger discipline for ghost text.** Minimum idle interval, minimum new characters typed since the last request, no request while a proposal is pending or visible, per-day cap. Off until the author turns VibeWrite on, and always at Off.
6. **Short outputs, structured where possible.** Set `max_tokens` per feature (ghost text ≤ 60; tags ≤ 200; summaries ≤ 800 for the summary, key points, characters, up to 6 observed facts, and up to 8 tags as one JSON object). Use JSON/structured output for tags, summaries, and critique so parsing is exact and retries are rare.
7. **Batch the background.** Indexing (summaries, embeddings) goes through the job queue (F-5.13) and uses the provider batch API when available; never block typing; coalesce edits so a scene is summarized once per burst.
8. **Count before you send.** Estimate tokens locally; if a request would exceed its budget, trim context by priority (drop far summaries, then exemplars, then recent text) rather than failing or overspending.
9. **Prompts are compact and versioned** (F-5.12): no restated instructions, no examples the retrieval already supplies, no reasoning dumps. Every prompt change runs the eval harness and reports token delta and fidelity delta in the PR.
10. **Cost is visible.** Each proposal records model, tokens in/out, and cost; Settings shows the running total. A feature that cannot report its cost is not done.
11. **The cost registry is always complete** (author request 2026-10-08): every `AiFeatureId` has an entry in `src/shared/aiCostNotes.ts` (trigger, when, calls per use, typical output, ideas); a new feature does not compile without one. `npm run eval:ai -- -u` regenerates `docs/AI-COST-REGISTRY.md` (every AI feature with estimated cost per call per provider); update the note's typical sizes when the ledger shows real numbers.

**Token efficiency in this repo (for Claude Code itself)**: do not re-read files already in context; grep before reading; delegate broad searches to `Explore`; keep agent prompts to the feature ID and a plan file path; one implementer per feature; the full gate suite runs at most twice per feature (see the global Delegation section), targeted checks otherwise.

## Commands

```
npm install            # also rebuilds better-sqlite3 for Electron
npm run dev            # run the app with HMR
npm run typecheck      # main, renderer, and e2e tsconfigs
npm run lint           # eslint, zero warnings allowed
npm run test           # vitest: main (node) + renderer (jsdom) projects
npm run test:e2e       # builds, then Playwright drives the real Electron app
npm run db:generate -- --name <change>   # new numbered migration from src/main/db/schema.ts
npm run build          # typecheck + production bundles in out/
npm run build:win      # unsigned local installer; releases are tags, see docs/RELEASING.md
```

## Quality gates (must pass before a feature is "built")

- `npm run typecheck` — zero errors
- `npm run lint` — zero warnings
- `npm run test` — unit tests for the data layer, editor commands, prompt builders, post-processors (vitest runs 4 reused workers without per-file isolation, see `vitest.config.ts`; every test file must reset module state such as Zustand stores and the IPC client in `beforeEach`, and stores with debounced writes in `afterEach` too; no `vi.mock` of a renderer module and no store action left replaced, both leak across files)
- `npm run test:e2e` — smoke test: create project → write → reopen → text is still there (M0 version: create → close → reopen)
- `npm run eval:ai` — the prompt eval harness (F-5.12): every catalogued prompt version has cases under budget and the token report matches `src/main/ai/eval/token-report.md` (it also runs inside `npm run test`); `MYTHSCRIBE_EVAL_LIVE=1 OPENROUTER_API_KEY=sk-or-… npm run eval:ai` adds the live fidelity report and the story-memory live runs (`-- prompts`, `-- memory`, `-- knows` for one; `OPENAI_API_KEY`, with `OPENAI_BASE_URL` for another server, still works). A prompt change is a new version file plus a `-u` run, and the PR quotes the token-report diff and the live fidelity numbers.
- Manual check in the running app for anything visual

## Dev environment

- The author develops on WSL2 (Ubuntu 24.04, arm64) with WSLg, so Electron can show a window. Electron needs these system packages once: `sudo apt-get install -y libnss3 libnspr4 libasound2t64`. Without them `npm run test:e2e` and `npm run dev` fail with `libnspr4.so: cannot open shared object file`. With `xvfb` installed (`sudo apt-get install -y xvfb`, done 2026-10-02) the e2e runs off-screen through `e2e/run.mjs`, so it cannot take the keyboard; `MYTHSCRIBE_E2E_VISIBLE=1` shows the window.
- The working clone is `~/coding/mythscribe` on the WSL ext4 filesystem (moved 2026-09-11). The full gate suite runs in about 30 seconds there. Do not work from the old `/mnt/c/Coding/mythscribe` copy: on that mount every gate pass took minutes and Vitest workers timed out starting. Windows editors reach the clone through `\\wsl.localhost\Ubuntu\home\lostfromlight\coding\mythscribe`.

## Stack (approved)

| Concern | Recommendation | Why |
|---|---|---|
| Shell | Electron + electron-vite + TypeScript | Native file dialogs, SQLite, fullscreen; Windows builds already worked |
| UI | React 19 | Known quantity; editor ecosystem |
| Editor | **Tiptap (ProseMirror)** instead of Slate | First-class custom inline nodes and a Suggestion extension for inline `#tags` and ghost text; Slate caused most v0 pain (`FEATURES.md` §5.1) |
| State | Zustand (normalized stores per entity) | Ends the reload loops from v0 |
| Styling | Tailwind v4 + CSS variables for design tokens | Enables themes (F-7.8); ends inline-style sprawl |
| Data | better-sqlite3 + Drizzle ORM + numbered migrations; sqlite-vec for embeddings | Typed queries, real migration history (F-8.2), one project folder |
| IPC | One typed contract in `src/shared/ipc/` with zod validation | Fixes the `window.api as any` drift |
| AI | Provider interface in main; **OpenAI SDK as default adapter**; Cloud adapter speaks the same interface to our proxy; keys in Electron `safeStorage` | F-5.1, F-15.1, F-15.4 |
| Cloud | Cloudflare Workers (Hono) proxy + Lemon Squeezy webhooks + magic-link auth | Serverless, no content storage, cheap at zero users |
| Tests | Vitest + Testing Library; Playwright for Electron e2e | v0 had zero tests |
| Tooling | ESLint (flat config) + Prettier; electron-builder; Azure Trusted Signing | Keep what worked; signed builds from first public beta |

Alternatives considered: Lexical (fine, smaller mention ecosystem); Tauri (smaller binary, weaker Node/SQLite story here); keeping Slate (rejected).

## Architecture

Per-area notes (one bullet per subsystem: owners, channels, stores, known gaps) live in `docs/ARCHITECTURE.md`. Grep it for the file or feature ID you are touching and read that bullet only; update it in the same change when the code changes. The shape: `src/shared/` owns every contract (IPC channels in `ipc/contract.ts`, zod schemas, enums, budgets, prompt limits); `src/main/` is Electron main (db with numbered migrations, project store, tree, tags, voice, the AI request path, providers, prompts, menu); `src/renderer/` is React with one Zustand store per entity under `features/`; `src/preload/` exposes only contract channels; `e2e/` drives the built app with a fake OpenAI on loopback.

## Conventions

- Planned layout for later areas: `src/main/ai/{providers,prompts,context,postprocess}`, `src/main/jobs/`, `src/renderer/features/{manuscript,editor,tags,ai,focus,account}`.
- Prompts: `src/main/ai/prompts/<feature>.v<N>.ts` with a golden test each.
- No inline style objects except truly dynamic values.

## Reference

- Spec: `FEATURES.md` · Strategy and AI design: `PLAN.md` · Per-area notes and gotchas: `docs/ARCHITECTURE.md`
- Old prototype for archaeology only: `git show v0-legacy:src/main/database.ts`
- Brand assets: originals in `art/`, derived files in `resources/`, `build/`, `src/renderer/assets/`
