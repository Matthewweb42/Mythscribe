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

- **Business:** free desktop app; BYOK AI; paid MythScribe Cloud (subscription + credit packs); one-time Supporter license. Billing via **Lemon Squeezy** (merchant of record).
- **AI provider:** **OpenAI-first** for both the default BYOK setup and Cloud, chosen for price. The provider interface stays generic; an Anthropic adapter is optional later. Local models (F-5.15) are deferred past launch.
- **Name:** MythScribe. **Goal: launch as soon as possible.** Scope is cut toward the launch line in `FEATURES.md` §6, not expanded.
- **Stack:** approved 2026-09-10 and scaffolded (see Stack below). M0 Foundation is built and all gates pass (the e2e test needs the system libraries listed under Dev environment).

## Next up (keep this current; it is the handoff between sessions)

1. M0 is complete: all four gates pass (typecheck, lint, unit, e2e) and F-7.6, F-8.1, F-8.2 are ticked.
2. Start M1 with `/feature F-1.2` (create-project wizard), then F-1.1, F-1.3, F-1.4, F-1.5, then the manuscript tree (F-2.x) and editor (F-3.x) in milestone order.

## Workflow

- `/feature F-x.y` — implement one feature end to end (plan → build → review → verify → tick the box).
- `/audit` — reconcile `FEATURES.md` statuses with the code.
- Work in milestone order (`FEATURES.md` §6). Launch-line features first; anything past the line waits.
- Small, complete slices. A feature is done when it works in the running app, passes the gates, and its checkbox is ticked.
- Before touching the schema, the IPC contract, prompts, or more than ~8 files, show the plan and wait.

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
1. AI output is always a `Proposal`; nothing enters the manuscript without an explicit accept (F-14.5). Accepted text carries provenance (F-14.6).
2. Every prompt that generates prose includes the voice profile, the scene brief, and retrieved exemplars (F-14.1–14.3); every generated proposal passes the fidelity check (F-14.7) before display.
3. Respect the AI dial and per-feature toggles (F-14.4). Installs at Off. A feature must not send text the data-sharing panel does not list.
4. Grounded answers only: Story Intelligence answers cite manuscript passages or say "not found" (F-5.7). Critique cites a passage for every claim; no uncited praise (F-14.8).

**Token efficiency** (measure with the usage ledger, F-5.14; budgets are per feature)
1. **Tiers, not names.** Request `fast` or `strong` (F-5.11). Ghost text, tags, summaries, embeddings, and classification use `fast`. Only Author mode, critique, and queries may use `strong`.
2. **Retrieve, do not dump.** Never send the whole manuscript. Context is built from scene summaries (~100 tokens each), entity sheets, and the top-k retrieved chunks within a fixed budget (default: 3 full scenes + 10 summaries, hard cap per feature). Recent text at the caret is capped (~500 characters for ghost text).
3. **Stable prefix first.** Order prompts as: system rules → voice profile → story bible → task-specific context → user turn, so provider prompt caching applies to the stable part. Do not interleave dynamic text into the prefix.
4. **Cache locally.** Identical (feature, prompt version, context hash) requests return the cached proposal. Summaries and embeddings are invalidated by content hash, not by time.
5. **Trigger discipline for ghost text.** Minimum idle interval, minimum new characters typed since the last request, no request while a proposal is pending or visible, per-day cap. Off at dial ≤ 1.
6. **Short outputs, structured where possible.** Set `max_tokens` per feature (ghost text ≤ 60; tags ≤ 200; summaries ≤ 150). Use JSON/structured output for tags, summaries, and critique so parsing is exact and retries are rare.
7. **Batch the background.** Indexing (summaries, embeddings) goes through the job queue (F-5.13) and uses the provider batch API when available; never block typing; coalesce edits so a scene is summarized once per burst.
8. **Count before you send.** Estimate tokens locally; if a request would exceed its budget, trim context by priority (drop far summaries, then exemplars, then recent text) rather than failing or overspending.
9. **Prompts are compact and versioned** (F-5.12): no restated instructions, no examples the retrieval already supplies, no reasoning dumps. Every prompt change runs the eval harness and reports token delta and fidelity delta in the PR.
10. **Cost is visible.** Each proposal records model, tokens in/out, and cost; Settings shows the running total. A feature that cannot report its cost is not done.

