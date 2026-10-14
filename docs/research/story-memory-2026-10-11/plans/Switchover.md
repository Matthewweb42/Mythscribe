# Switch-over, part A (the author's switch of the real project): implementation plan

**Feature:** F-16.31, **part A only** (`FEATURES.md` §2.16). The switch-over phase of the story memory redesign, approved by the author on 2026-10-11 (`../design.md` Part 3 "The author's Drive project", Part 4's Switch-over row, Part 5's index row; `../author-answers.md` answers 16, 17, 19, 22; decision 8). It turns F-16.15's flow, built and tested on copies in P1 slice 6, into the step the author runs on her real project from the installed app. **Size:** M, about 4–5 days, in five slices. **Status:** planned 2026-10-14; slice 1 built 2026-10-14 (notes at the end of §1); slice 2 built 2026-10-14 (notes at the end of §2); slice 3 built 2026-10-14 (notes at the end of §3).

**Goal:** a v1 project (the author's, in Google Drive; or anyone's) can be switched to the new story memory from the installed app, safely and once. The app recommends a trial on a copy first and says plainly what changes. The real run makes the safety copies first (Drive flushed, a kept backup, a dated copy in Drive), shows the dry run and the consent screen, converts in one transaction, stores `storyMemory: v2` and reopens the project on v2 without a restart. *Rebuild memory* then asks once with its price (outside the Cloud monthly background cap; the daily cap still applies; with Use AI off it waits and a notice offers it later), and ends with the grouped summary. The final screen says where the backup and the dated copy are and how to go back. A failure at any step leaves the project on v1, untouched, and says what failed and what to do next.

**Part B is not built here.** Deleting the v1 code, retiring the feature ids, forcing the switch-over on open, new projects on v2 and closing the "replaced by F-16" features wait for the author's switch of her real project after the live runs (§7 has its scope and its gate). Every v1 path keeps working; F-16.31 is not ticked.

