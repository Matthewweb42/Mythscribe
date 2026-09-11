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
2. M1 is under way: F-1.1 through F-1.5 and F-2.1 through F-2.4 are done (the `node` table exists; `tree:create`/`tree:rename`/`tree:duplicate`/`tree:delete`/`tree:move` are the mutation channels; the tree store owns selection, collapse, and rename state). Continue with `/feature F-2.5` (stacked view; it needs the editor, so pair it with F-3.1 if F-3.1 is not yet built), then F-2.6 and the rest of the editor (F-3.x) in milestone order. v0 import was split out as F-1.6 (post-launch).
   - Known e2e flake (2026-09-11, seen three times, only right after the 20-worker `npm run test` run): the wizard steps at the top of `e2e/smoke.spec.ts` fail under load (the empty-name alert missing, the name shrinking after Back, or a stray keystroke appended to the name: `Smoke Novelo`). Passes 3/3 idle. If it recurs, keep `test-results/**/trace.zip` and inspect before changing the test; do not add Playwright retries to hide it.
   - Dev-machine note: projects created before F-1.3 (2026-09-10, e.g. `~/test.sqlite.mythscribe`) have no seeded sections, so `tree:list` returns nothing for them. They are throwaway; delete them rather than adding a repair path. F-2.1 must still render sanely for an empty tree.