**Token efficiency in this repo (for Claude Code itself)**: do not re-read files already in context; grep before reading; delegate broad searches to `Explore`; keep agent prompts to the feature text and file list; one implementer at a time unless slices are independent.

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
npm run build:win      # installer via electron-builder
```

## Quality gates (must pass before a feature is "built")

- `npm run typecheck` — zero errors
- `npm run lint` — zero warnings
- `npm run test` — unit tests for the data layer, editor commands, prompt builders, post-processors
- `npm run test:e2e` — smoke test: create project → write → reopen → text is still there (M0 version: create → close → reopen)
- `eval:ai` — prompt golden tests and fidelity/token report (once F-5.12 exists)
- Manual check in the running app for anything visual

## Dev environment

- The author develops on WSL2 (Ubuntu 24.04, arm64) with WSLg, so Electron can show a window. Electron needs these system packages once: `sudo apt-get install -y libnss3 libnspr4 libasound2t64`. Without them `npm run test:e2e` and `npm run dev` fail with `libnspr4.so: cannot open shared object file`.
- The repo lives on `/mnt/c`, so installs and test startup are slow; that is the mount, not the code.

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

## Architecture (as built in M0)

- `src/shared/ipc/contract.ts` — the IPC contract: every channel's zod input/output, main→renderer events, error codes. Add a channel here first; both sides are typed from it.
- `src/main/ipc/registry.ts` — `register(channel, fn)` validates input and wraps errors; throw `AppError(code, message)` from handlers. `emit(windows, event, payload)` pushes events. Handlers live in `src/main/ipc/handlers.ts`.
- `src/main/db/` — `schema.ts` (Drizzle), `migrations/` (generated SQL, numbered, committed, never edited), `migrate.ts` (runner with `schema_migrations` table), `connection.ts` (`openDatabase` applies pragmas and migrations).
- `src/main/project/` — `projectStore.ts` creates/opens the `<Name>.mythscribe/` folder; `manager.ts` owns the single open project and notifies on change.
- `src/preload/index.ts` — exposes `window.mythscribe` (`invoke`, `on`), restricted to contract channels. Sandbox and context isolation are on.
- `src/renderer/lib/ipc.ts` — `ipc().invoke(channel, input)` typed client that validates outputs; `setIpcClient` for tests.
- `src/renderer/features/shell/dialogs/` — the dialog service: `dialogs.confirm`, `dialogs.prompt`, `toast.*`, rendered by `<DialogHost/>`.
- `src/renderer/features/project/projectStore.ts` — Zustand store for the open project; pattern for all renderer stores.
- `src/renderer/styles/tokens.css` — every color/font/radius as `--ms-*` variables, mapped to Tailwind utilities in `app.css` via `@theme inline`. Components use utilities like `bg-surface`, `text-fg-muted`, `border-line`, `bg-accent`.
- Tests beside code as `*.test.ts(x)`; vitest runs `main` (node) and `renderer` (jsdom) projects. E2E in `e2e/` drives the built app; native dialogs are bypassed by passing explicit paths through the bridge.

## Conventions

- Planned layout for later areas: `src/main/ai/{providers,prompts,context,postprocess}`, `src/main/jobs/`, `src/renderer/features/{manuscript,editor,tags,ai,focus,account}`.
- Prompts: `src/main/ai/prompts/<feature>.v<N>.ts` with a golden test each.
- No inline style objects except truly dynamic values.

## Reference

- Spec: `FEATURES.md` · Strategy and AI design: `PLAN.md`
- Old prototype for archaeology only: `git show v0-legacy:src/main/database.ts`
- Brand assets: `resources/`
