# MythScribe — Claude Code project guide

MythScribe is a local-first desktop novel-writing app (Scrivener-style organizer + distraction-free
editor + story tagging + AI that understands the author's manuscript).

## The one rule

**`FEATURES.md` is the single source of truth.** It defines every feature by ID (`F-3.2`), its
rebuild status, and the milestone order. Nothing gets built that is not in it; nothing gets marked
built until it is verified. If you learn something that changes the spec, edit `FEATURES.md` in the
same change.

The original prototype was deleted on purpose (git tag `v0-legacy` has it). Do not resurrect its
code. `FEATURES.md` §5 lists the mistakes it made; do not repeat them.

## Status

- Stack: **awaiting approval** (see "Proposed stack" below). Until approved, do not scaffold.
- Milestone: M0 Foundation not started.

## Workflow

- `/feature F-x.y` — implement one feature end to end (plan → build → review → verify → update `FEATURES.md`).
- `/audit` — reconcile `FEATURES.md` statuses with the code.
- Work in milestone order (`FEATURES.md` §6) unless told otherwise.
- Small, complete slices. A feature is done when it works in the running app, passes the quality gates, and its checkbox is ticked.
- Before touching the schema, the IPC contract, or more than ~8 files, show the plan and wait for approval.

## Quality gates (must pass before a feature is "built")

Once scaffolded these become real scripts; keep this list in sync with `package.json`:
- `typecheck` — zero errors, no `any` escapes for the IPC bridge
- `lint` — zero warnings
- `test` — unit tests for the data layer and editor commands
- `test:e2e` — smoke test: create project → write → reopen → text is still there
- Manual check in the running app for anything visual

## Proposed stack (awaiting approval — recommendation, not decided)

| Concern | Recommendation | Why |
|---|---|---|
| Shell | Electron + electron-vite + TypeScript | Native file dialogs, SQLite, fullscreen; the author already ships Windows builds with it |
| UI | React 19 | Known quantity; huge editor ecosystem |
| Editor | **Tiptap (ProseMirror)** instead of Slate | First-class custom inline nodes and a Mention/Suggestion extension: exactly what inline `#tags` and ghost text need. Slate caused most v0 pain (FEATURES.md §5.1) |
| State | Zustand (normalized stores per entity) | Kills the reload loops from v0; per-document subscriptions |
| Styling | Tailwind v4 + CSS variables for design tokens | Enables the theme system (F-7.8); ends inline-style sprawl |
| Data | better-sqlite3 + Drizzle ORM + numbered migrations | Typed queries, real migration history (F-8.2) |
| IPC | One typed contract in `src/shared/ipc/` with zod validation, generated preload | Fixes the `window.api as any` drift |
| AI | Provider interface in main; Anthropic SDK as default provider, OpenAI adapter optional; model is a setting; keys in Electron `safeStorage` | F-5.1; use the `/claude-api` skill for current model IDs when implementing |
| Tests | Vitest + Testing Library; Playwright for Electron e2e | v0 had zero tests |
| Tooling | ESLint (flat config) + Prettier; electron-builder | Keep what worked |

Alternatives considered: Lexical (fine, smaller ecosystem for mentions); Tauri (smaller binary, but Rust backend and weaker SQLite/Node story for this author); keeping Slate (rejected, see §5.1).

## Conventions (apply once scaffolded)

- `src/main/` (Electron main: db, ipc handlers, ai providers, menu), `src/preload/`, `src/renderer/` (React), `src/shared/` (types, ipc contract, constants). Tests beside the code as `*.test.ts`.
- Feature folders in the renderer: `src/renderer/features/<area>/` (manuscript, editor, tags, ai, focus, shell).
- Every IPC channel: defined once in the contract, validated with zod, typed on both sides.
- No native `alert`/`confirm`/`prompt`. Use the dialog service.
- No inline style objects except for truly dynamic values (positions, colors from data).
- Commit messages: imperative, reference the feature ID (`F-3.2: autosave with debounce`).
- Never commit `.env` or API keys.

## Reference

- Spec: `FEATURES.md`
- Old prototype for archaeology only: `git show v0-legacy:src/main/database.ts` etc.
- Brand assets: `resources/` (icon, logo)