3. Small follow-up for F-8.3: `quitRequested` in `src/main/index.ts` is never reset, so on macOS an abandoned Cmd+Q (flush failed, user kept working) makes the next plain window close quit the app. Reset it when a close is cancelled.

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
- `npm run test` — unit tests for the data layer, editor commands, prompt builders, post-processors (vitest runs 4 reused workers without per-file isolation, see `vitest.config.ts`; every test file must reset module state such as Zustand stores and the IPC client in `beforeEach`)
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
- `src/main/project/seed.ts` — pure `seedSkeleton(format)` (3 sections + Part/Chapter/Scene skeleton, 17 rows) and `seedSettings(format)`; run inside `createProject`'s transaction. `src/main/tree/treeStore.ts` — `insertNodes`, `listNodes` (ordered parent, position, id; roots first), `toTreeNode`; `TreeDb` accepts the orm or a transaction handle.
- `src/shared/labels.ts` — `SectionType`/`HierarchyLevel`/`NodeKind` enums (one owner; Drizzle columns use the same tuples), `sectionLabel(format, section)`, `levelLabel(format, level)`, `skeletonSummary(format)`. Section rows store the canonical key (`front`/`manuscript`/`end`) as `title`; the UI must label roots via `sectionLabel`, never `title`.
- `src/shared/editorSettings.ts` — zod `EditorSettings` and `defaultEditorSettings(format)` (F-3.6 defaults); stored in the project `settings` table under key `editor` as JSON.
- `src/main/appState/` — app-level (not per-project) state in `<userData>/app-state.json`: `appStateStore.ts` reads lazily, validates with zod, writes atomically; `recents.ts` holds the pure recents list operations. Recents are recorded on the `manager.onChange` hook in `handlers.ts`. F-7.9 window state belongs in the same file. `MYTHSCRIBE_USER_DATA` overrides the userData directory (used by e2e for isolation; the single-instance lock also lives there, so e2e and `npm run dev` can run concurrently).
- `src/renderer/features/project/pendingSaves.ts` — the pending-save registry: `registerPendingSave(flush)` returns an unsubscribe; `flushPendingSaves()` runs every flusher and rethrows the first failure. The project store awaits it before create/open/close and in `closeWindow()`. F-3.2 autosave registers here.
- Window close and quit: with a project open, main prevents the window `close`, emits `window:close-requested`, the renderer flushes and invokes `window:close`, and main closes the project and windows. `manager.close()` runs on `will-quit` (not `before-quit`) so the database outlives the flush. A failed flush leaves the window open with a toast.
- `src/main/lifecycle.ts` — `installSingleInstance` requests Electron's single-instance lock and focuses the existing window on a second launch; `index.ts` quits when the lock is refused.
- `src/main/project/legacy.ts` — `isLegacyDatabase` opens a database read-only and detects the v0 layout (`documents` table, no `node` table); `locateProject` in `projectStore.ts` uses it so a v0 file is refused with a clear message instead of being migrated by accident.
- `src/preload/index.ts` — exposes `window.mythscribe` (`invoke`, `on`), restricted to contract channels. Sandbox and context isolation are on.
- `src/renderer/lib/ipc.ts` — `ipc().invoke(channel, input)` typed client that validates outputs; `setIpcClient` for tests.
- `src/renderer/features/manuscript/` — `treeStore.ts` is the one owner of tree state: normalized `byId`/`childrenOf`/`rootIds`, derived `sectionOf` and `wordCountRollup` (rebuilt once per `load()` from `tree:list`), plus `selectedId` and in-memory `collapsed`. F-2.2–2.4 mutate it by updating the changed records, never by reloading the world. `ManuscriptTree.tsx` is an ARIA tree (roving tabindex, arrow keys); sections are labelled via `sectionLabel` and are not selectable; front/end-matter documents carry `data-matter` and the gold `text-matter` color. Per-level colors are tokens (`--ms-level-*`, `--ms-matter`) so themes (F-7.8) can override them. `App.tsx` loads/clears the store on project open/close and renders the fixed-width sidebar + main pane (F-7.2 adds resizing).
- Tree mutations: main validates structure inside a transaction in `src/main/tree/treeStore.ts` (`createNode`, `renameNode`, `duplicateNode`, `deleteNode`, `moveNode`; section roots are refused with `VALIDATION`, sibling positions stay contiguous: gap-close the old siblings, then shift the new ones, then land the row) and returns the row(s); the renderer store merges the returned records with pure, tested helpers (`insertIntoIndex`, `duplicateIntoIndex`, `removeFromIndex`, `moveInIndex`, `planRemoval` for the post-delete selection fallback) instead of reloading; `expandAncestors` opens the path to a new node. The structural rule (what level fits under which parent) has one owner, `canPlaceLevel` in `src/shared/labels.ts`, used by main and by `resolveDropTarget` in `placement.ts`. `tree:move`'s `afterId` is tri-state: `undefined` appends, `null` inserts first, a string inserts after that sibling. Delete confirms through `dialogs.confirm` in `ManuscriptTree.tsx`. Drag and drop is native HTML5 (no dependency); the transient drag state and the indicator live in `ManuscriptTree.tsx`, not the store. In e2e, `locator.dragTo()` on an expanded folder row needs an explicit `sourcePosition` inside the header row, or it grabs the centre of the whole subtree. `placement.ts` is the one place that turns "selection + level" into `{ parentId, afterId }` (bottom bar, context menu, and later Insert menu/shortcuts all use it). `contextMenuItems.ts` returns plain `{ id, label }` data so F-7.1 can render the same items natively; F-2.6 appends its template group there. Default titles come from `defaultNodeTitle` in `src/shared/labels.ts`.
- Brand: the originals are `art/Full-Logo.png` (wordmark, transparent; navy "Myth" so light surfaces only) and `art/Small-Logo.png` (icon tile). Derived, committed assets: `build/icon.png` (512px, electron-builder generates the `.ico`/`.icns` from it at package time), `resources/icon.png` (the same tile, imported in `src/main/index.ts` with `?asset` as the Windows/Linux window icon), `resources/logo-full.png` (cropped wordmark), and `src/renderer/assets/logo-mark.png` (256px tile rendered by `Logo.tsx` as an `<img>`). Regenerate all four from `art/` if the originals change; do not hand-edit the derived files.
- `src/renderer/features/shell/dialogs/` — the dialog service: `dialogs.confirm`, `dialogs.prompt`, `toast.*`, rendered by `<DialogHost/>`.
- `src/renderer/features/project/projectStore.ts` — Zustand store for the open project; pattern for all renderer stores.
- `src/renderer/features/project/formats.ts` — the format catalogue (label, summary, structure) for Novel / Epic / Web novel; one owner for format copy, which F-1.3 seeding and F-1.5 labels must keep in sync.
- `src/renderer/styles/tokens.css` — every color/font/radius as `--ms-*` variables, mapped to Tailwind utilities in `app.css` via `@theme inline`. Components use utilities like `bg-surface`, `text-fg-muted`, `border-line`, `bg-accent`.
- Tests beside code as `*.test.ts(x)`; vitest runs `main` (node) and `renderer` (jsdom) projects. E2E in `e2e/` drives the built app; native dialogs are stubbed from the main process via `app.evaluate` (see the save-dialog stub in `e2e/smoke.spec.ts`) or bypassed by passing explicit paths through the bridge.

## Conventions

- Planned layout for later areas: `src/main/ai/{providers,prompts,context,postprocess}`, `src/main/jobs/`, `src/renderer/features/{manuscript,editor,tags,ai,focus,account}`.
- Prompts: `src/main/ai/prompts/<feature>.v<N>.ts` with a golden test each.
- No inline style objects except truly dynamic values.

## Reference

- Spec: `FEATURES.md` · Strategy and AI design: `PLAN.md`
- Old prototype for archaeology only: `git show v0-legacy:src/main/database.ts`
- Brand assets: originals in `art/`, derived files in `resources/`, `build/`, `src/renderer/assets/`