**Rules that hold in every slice** (P1–P4's, carried over):
1. **v1 is unchanged.** A v1 project sends, stores and shows what it does today until the author presses Convert. New projects stay v1 (`DEFAULT_STORY_MEMORY`); opening a v1 project never offers or forces the switch on its own. The smoke e2e (`e2e/smoke.spec.ts`, v1) is not edited.
2. **No migration.** Everything new is a project `settings` row (the switch-over record) or app-side files (the kept backup). The old tables stay until F-16.38 (P9).
3. **No new prompt version.** The rebuild after the switch is P2a–P4's *Rebuild memory*: `reader.v2`, `verify.v2` and the contradiction sweep's `judge.v1`, with their budgets, caps and reasoning settings unchanged (§6). The switch-over itself calls no model. If a slice edits `aiCostNotes.ts` text, it runs `npm run eval:ai -- -u` once and quotes the registry diff.
4. **No live run can happen in the build sessions** (no API key). The live switch-over run (§5.3) is built for the author, who runs it with `OPENROUTER_API_KEY` after the whole build (CLAUDE.md 1c); every slice says so.
5. **Nothing reaches the author's real project in a build session.** Tests and the e2e work on fixtures in temporary folders; the e2e's "Drive" is a temp folder named `My Drive` (F-8.1's detection).
6. `src/main/ipc/handlers.ts` (over 5,700 lines) only registers channels; the steps live in `src/main/memory/switchover/` (new `run.ts`, `record.ts`, `checkConverted.ts`). `readerService.ts` gains only the record's hold and notice. The renderer's flow stays in `src/renderer/features/switchover/`.
7. Tag, entity, knowledge, Organise and To do code stays frozen for edit lists; part A reads the v1 tables through P1's `buildSwitchoverModel` and edits none of their code.
8. Lint per folder (`npx eslint --max-warnings 0` on `src/shared`, `src/preload`, `src/main`, `src/renderer`, `cloud`, `e2e`, `scripts`); the full gate suite at most twice per slice; Node-heavy commands under `flock /tmp/mythscribe-heavy.lock`.
9. Each slice updates the "Switch-over" bullet in `docs/ARCHITECTURE.md`, logs its calls in `QUESTIONS.md` ("Switch-over slice n", decided by Claude, unconfirmed), and adds a dated note to F-16.31's entry saying what part A built. The box stays unticked: F-16.31 needs the author's run in the installed app, and part B.

**Build order:** slice 1 (the in-place run, main side: safety, the kept backup, the steps and their failures, the record, the check inside the transaction, channels) → 2 (the rebuild after the switch, main side: the record's waiting state, the hold and the notice, the caps) → 3 (the entry points and the in-place flow in the renderer, the final screen; the e2e's first half) → 4 (the rebuild ask, the notice row, the record in Settings; the e2e's second half) → 5 (the v1 test book, the offline switch-over replay, the live switch-over run for the author, the final verification). Main first (1–2), UI after (3–4). Each slice builds, gates and commits on its own.

**What exists and what changes:**

| Piece | Today (P1 slice 6, P2a–P4) | Part A |
|---|---|---|
| Entry | Help › *Try the story-memory switch-over on a copy…*, unpackaged builds only (`switchover:available`, `menuFor({ switchover })`) | Help › *Switch to the new story memory…* and Settings › AI › Story memory, in every build, while a v1 project is open; an intro screen recommends the copy first |
| Trial on a copy | `switchover:trialCopy`; the channels refuse a project without the `switchoverTrial` row unless `allowInPlace` | Kept as built, in every build; the trial row only changes wording; a test copy gets no backup or dated copy of its own (SW-D4) |
| Safety | At Convert: `WorkingCopy.syncNow`, `backups.backupNow()` (a rolling zip), `saveSafetyCopy` | On the real project before the dry run (design order); a **kept** backup that retention never deletes; re-flushed and backed up again at Convert if anything changed since |
| Dry run, consent, conversion | `planSwitchover`, `inlineTagReplacements`, `convertSwitchover` in one transaction | Unchanged rules; the dry run's price includes the contradiction sweep; the conversion also writes the switch-over record and checks its own result before committing |
| Failure | AppErrors thrown, shown as a red line | Step-labelled outcomes: what failed, "nothing was changed", the next step |
| After | Main closes, the renderer reopens the folder on v2 | The same, for the real project's own folder (Drive copied back on close) |
| Rebuild | *Rebuild memory* (Book tab, `draftUnread` notice), asked spend (P2a-D9) | One ask on the final screen with the price; until a rebuild starts, one Needs a look notice instead of the unasked backlog |

---

## 0. The shape of it

```
Help › Switch to the new story memory…  |  Settings › AI › Story memory › Switch…     (v1 project, any build)
   intro: what changes · "Try it on a copy first" (recommended) · "Switch this project…" · Cancel
   ├─ copy: switchover:trialCopy ─► the copy opens (v1, trial row) ─► dry run ─► consent ─► convert ─► copy opens on v2
   └─ this project:
        switchover:safety  (flush Drive working copy ─► kept backup ─► dated copy beside the project, in Drive)
           └─ fails ─► "What failed: … Nothing was changed. Next: …"   (project still v1)
        switchover:plan    dry run: kept / converted / dropped by name · merge ticks · Filed by AI earlier
                           (Not canon) · nesting and dismissals that cannot convert · rebuild price and time
        switchover:consent every inline tag with its editable words
        switchover:convert { consent, projectId }
           changed since the safety step? ─► flush + a fresh kept backup
           prepareSwitchover (uploads' originals, outside the transaction)
           one transaction: rewrite node.content / node.notes / draft_text (snapshots untouched) · records ·
             labels · Research · details · dismissals · merges · AI plan links off · the switch-over record ·
             checkConverted (any problem throws: rolled back) · storyMemory = v2
           manager.close() (Drive copied back) ─► renderer opens the same folder ─► v2, no restart
   final screen: counts · backup (kept) · dated copy · how to go back · Rebuild memory: ask once with its price
        Use AI on, provider, priced ─► Rebuild now ─► RebuildDialog (progress, Stop) ─► grouped summary
        Later / Use AI off / no provider / Cloud price unknown ─► Needs a look: "not read since the switch-over" notice
```

---

## 1. Slice 1: the in-place run, main side (safety, kept backup, steps and failures, the record)

### 1.1 The kept backup (F-8.4, F-8.7's rule that retention never touches it)

- `src/shared/backups.ts`: `KEPT_BACKUP_LABEL = 'before story memory'`; `keptBackupFileName(safeName, date)` → `<Name> before story memory YYYY-MM-DD HHmmss.zip`; `isKeptBackupName(name)`; `BackupEntry.kept: z.boolean()` (false for every rolling backup); `backupsToPrune(entries, keep)` skips kept entries and does not count them toward `keep`.
- `src/main/backups/backupArchive.ts`: `listBackups` sets `kept`; `pruneBackups` deletes only rolling ones. `parseBackupFileName` already reads the name (the label sits in the `.+` part), so a kept backup is listed and restorable through `backups:restore { file }`; `backupProjectName` gives the restored project "<Name> before story memory".
- `src/main/backups/backupService.ts`: `backupNow({ kept: true })` writes the kept name through the same `createBackupArchive` (a full zip of the folder: database snapshot, uploads and assets) and never prunes it; the return gains the file it wrote (`{ state, file }`), so the switch-over stops reading `backups[0]`.
- Settings › Backups lists a kept backup with "(kept: before story memory)" (`BackupsSettingsTab.tsx`'s row; one renderer line and its test, slice 1 because the schema changes here).

### 1.2 The steps (`src/main/memory/switchover/run.ts`, new)

```ts
export const SWITCHOVER_STEPS = ['flush', 'backup', 'datedCopy', 'project', 'convert'] as const  // shared
interface SwitchoverRunDeps {
  session: ProjectSession                 // folder (the Drive folder for a Drive project), connection, workingCopy, info
  backupNow: (options: { kept: true }) => string   // the zip written; throws with the cause
  current: () => ProjectInfo | null       // manager.current()
  close: () => void                       // manager.close(): the Drive working copy is copied back
  now: () => Date
}
```

- **`switchoverSafety(deps)`** (the real project only; VALIDATION on a trial copy, whose original is its safety): in order (1) `session.workingCopy?.syncNow(sqlite)` (step `flush`), (2) `backupNow({ kept: true })` (step `backup`), (3) `saveSafetyCopy({ folder: session.folder, sqlite }, now)` (step `datedCopy`; beside the project, so in Google Drive for a Drive project; `saveDatedCopy` already removes a half-made copy). It answers `SwitchoverSafetyOutcome` (`{ ok: true, backup, datedCopy }` or a `SwitchoverFailure`) and keeps a **safety memo** in the handler's closure: `{ projectId, backup, datedCopy, changes: totalChanges(sqlite) }`, dropped on every `manager.onChange`. A second safety call while a memo stands for this project answers the memo (the author pressed Back to the intro and on again: no second dated copy). *(Review, 2026-10-14: only for the same open session while nothing has been written since and its files exist; otherwise all three run again. See "Reviewed" below.)*
- **`runConvert(deps, { consent, projectId }, memo)`**:
  1. `project` step: the open project's id must equal `projectId` and its stored memory must be v1 (`ALREADY_SWITCHED` otherwise); a real project needs a memo for this project (else VALIDATION "Make the backup first", which the renderer never hits).
  2. Changed since the safety step (`totalChanges(sqlite) !== memo.changes`: an autosave behind the dialog, a v1 background job): `syncNow` (step `flush`) and a fresh `backupNow({ kept: true })` (step `backup`); the record names the newest backup. The dated copy stays the one made before the dry run (SW-D3).
  3. `prepareSwitchover(db, folder)` (an unreadable original is already tolerated per file); `manager.current()` checked again after the await (step `project`).
  4. `convertSwitchover(db, format, prepared, consent, now, { record })` (§1.3; step `convert`: a throw rolls the transaction back).
  5. `close()`; answers `{ ok: true, folder, trial, backup, datedCopy, counts }`.
- **Failures** never throw past `run.ts` for the steps above; each becomes `SwitchoverFailure { ok: false, step, message, nextStep }`. Every message ends "Nothing was changed: this project still uses the old story memory." The texts:

| Step | Message (the cause from the error) | Next step |
|---|---|---|
| `flush` | "Could not copy the project to Google Drive first: <cause>." (the provider's label from `CLOUD_PROVIDER_LABEL`) | "Check that Google Drive is running and signed in, then try again." |
| `backup` | "Could not make the backup: <cause>." | "Choose another backup folder in Settings › Backups, then try again." |
| `datedCopy` | "Could not save the dated copy beside the project: <cause>. The backup made a moment ago is kept: <file>." | "Check there is room in <parent folder>, then try again." |
| `project` | "The open project changed during the switch-over." / `ALREADY_SWITCHED` | "Open the project again and start from Help › Switch to the new story memory…." |
| `convert` | "The conversion stopped and undid everything: <cause>." (a `checkConverted` problem names itself) | "Try again. If it stops again, your backup is <file>; please send this message to support." |

  A failure after the transaction committed cannot happen inside `run.ts` (close and reopen are after it); the renderer reports a failed reopen as P1 does ("switched, but it did not open again").
- **Trial copies** keep P1's behaviour for steps 3–5 and skip the safety step entirely: the original project is never written (P1's hash test stands), so the copy needs no backup or dated copy of its own (SW-D4). `backup` and `datedCopy` are null in a trial's outcome.
- The build gate goes from the run (`requireSwitchoverBuild` for `trialCopy`, `plan`, `consent`, `convert`), and with it `requireSwitchoverTarget`, `NOT_A_TRIAL` and `allowInPlace`; the trial row stays (wording, and `SwitchoverRecord.trial`). `switchover:available` keeps answering `!app.isPackaged` until slice 3 deletes it with the developer menu item, so this slice changes no menu.

### 1.3 The conversion's additions (`convert.ts`, `record.ts`, `checkConverted.ts`)

- **The switch-over record** (`src/shared/memory/switchover.ts`): `SWITCHOVER_RECORD_KEY = 'switchover'`, a project `settings` row (no migration):
  ```ts
  SwitchoverRecord = z.object({
    switchedAt: z.string(),
    trial: z.boolean(),
    backup: z.string().nullable(),        // the kept zip (null on a test copy)
    datedCopy: z.string().nullable(),     // the dated copy's folder (null on a test copy)
    rebuild: z.enum(['waiting', 'started']),
    rebuildStartedAt: z.string().nullable()
  })
  ```
  `record.ts`: `getSwitchoverRecord(db)` (lenient: a broken row reads null), `setSwitchoverRecord`, `markRebuildStarted(db, now)` (slice 2). `convertSwitchover` gains a last parameter `{ record: Omit<SwitchoverRecord, 'switchedAt' | 'rebuild' | 'rebuildStartedAt'> }` and writes the row in its transaction, `rebuild: 'waiting'`, just before `setStoryMemory(v2)`.
- **`checkConverted(tx, before)`**, run inside the transaction after step 8 (plan links) and before the record and the switch; any problem throws `AppError('VALIDATION', …)`, which rolls everything back:
  - no `inlineTag` node left in any `node.content`, `node.notes` or `draft_text` (`inlineTagTokens`);
  - `snapshot` rows: count and a SHA-256 over their text equal to `before` (taken at the transaction's start);
  - every manuscript document's text, with each token's consented words put back by `replaceInlineTags`, equals its text before (no prose lost or moved; compared on `docToText`);
  - `checkMemoryInvariants` over the records, aliases and dismissals written: no alias clash, no record without a name;
  - every converted document parses as stored JSON (`documentJson` not null).
  The `before` snapshot (document texts, snapshot hash) is read in the same transaction, so a large book costs one extra pass of string work (no I/O).
- **The dry run's price** (`plan.ts`): `planSwitchover` prices the rebuild exactly as *Rebuild memory* will (SW-D10): `estimateRebuild(model.rebuildScenes, context, judgeOn ? sweepCalls(scenes) : 0)`, where `judgeOn` is `isFeatureAllowed(settings, 'judge')` read from the project's AI settings (`sweepCalls` from `findingsService.ts`). `switchover:plan`'s handler passes the settings.

### 1.4 Channels (`src/shared/ipc/contract.ts`; `CHANNEL_ACCESS`; `CHANNEL_MEMORY`; preload)

| Channel | Access, memory | Change |
|---|---|---|
| `switchover:safety` (new) | write, v1 | input none; output `SwitchoverSafetyOutcome`; the real project only |
| `switchover:convert` | write, v1 | input `{ consent: SwitchoverConsent, projectId: string }`; output `SwitchoverOutcome` = `SwitchoverResult & { ok: true }` (`backup`, `datedCopy` nullable, `trial`) or `SwitchoverFailure` |
| `switchover:trialCopy`, `switchover:plan`, `switchover:consent` | as built | no build gate, no trial-row refusal |
| `switchover:available` | read, any | unchanged until slice 3 removes it |

The renderer store (`switchoverStore.convert`) changes only enough to compile: it sends `projectId` (`useProjectStore.getState().current?.id`) and shows a failure's `message` and `nextStep` as its error line; the copy flow behaves as before.

### 1.5 Tests

- `src/shared/backups.test.ts`: kept names, `isKeptBackupName`, `backupsToPrune` with kept entries in the middle. `backupArchive.test.ts`: `pruneBackups` keeps a kept zip with `keep` 5 and 12 rolling ones; `listBackups` marks it. `backupService.test.ts`: `backupNow({ kept: true })` answers its file, survives 12 later automatic backups, and `restore` of it opens a project named "<Name> before story memory (restored …)". `BackupsSettingsTab.test.tsx`: the kept row.
- `src/main/memory/switchover/run.test.ts` (new), on `buildFixtureV1` opened through a `ProjectManager` whose `detectCloud` says `googleDrive` for a temp `My Drive` folder:
  - success: the call order flush → backup → dated copy (spies), the dated copy beside the cloud folder with a `project.db` that opens as v1 with the fixture's inline tags, the kept zip in the project's backups folder, the outcome's paths, the record row (`trial: false`, `rebuild: 'waiting'`), stored v2, the project closed and the Drive folder holding the converted database after close;
  - a change after the safety step (a `saveDocument` between) → a second kept backup, the record names it, the dated copy is the first;
  - each failing step (`syncNow` throws, `backupNow` throws, `saveSafetyCopy` throws, a wrong `projectId`, the project switched during `prepareSwitchover`, a fault planted in the transaction, `checkConverted` refusing): `{ ok: false, step }`, the message and next step above, stored v1, the database's `rollbackSnapshot` bytes equal to before, no dated copy left (the backup failure leaves none either);
  - a trial copy: no safety call, `backup`/`datedCopy` null, the original's bytes unchanged (P1's hash test, moved here).
- `convertSwitchover.test.ts`: the record row; `checkConverted` throws for a token left (a replacement map that misses one, injected), a snapshot changed, a lost paragraph, an alias clash → nothing written, stored v1.
- `planSwitchover.test.ts`: the rebuild price with the Contradiction check on equals `rebuildEstimate(db)` of the converted fixture under the same context (and without the sweep when off).
- `handlers.test.ts`: the old "refuses without the trial row" cases become: `switchover:safety` refuses a trial copy and a v2 project; `switchover:convert` with a stale `projectId` answers the `project` failure; a full in-place run through the handlers (safety, plan, consent, convert) on a fixture project; the trial run unchanged. `channelAccess.test.ts`: the new channel's rows.

**e2e:** none in this slice (no UI path changes; the P1 copy test still passes through the developer item). Lint, typecheck, `npm run test` once at the end; the full gates once.

**Built (slice 1, 2026-10-14; calls in `QUESTIONS.md` "Switch-over slice 1"):** as above, with these shapes: `run.ts` exports `switchoverSafety(deps, memo)` and `runConvert(deps, input, memo)`, each answering `{ outcome, memo }`, and the `SwitchoverRun` class the handlers hold (the memo between channels, `clear()` on `manager.onChange`); `deps.session` is a getter (`manager.require()`); a failure after the safety step keeps its dated copy; Convert on an already switched project says "Nothing was changed." (not "…still uses the old story memory"); `checkConverted` covers every node's content and notes and every draft (wider than the conversion writes) and names up to three problems; `model.rebuildScenes` counts the converted text so the price equality holds; `BackupService.backupNow` answers `{ state, file }`. The P1 hash test of a test copy moved to `run.test.ts`; `convertSwitchover.test.ts` plants its faults with temporary triggers on the test's connection; the 200-scene timing test is `convert.perf.test.ts` (about 0.7 s).

**Reviewed (slice 1, 2026-10-14; calls in `QUESTIONS.md` "Switch-over slice 1 review"):** the safety memo is `{ session, backup, datedCopy, changes }`, reused only for the same `ProjectSession` (a reopen of the same folder never matches) while `total_changes()` has not moved and its files still exist; otherwise flush, backup and dated copy run again. A failed dated copy keeps the memo with `datedCopy: null`, so *Try again* makes only the dated copy (no pile of kept zips). `runConvert` reads the originals first, checks the project after the await (a moved project answers no memo), then, with nothing asynchronous left before the transaction, makes the copies current: anything written since the safety step, during the await included, is flushed, backed up and copied beside the project again, so the record's backup and dated copy are the project exactly as it was before the conversion (SW-D3 amended). A conversion that fails answers the memo at the change count after its rollback, so trying again copies nothing. `SwitchoverRun.clear()` bumps a generation, and a conversion running then keeps no memo. A test copy carries a prose digest (`SwitchoverTrial.prose`); one the author has written in gets a kept backup at Convert (SW-D4 amended); offering to reopen the original when the dialog closes in a copy is left to slice 3's dialog. `checkConverted`'s expected text is a walk of the original document (`textWithTagWords`, reading each token by `inlineTagWords`, the rule the rewrite uses) rather than the rewrite itself, and it checks every record's Pinned and Ideas page opens. A side effect: v1 background jobs that write while the dialog is open (the index queue) count as changes, so Convert then makes a second backup and dated copy.

---

## 2. Slice 2: the rebuild after the switch, main side

### 2.1 The waiting state

- The record's `rebuild` is `waiting` from the conversion until any *Rebuild memory* starts on this project: `readerService.rebuild()` calls `markRebuildStarted(db, now)` after `startRebuild` succeeds, whichever entry started it (the final screen, the notice, the Book tab). A rebuild that cannot start (no provider, the health gate, Use AI off) leaves it waiting.
- A project without the record (made v2 by the dev override, the e2e's v2 launches, the test book) behaves exactly as today.

### 2.2 The hold and the notice (`readerService.ts`, `checkBacklog`)

While the record is `waiting` and reading is allowed (Use AI on, the reading switch on, a provider):
- the backlog check queues **no unasked backlog read** and raises neither `draftUnread` nor `backlog`; it raises one notice instead (`MemoryNotice` gains it, `src/shared/memory/views.ts`):
  ```ts
  { id: 'switchoverRebuild', kind: 'switchoverRebuild', switchedAt: string,
    scenes: number, priceUsd: number, priced: boolean }   // priced like priceRebuild(db)
  ```
- reading a scene the author leaves or pauses in still runs (it is not the backlog; P2a's leave and idle triggers), so the scene she is writing is read as usual; **changed in the slice's review (2026-10-14):** only a scene saved from the editor since the project opened (`reader.editorSaved`), so a scene she only opens to look at, the likeliest thing right after the switch, waits for the rebuild instead of being read twice;
- `memory:answerNotice` `later` hides the notice until the project opens again (`reader.clear()` on a project change resets the flag), `dismiss` the same. There is no `read` action on it: its *Rebuild…* button opens the price dialog (`memory:rebuildEstimate`, then `memory:rebuild`), so the price the author confirms is computed when she confirms it (slice 4).
- With reading not allowed, `checkBacklog` returns early as today: no notice and nothing read. When Use AI or the reading switch turns on, or a provider is added, the existing re-check raises it. (Review: a key cleared, a provider chosen with or without a key, and every access change, a license bought or the trial ending, now call `reader.settingsChanged()` too, through `AppAccessService.subscribe` for the access.)

### 2.3 The caps (no new mechanism; tests that hold it)

- **Monthly Cloud background cap:** a rebuild's requests already spend as asked (`spender(db, true)` → `askedUsd`, P2a-D9) and `runRebuildScene` gates at `health`, never at the cap. The switch-over's rebuild is an ordinary *Rebuild memory*, so it is outside the cap; part A adds the tests and the wording, not code.
- **The daily cap still applies:** every request goes through `request.ts`'s daily cap; a request over it pauses the queue with `BUDGET` (`pauseOf` → `dailyCap`), the rebuild's progress row stays open, and the footer shows the reading paused, the queue's indicator the cap's message (as for any paused rebuild today). It resumes as a paused rebuild does now (the queue's resume when the author asks again, P2a; the pause belongs to the open project, so the next open carries the rebuild on, pausing again if today's cap is still reached); slice 2's tests pin the pause, the resume and the next open down rather than adding a mechanism.
- **The sweep** (P4's `sweepDue`) runs at the end with the Contradiction check on, priced in the estimate (SW-D10).

### 2.4 Channels

| Channel | Access, memory | What |
|---|---|---|
| `switchover:record` (new) | read, v2 | `SwitchoverRecord \| null`, for Settings › AI › Story memory and the final screen after a reopen |

### 2.5 Cost registry

No new `AiFeatureId`. `AI_COST_NOTES.reader`'s trigger text gains "and once after the switch-over, asked with its price (F-16.31)"; `npm run eval:ai -- -u` regenerates `docs/AI-COST-REGISTRY.md`; the commit quotes the registry diff (the token report does not change: no prompt changed).

### 2.6 Tests

`readerService.test.ts`, with a waiting record:
- the backlog check over 3 due scenes and over 12: one `switchoverRebuild` notice priced as `priceRebuild`, no `read` job queued, no `draftUnread`/`backlog` notice; without the record, today's behaviour (≤5 queued, more offered);
- a leave trigger on one scene queues that scene's read;
- `rebuild()` marks the record started (and the notice goes on the next check); a refused rebuild (no provider, health) leaves it waiting;
- `later` hides it until `clear()`; Use AI off: no notice; turned on: the notice;
- on Cloud, a rebuild's reported costs land in `askedUsd`, and with `backgroundUsd` already at the cap the rebuild's scenes still run;
- the daily cap: the request path's `BUDGET` pauses the queue mid-rebuild, the progress row stays open, `resume` finishes it.
`record.test.ts` (lenient parse, `markRebuildStarted` once). `views.test.ts`/contract: the notice parses. `handlers.test.ts`: `switchover:record` in v2, VALIDATION in v1.

**e2e:** none in this slice. Gates as above.

**Built (slice 2, 2026-10-14; calls in `QUESTIONS.md` "Switch-over slice 2"):** as above. The notice is stored by `checkBacklog` (priced once per look, never on every publish) and filtered out by `computeNotices` while reading is not allowed; `settingsChanged` runs `checkBacklog` at once when a record waits (the plan's "existing re-check" did not cover Use AI coming on: `publish` re-checks only when a hold lifts), so for a project without the record nothing changes. A book with nothing to read gets no notice (`scenes` is positive). Back-fills and background judging still run while the record waits (they touch only scenes already read). `noticeLine`/`noticeButtons` and `ThisScenePanel`'s *Rebuild…* (a `NoticeButton` kind `rebuild`, the dialog at `start`) were added here so the notice union compiles; slice 4 keeps its §4.2 wording and adds the tests. The record's own tests moved from `convertSwitchover.test.ts` to `record.test.ts`. **Review (2026-10-14; QUESTIONS "Switch-over slice 2 review"):** `settle` reads a scene while the record waits only when it was saved from the editor since the open (`editedHere`, fed by `documentsWritten` → `reader.editorSaved`); `ai:clearKey`, `ai:setOwnKeyProvider` and every access change (`AppAccessService.subscribe`) call `reader.settingsChanged()`; the notice says "Rebuild memory has not run since the switch-over: it reads N scenes"; tests for the health-gate refusal, a provider coming and going, and a daily-cap pause carried on at the next open; a handlers test drives the save, the key and the trial's end.

---

## 3. Slice 3: the entry points and the in-place flow in the renderer

### 3.1 Entry points (every build, a v1 project open)

- **Help:** `MENU`'s help section gains `{ id: 'switchStoryMemory', label: 'Switch to the new story memory…', when: 'project', memory: 'v1' }` after *Keyboard shortcuts*. `SWITCHOVER_MENU_ENTRIES`, `trySwitchover`, `menuFor`'s `switchover` option, `InstallMenuDeps.switchover`, `index.ts`'s `switchover: !app.isPackaged`, `switchover:available` (contract, handler, channel rows, preload) and the store's `available`/`loadAvailable` (and `App.tsx`'s call, `MenuBar.tsx`'s read) are removed. A v2 project or no project shows no item.
- **Settings › AI › Story memory (v1 form):** `AiSettingsTab`'s v1 branch gains a "Story memory" block (`features/switchover/SwitchoverSettings.tsx`, `data-testid="switchover-settings"`): "This project uses the old story memory: tags and the story bible. The new one reads your book and keeps your names, notes and labels." and a *Switch to the new story memory…* button (it closes Settings and starts the flow). The v2 form (the record) is slice 4's.
- Both call `useSwitchoverStore.getState().open()`.

### 3.2 The intro (phase `intro`, title "Switch to the new story memory")

What changes, in plain words (`switchoverText.ts` `WHAT_CHANGES`, one list):
- "Tags become names and labels. Every character, place and thing you tagged becomes a record with its nicknames; tone, content and your own tags become labels you filter by."
- "Inline tags in your scenes become plain words. You choose the words on the next screens."
- "Everything you wrote stays: scenes, notes, sheets (as Pinned lines), Plan and Idea sheets (in Ideas), uploads, story years and what you dismissed."
- "Sheet text the AI wrote goes under "Filed by AI earlier: please check", marked Not canon."
- "What the AI made goes: summaries, AI facts and tags, Changes, To do and consistency findings. The AI reads your book again (*Rebuild memory*), and asks with its price first."
- "Snapshots are not changed. A backup and a dated copy of the project are made first. It runs once; to go back, you restore the backup."

Then "**Try it on a copy first** (recommended): a test copy is made beside this project and switched; this project stays as it is." Buttons: *Try it on a copy first* (primary, focused), *Switch this project…*, *Cancel*. Opened on a trial copy, the intro says "This is a test copy" and offers only *Switch this copy…*.

### 3.3 The store (`switchoverStore.ts`)

Phases `idle → intro → (copying | safety) → plan → consent → converting → done`, plus a `failure: SwitchoverFailure | null` shown in the phase it happened in. `open()` → `intro`. `tryCopy()` → P1's `start()` (copy made and opened) → `plan`. `switchThis()` → `safety`: `flushPendingSaves()`, `switchover:safety` ("Making a backup and a dated copy in Google Drive…" for a Drive project, "…beside the project" otherwise); a failure stays on the intro with the failure block and *Try again*; success → `switchover:plan` → `plan` (the safety outcome kept for the final screen). `convert()` sends `{ consent, projectId }` after `flushPendingSaves()`; a failure goes back to `consent` with the failure block; success keeps the outcome, has `useProjectStore.open(folder)` reopen the same folder, then `done` (a failed reopen keeps P1's "switched, but it did not open again: … Open it from File › Open recent."). Every answer for a flow the author left is dropped (P1's generation counter). `close()` from `plan` or `consent` on the real project: "Nothing was changed. The backup and the dated copy made a moment ago stay where they are." as a toast with the two paths.

### 3.4 The dry run and consent on the real project

The P1 screens, with the wording of the real run: "This is your project. Nothing has changed yet; the backup and the dated copy are made." with the two paths under it; the rest as built (Converted, Kept as it is, Dropped (what the AI made), These may be one record with ticks, Filed by AI earlier: please check (Not canon), Notes, the rebuild line). The consent screen's last line becomes "Convert changes this project. Its backup is <file>."

### 3.5 The failure block (`SwitchoverFailure.tsx`)

`role="alert"`, `data-testid="switchover-failure"`: "What failed: <step label>" (Copying to Google Drive · The backup · The dated copy · The project · The conversion), the message, "Nothing was changed: this project still uses the old story memory.", "Next: <nextStep>", and *Try again* (re-runs the step that failed) beside *Cancel*.

### 3.6 The final screen (phase `done`, title "Switched over")

- `switchover-done`: "Your project now uses the new story memory: N records, N labels, N Research documents, N inline tags as words." (P1's counts).
- `switchover-backup`: "Backup: <file> (kept until you delete it)" with *Show backups* (`backups:reveal`).
- `switchover-dated-copy`: "Dated copy: <folder>" ("in Google Drive" when the project is).
- `switchover-go-back`: "To go back: in Settings › Backups choose *Restore* and pick "<file name>". It opens as a new project beside this one, on the old story memory. You can also open the dated copy with File › Open project…. This project stays on the new story memory."
- A test copy's screen instead: "This test copy now uses the new story memory. Your project at <path> is unchanged and still uses the old one." with *Open my project* (opens the original: the folder the flow started from, which the store keeps; the trial row's `source` says the same).
- Slice 4 adds the rebuild ask under these lines.

### 3.7 Tests and e2e

- `menu.test.ts` (shared and main): the item for v1 in every build, none for v2 or no project; no developer switch-over item. `SwitchoverDialog.test.tsx`: the intro's list and buttons; *Switch this project…* calls safety then plan; a safety failure shows the block and keeps the intro; the real-project dry-run wording with paths; a convert failure back on consent with the block; the final screen's four lines and *Show backups*; the test copy's final screen and *Open my project*. `switchoverStore.test.ts`: phases, `projectId` sent, dropped stale answers, the cancel toast. `AiSettingsTab.test.tsx`: the v1 block opens the flow.
- **e2e (`e2e/memory.spec.ts`)**: P1 slice 6's test goes through Help › *Switch to the new story memory…* › *Try it on a copy first* (the rest as it is). A new test, written here and finished in slice 4: **"story memory: the switch-over of a v1 project in place, as the installed app runs it (F-16.31 part A)"**, a launch without the override and its own app data:
  1. A new project "Real Novel" in `<tmp>/My Drive/` (wizard, Use AI off); the status bar says Google Drive.
  2. A character tag `mara` (Index), typed inline in the first scene: `#mar` Tab, then `'s eyes were grey. She walked to the quay.`; the stored content holds an `inlineTag`.
  3. Help lists *Switch to the new story memory…*; the flow starts from Settings › AI › Story memory's button instead.
  4. The intro shows the list and *Try it on a copy first*; *Switch this project…*.
  5. With the backup folder pointed under a file (through the stubbed folder dialog), the safety step fails: the block says "What failed: The backup", "Nothing was changed", "Next: Choose another backup folder in Settings › Backups"; `project:current` is v1 with its inline tag, no dated copy in `My Drive`. The folder is put back; *Try again*.
  6. The dry run says "This is your project", lists "Mara: Record (character): from its sheet and tag." and the rebuild line; *Next*; the consent row for `#mara` reads "Mara", kept; *Convert*.
  7. "Switched over": the backup line names a `… before story memory ….zip` that exists on disk; the dated copy line names `My Drive/Real Novel (before story memory YYYY-MM-DD HHmm).mythscribe`, which exists with a `project.db`; the go-back line names Settings › Backups › Restore. `project:current` has the same path and v2; the scene's stored text is "Mara's eyes were grey. She walked to the quay." with no `inlineTag`; `record:list` is `['Mara']`. Help no longer lists the item.

**Built (slice 3, 2026-10-14; calls in `QUESTIONS.md` "Switch-over slice 3"):** as above, with these shapes: the Help item carries `openProjectOnly` (absent, not disabled, with no project open; `menuFor` builds a third menu `none`); the intro learns whether the open project is a test copy from a new read channel `switchover:trial` (v1: the `switchoverTrial` marker or null), so a copy opened again gets only *Switch this copy…* and its final screen names `trial.source`; the store's phases are `idle | intro | copying | safety | plan | consent | converting | done`, `copying` also covering a test copy already open being read for its dry run, with `target` (`project` | `copy`), `source`, `cloud`, `safety`, `failure` (a `SwitchoverFailure`) apart from `error` (a thrown channel error), and `retry` running the failed step again; the failure block has no *Try again* for the `project` step (its next step is to start over) and shows the message less its "Nothing was changed…" ending, which it shows as its own line; *Show backups* goes through `useBackupStore.reveal`; the words live in `switchoverText.ts`. The e2e found that a tag mention scan landing after the safety step's save made Convert copy the project to Drive a second time (`… 2.mythscribe`): `run.ts` now keeps a `projectDigest` (every table but `index_job`, `mention_scan`, `tag_mention`, `ai_cache` and the `passage_fts*`/`memory_passage_fts*` tables) in the memo and reuses the copies when `total_changes()` moved only through those (`run.test.ts` covers both ways). The e2e's in-place test checks the paths through `switchover:record` (both exist on disk) and the text with typographic apostrophes folded.

---

## 4. Slice 4: the rebuild ask, the notice and the record in Settings (renderer)

### 4.1 The ask on the final screen (`switchover-rebuild`)

After the reopen the store reads `memory:status`, `aiSettings:get` and the provider status, then:
- **Reading allowed, a provider, a known price:** `memory:rebuildEstimate` → "Rebuild memory now: the AI reads N scenes once, about X¢ on your own key (about M minutes). Your text, Pinned, Ideas and Dismissed stay as they are." On Cloud: "about X¢ from your MythScribe Cloud balance. It is not counted toward your monthly reading cap; today's AI spending cap still applies, so a long book may finish tomorrow." On a local model: "free on your local model". Buttons *Rebuild now* and *Later*. *Rebuild now* → `memory:rebuild` (P2a's), closes the switch-over dialog and opens the rebuild dialog watching (`setRebuildOpen('summary')`, P2a's progress, *Stop*, then the grouped summary). A refused start shows its message and next step and keeps *Later*.
- **Use AI off, or the reading switch off:** no Rebuild button: "Use AI is off, so nothing is read and nothing is spent. When you turn it on in Settings › AI, This scene › Needs a look offers *Rebuild memory* with its price."
- **No provider:** "Story memory needs an AI provider: add a key or sign in to MythScribe Cloud in Settings › AI. Needs a look then offers *Rebuild memory* with its price."
- **Cloud without a price yet** (`estimate.priced` false on Cloud): "MythScribe Cloud has not sent its prices yet. Needs a look will offer *Rebuild memory* with its price." and *Later* only (SW-D9). An own key with a model missing from the price table keeps P2a's "a cost not yet known" and may start (the author's own key, P2a's rule).
- *Later* closes the dialog; the notice (slice 2) appears in Needs a look.

### 4.2 The notice row

`memoryView.ts`: `noticeLine` "Rebuild memory has not run since the switch-over: it reads N scenes, about X¢" (a cost not yet known says so; worded in slice 2's review as what the rebuild does, since a scene written in and left is read meanwhile); `noticeButtons` → `{ kind: 'rebuild', label: 'Rebuild…' }` (new `NoticeButton` kind: the panel opens the rebuild dialog at `start`, which prices and asks) and `answer('later', 'Later')`. Needs a look shows it among the Notices (P4's order).

### 4.3 Settings › AI › Story memory (v2 form)

`MemorySettings` gains the record's block when `switchover:record` answers one (`data-testid="switchover-record"`): "Switched to the new story memory on 14 October 2026. Backup: <file>. Dated copy: <folder>. To go back, restore the backup in Settings › Backups." and, while waiting, "*Rebuild memory* has not run since the switch." with *Rebuild memory…*. A test copy's record says "This is a test copy of <source>."

### 4.4 Tests and e2e

- `SwitchoverDialog.test.tsx` (the ask): the priced own-key line and *Rebuild now* calling `memory:rebuild` then opening the rebuild dialog; Cloud's cap and daily-cap wording; Cloud unpriced (no Rebuild button); local free; Use AI off; no provider; a refused start. `memoryView.test.ts` and `ThisScenePanel.test.tsx`: the notice line and buttons, *Rebuild…* opens the dialog at `start`, *Later* answers `later`. `MemorySettings.test.tsx`: the record block, waiting and started, a test copy.
- **e2e (the in-place test, continued):**
  8. The final screen's rebuild part says Use AI is off and offers no Rebuild button; *Close*. The fake provider has received no request since the launch.
  9. Settings › AI: Use AI on, an own key at the fake (as P1 slice 5's test); Settings › AI › Story memory shows "Switched to the new story memory on …" with the backup path; close Settings.
  10. This scene › Needs a look shows "Rebuild memory has not run since the switch-over: it reads 1 scene, about …"; the fake has still received no reader request.
  11. *Rebuild…* → the rebuild dialog's estimate line → *Rebuild* → progress → the grouped summary (`rebuild-summary`) lists Mara with the fake reader's "grey" line; the fake's requests opened with `reader.v2`'s and `verify.v2`'s sentinels. The notice is gone.

---

## 5. Slice 5: the switch-over replay, the live switch-over run, the final verification

### 5.1 The test book on v1 (`src/main/memory/testBook/projectV1.ts`, test data only)

`buildTestBookV1Project(dir, now)` builds the test book (`TEST_BOOK`, `TEST_BOOK_LABELS`) the way a v1 author would have it, through the v1 stores (as `fixtureV1.ts` does): a character, setting, item, faction or lore tag and sheet per labelled record with its aliases as tag aliases; an inline tag replacing the first mention of a record's main name in about a third of the scenes, only where the prose word equals the record's name exactly (so the default replacement gives the test book's prose back byte for byte); a split pair the twin gate offers to merge (the Captain as two tags, "Harrow" and "Captain Harrow"), to tick; `scene_meta` POV and location strings; a timeline event with a year over a run of scenes; one Plan sheet; one AI-made sheet and one AI-written field (`library` and `organise` changes); AI facts and summaries; a snapshot of one scene; the Idea scene and the cut scene as in the v2 builder.

### 5.2 The offline replay (`src/main/ai/eval/switchover.eval.ts`, the `eval` project, so `npm run test` runs it)

On `buildTestBookV1Project`: the dry run lists every labelled record by name as converted, the AI sheet's text under Filed by AI earlier, the AI facts and summaries as dropped, the merge pair offered; consent with the defaults and the merge ticked; `switchoverSafety` + `runConvert` against a temp "Drive" folder; then:
- every scene's prose equals the test book's paragraphs exactly; the snapshot is byte-identical; no inline tag is left;
- the records equal the labels' names and aliases (the merge applied), invariants clean;
- the dry run's rebuild price equals `rebuildEstimate` on the converted project (the sweep included);
- *Rebuild memory* through the reader service with the offline oracle reader (`memoryOracle.ts`) and oracle judge (`judgeOracle.ts`): the claims and findings match the same replay on `buildTestBookProject` (the v2-built book) for every labelled claim, so a switched book reads like a fresh v2 one; the author's Pinned, Ideas and Filed-by-AI pages are byte-identical before and after the rebuild; the record goes `started`; the notice is gone;
- adversarial: a `checkConverted` fault planted (a lost paragraph) leaves the project v1 with its database bytes unchanged.

### 5.3 The live switch-over run (owed by the author; cannot run in the build sessions)

`MYTHSCRIBE_EVAL_LIVE=1 OPENROUTER_API_KEY=sk-or-… npm run eval:ai -- switchover` (the `OPENAI_API_KEY` with `OPENAI_BASE_URL` form works too, through `liveProvider.ts`): the same conversion, then the rebuild with the live reader, checker and sweep judge on the default models (V4 Flash fast, V4 Pro for the 20 strong spot checks). It stops at 50¢ (about 3–5¢ expected for the test book's 17 scenes, h10 in an inactive draft and the Idea and cut scenes never read) and writes `test-results/eval-switchover/` (Markdown and JSON). Bars:
- the actual cost (the ledger's reported costs) is between 0.5× and 1.5× the dry run's price, and the time is reported against its minutes (the price the author is asked is honest);
- the memory bars of the live planted-error run (`-- memory`: support precision and the rest, the same thresholds) hold on the converted book;
- the author's pages are byte-identical before and after; no request carried a Not canon or Filed-by-AI paragraph as canon (the data the reader sends is P2a's).
Offline tests drive `runLiveSwitchover` against `fakeChatServer` (a scripted reader): the report, the 50¢ stop, a provider error stopping cleanly, an unpriced model reported as such (P2b slice 3's pattern).

### 5.4 Final verification and docs (F-16.31 stays unticked)

The full gates on the reviewed code (typecheck, lint per folder, `npm run test`, the eval harness, `npm run test:e2e`: `memory.spec.ts`'s two switch-over tests beside the unedited v1 smoke). Then:
- `FEATURES.md` F-16.31: a dated note "Part A built 2026-10-xx (plan `plans/Switchover.md`): …" listing what part A does, what the author still owes, and that part B waits for her switch; the box stays unticked. The M8 row in §6 notes part A. F-16.15's text points to F-16.31 for the in-place run and to every build for the copy.
- `docs/ARCHITECTURE.md`: the "Switch-over" bullet rewritten (the entry points, `run.ts`, the record, the kept backup, the hold and the notice, `checkConverted`); the Backups bullet (kept backups).
- `CLAUDE.md` 1b/1c: part A done; owed by the author: the trial on a copy in the installed app, then the real switch after the live runs (with `-- switchover` added to 1c's list); then part B.
- `docs/OPERATOR-SETUP.md`: nothing (no Worker change). `QUESTIONS.md`: "Switch-over part A built before your run in the installed app".

---

## 6. Prompts, budgets and costs (own key, list prices: V4 Flash $0.14 in / $0.28 out, V4 Pro $1.74 / $3.48 per million tokens; Cloud × 1.25)

**Prompts:** none new. The rebuild sends, per scene, `reader.v2` first-read pages (fast, input cap 6,000 with ≤ 2,500 prose tokens a page, out cap 720, reasoning off), one `verify.v2` batch per page (fast, input cap 3,000, out ≤ 400; the 50 fast spot checks at about 15 out and the 20 strong ones at 40 out), and the sweep's `judge.v1` batches (fast, ≤ 10 pairs a call, both orders, input cap 3,000, out min(300, 20 + 26 a pair)). Their data-sharing rows, `NO_REASONING_FEATURES` entries and cost rows are P2a–P4's. The switch-over itself sends nothing.

| What | Cost |
|---|---|
| Dry run, consent, conversion, backup, dated copy | 0¢ (local; the copy's time is Google Drive's) |
| *Rebuild memory* after the switch, a 90-scene novel of about 120k prose tokens (≈ 100 pages) | reading and checking ≈ 567k in, 70k out on Flash ≈ 10¢; spot checks ≈ 0.2¢ fast + ≈ 2.7¢ strong; the sweep ≤ 12 judge calls ≈ 0.4¢: **about 13–14¢ on an own key, about 17¢ on Cloud**, about 12 minutes (8 s a scene). The dry run computes the real number from the book's own scenes. |
| The live switch-over run (author) | stops at 50¢; about 3–5¢ expected |

On Cloud this spend is asked (P2a-D9): it never counts toward the monthly background cap, and it does count toward the daily cap.

---

## 7. Part B (later; not built in this phase)

**Gate.** Part B starts only after all of these: the live runs of CLAUDE.md 1c have run with the author's key and what they found is fixed (`ai:probe`, `-- memory`, `-- knows`, `-- scribe`, `-- findings`, `-- prompts`, and part A's `-- switchover`); the author has tried the switch-over on a copy in the installed app, then switched her real project and said in `QUESTIONS.md` (or CLAUDE.md) that it works and part B may start. Until then installed builds keep both systems.

**Scope** (F-16.31's "Then:", design Part 3's removals table):
1. **New projects on v2** (`DEFAULT_STORY_MEMORY = 'v2'`; imports and the v0 conversion already write records and labels in v2).
2. **The switch-over on open:** opening a v1 project offers only the switch-over (or a copy first, or opening it read-only to export), with the same safety, dry run, consent and rebuild ask; the Help and Settings entries go.
3. **Delete the v1 code** (about −25k lines): tags (bank, Manager, templates, range tags, inline-tag UI, filters, Index, AI tags, Recommend, proposed and title tags), sheets' two views and sync, Story bible settings, Canon/Plan/Idea on items, `summary.v1–v5`, `observed_fact` and AI facts, the 5 conversions on open, `continuity.v2` and the Continuity view, Changes, To do (`todo.v1`, `todoSuggest.v1`), Organise, `planLinks.v1`, `route.v2`, `agent.v8`, `query.v4`, `contextImport.v2`, `reviewChat.v2`, `importStructure.v1`, the Library list and `apply.ts`, `legacyImport`'s tag writes, the v1 sections and menu items, `CHANNEL_MEMORY`'s `v1` rows and the v1 branches of every `memory` switch. The inert `inlineTag` node and range marks stay so stored documents load.
4. **Retire the feature ids** `tags`, `summary`, `continuity`, `organise`, `todo`, `sheetSync`, `query`, `route` (F-16.2's lenient parse keeps stored settings safe), with their cost notes, data-sharing rows, eval cases and token-report rows; `npm run eval:ai -- -u` and the registry regenerated.
5. **The e2e:** the v1 smoke is rewritten on v2 (the part that tests tags and the story bible goes; create → write → reopen stays).
6. **Docs:** every feature marked "replaced by F-16" closed in `FEATURES.md`; `docs/ARCHITECTURE.md` rewritten for one system; CLAUDE.md. The old tables stay until F-16.38 (P9).

**Its own gate:** full gates with the rewritten smoke, then the author's check of the installed app; only then is F-16.31 ticked. Part B is planned in its own plan file when its gate opens (about four slices: new projects and the switch on open; main code and ids; renderer code and menus; the smoke, docs and the tick).

---

## 8. Decisions this plan makes (decided by Claude, unconfirmed; logged in `QUESTIONS.md`)

- **SW-D1. One entry point in every build.** Help › *Switch to the new story memory…* and a block in Settings › AI › Story memory, while a v1 project is open; the developer-only item and the build gate go. An intro says what changes and recommends *Try it on a copy first*. Nothing is offered or forced on open; new projects stay v1.
- **SW-D2. The design's order on the real project.** The safety step (Drive flushed, backup, dated copy) runs before the dry run, as design Part 3 lists it, so the author reads the dry run with both copies already made and a failed backup stops before anything else. If anything changes in the project before Convert, it is flushed and backed up again at Convert, so the backup is always the project exactly as it was before the conversion. (P1's copy flow ran it at Convert; that order stays for nothing now, see SW-D4.)
- **SW-D3. The backup is a kept full zip.** *(Review of slice 1, 2026-10-14: the dated copy is made again at Convert, with the backup, when anything was written after the safety step; the earlier pair stays where it is.)* `<Name> before story memory YYYY-MM-DD HHmmss.zip` in the project's backups folder, never deleted by retention and not counted in "keep N", listed in Settings › Backups as kept and restorable there as a whole project (uploads included). Not F-8.7's database-only file, which cannot be restored through Settings. The dated copy is made once, before the dry run.
- **SW-D4. A test copy gets no backup or dated copy of its own.** *(Review of slice 1, 2026-10-14: unless the author has written in the copy since it was made, its prose digest in the `switchoverTrial` row no longer matching; then a kept backup of the copy, still no dated copy.)* The original is never written (its bytes are tested unchanged), so it is the copy's safety; this avoids a "(story memory test …) (before story memory …)" folder in Drive for every trial. (P1 built a backup and a dated copy of the copy at Convert.)
- **SW-D5. Convert names its project.** `switchover:convert` carries the open project's id and is refused for another, so a dialog left open across a project switch can never convert the wrong book.
- **SW-D6. The conversion checks itself before it commits:** no inline tag left, snapshots byte-identical, every scene's text the same once the chosen words are put back, the name invariants clean, every document parses. Any problem undoes the whole transaction and says what it found.
- **SW-D7. The switch-over record** (a project settings row: when, the backup, the dated copy, a test copy or not, the rebuild waiting or started), written in the conversion's transaction; Settings › AI › Story memory shows it for good, so the backup's place and how to go back are never lost with the dialog.
- **SW-D8. The rebuild asks once, then waits in one notice.** The final screen asks with the price (*Rebuild now* / *Later*). Until a rebuild starts, the book's unread scenes are not read in the background and Needs a look shows one notice, "Rebuild memory has not run since the switch-over" (worded so in slice 2's review; first "Your book has not been read since the switch-over"), with *Rebuild…* (priced again when pressed) and *Later* (until the project opens again). The scene the author is writing (saved from the editor since the project opened) is still read when she leaves it or pauses. Any *Rebuild memory* ends the waiting.
- **SW-D9. Use AI off, no provider, or Cloud without prices:** no Rebuild button on the final screen; it says why and that Needs a look will offer it with its price. On Cloud the ask names the balance, says it is outside the monthly reading cap and that today's cap still applies.
- **SW-D10. The dry run's price is the rebuild's price,** contradiction sweep included when the Contradiction check is on, computed by the same function; the offline replay holds them equal.
- **SW-D11. How to go back:** restore the kept backup (Settings › Backups › Restore: a new project beside this one, on the old memory) or open the dated copy. Nothing reverses the switch in place; the converted project stays.
- **SW-D12. No restart.** Main closes the project after the conversion (Google Drive gets the converted database on close) and the renderer opens the same folder again, as the copy flow already does.
- **SW-D13. The live switch-over run** (`-- switchover`) is part A's live test: the test book built on v1, switched, rebuilt live; bars: the actual cost within 0.5–1.5× of the price asked, the memory bars of `-- memory` on the converted book, the author's pages untouched; it stops at 50¢.
- **SW-D14. Part B waits** for the gate in §7 and gets its own plan.

---

## 9. Gates, docs, risks, and what part A does not do

**Per slice:** typecheck; lint per folder; `npm run test` (targeted while building, the full run at most twice); `npm run test:e2e` in slices 3, 4 and 5; `npm run eval:ai` (and `-u` only in slice 2 for the registry text); the "Switch-over" ARCHITECTURE bullet; `QUESTIONS.md` "Switch-over slice n"; a dated note in F-16.31 (unticked). Commit messages `F-16.31: …`.

**Owed by the author after part A** (recorded in slice 5): in the installed app, the trial on a copy of the real Drive project (Help › *Switch to the new story memory…* › *Try it on a copy first*), its rebuild and grouped summary; after the live runs of CLAUDE.md 1c (with `-- switchover`), the real switch; then the go-ahead for part B.

**Risks and how they are contained:**
- *Google Drive offline mid-run:* the flush is the first step and failing it changes nothing; after the conversion, a failed copy-back on close leaves the working copy ahead and carried (F-8.1), so the next open on this computer is v2 and Drive gets it on the next copy-back. Another computer opening the Drive copy before then sees v1; the status bar shows the copy-back's state as it does for any Drive project (F-8.1), and the final screen says nothing about Drive beyond where the dated copy is.
- *A large book:* the conversion is one synchronous transaction on main, and `checkConverted` adds one string pass over the book. Slice 1 adds a timing test on a 200-scene generated v1 project (under 5 s) so the window never hangs long; if it fails the bar, the check's `before` texts move out of the transaction's critical path (read just before it, compared inside).
- *Restored and dated copies share the project id* (as any F-8.4 restore does), so their backups land in one folder; the kept backup's name keeps it apart, and part A changes nothing there.
- *The license:* after the trial without a license, writes are refused (F-15.13), so the switch-over is too; the failure block shows the license message.

**Not in part A:** everything in §7; any prompt change; any migration; deleting or editing v1 tag, entity, knowledge, Organise or To do code; switching a project without the author pressing Convert.
