# P2b Who knows what, threads and time: implementation plan

**Features:** F-16.22 and F-16.23 (`FEATURES.md` §2.16). Phase P2b of the story memory redesign, approved by the author on 2026-10-11 (`../design.md` §2.1–2.3, §2.5, §2.6 (the prose block and data sharing), §2.7 (Book view, sheets, "Years and ages"), Part 4, Part 5; `../author-answers.md` answers 1, 8, 12, 19, 20, 21, 22; decision 5). **Size:** M, about 1.5 weeks, in five slices. **Status:** planned 2026-10-12; slices 1 and 2 built 2026-10-12.

**Goal:** the reader learns who knows what and where the plot threads stand, and code turns that into time. `reader.v2` adds knows claims (who learned which secret, how, and from whom; the learner must be Here or the POV) and thread claims (opens, advances, resolves). A secret or thread is created silently whenever a proved claim backs one, with a defining quote; a likely duplicate is judged in the same `verify.v2` batch ("same as s3?") on both defining quotes and merged on its own, with *Split* to undo it. Code computes "readers have known since", the who-knows-what grid, thread status, the story year of each scene (decision 5) and ages. Absence is only ever shown as a scoped, muted line ("No scene shows Mara learning this (checked up to 14.2)") and never reaches a prompt. The This scene panel shows the secrets touched in the scene and tension lines; the Book tab gains the grid, Threads and the Timeline with ages; sheets gain Knows, Threads and Age.

**Rules that hold in every slice** (P1's and P2a's, carried over):
1. **Everything is behind `storyMemory === 'v2'`.** A v1 project sends, stores and shows exactly what it does today. New channels are `v2` in `CHANNEL_MEMORY`; the smoke e2e (`e2e/smoke.spec.ts`, v1) is not edited.
2. **Migrations are additive** (0036+): new tables, new nullable or defaulted columns. `migrate.test.ts` checks that every older table keeps its rows and columns.
3. **Each prompt version** is a new file with a golden test, eval cases, a token-report row, its `aiCostNotes.ts` row and its data-sharing text, with one `npm run eval:ai -- -u` in the slice that changes prompts; the commit quotes the token-report diff. `reader` and `verify` are already in `NO_REASONING_FEATURES` and `LOWEST_EFFORT_FEATURES`, so the new versions inherit reasoning off on every route (a test asserts it for `reader.v2` and `verify.v2` on Cloud and OpenRouter).
4. **No live run can happen in the build sessions** (no API key). The knows run is built so the author can run it (§3); CLAUDE.md 1c already places every live run after the whole build. Each slice says so; the final slice records the owed runs in `FEATURES.md` and `CLAUDE.md`.
5. Tag, entity, knowledge, Organise and To do code is frozen for edit lists; P2b touches none of it. The v1 Threads and Timeline sections (`ThreadsTab`, `TimelineTab`, `src/shared/threads.ts`) stay as they are; P2b reuses only `ageAt`/`parseYear` from `src/shared/timeline.ts` (move them into `src/shared/memory/years.ts` at the switch-over, F-16.31, when v1 code goes).
6. Lint per folder (`npx eslint --max-warnings 0` on `src/shared`, `src/preload`, `src/main`, `src/renderer`, `cloud`, `e2e`, `scripts`); the full `npm run lint` runs out of memory. The full gate suite runs at most twice per slice. Node-heavy commands under `flock /tmp/mythscribe-heavy.lock`.
7. Each slice adds or updates its `docs/ARCHITECTURE.md` bullet, logs its open calls in `QUESTIONS.md`, and notes its progress in the F-16.22/F-16.23 text. Both features are ticked after slice 5's final verification, as P2a's were (P2a-D18).
8. `src/main/ipc/handlers.ts` only registers channels; the logic lives in `src/main/memory/reading/` modules (P2a rule 8).
9. **Absence is never a fact, by construction:** main-side views carry only what was proved plus a `checkedUpTo` scene reference; the words "No scene shows … (checked up to …)" are composed in the renderer only. Nothing in a prompt builder, the Story notes block or a chat tool output reads `checkedUpTo` (a test per surface, slice 4).

**Build order:** slice 1 (data and pure rules, no AI) → 2 (`reader.v2`, `verify.v2` and the pipeline) → 3 (the offline replays, the live knows run, one key for every live path) → 4 (who knows what: views, channels, panel, grid, sheets) → 5 (threads, timeline and ages: views, channels, Book and sheets; final verification and ticks). Each slice builds, gates and commits on its own.

**Coordination with P3** (built in parallel in the design, one agent at a time here): P2b changes no chat prompt and no agent tool (`agent.v8` stays as it is, P2b-D16). P3's navigator `knows` and `timeline` tools and its "does A know X" / "who knows X" instant cards call P2b's pure functions (`knowsAsOf`, `threadsAsOf`, `storyYears`, `ageAsOf`, slice 1) and must keep rule 9: positive lines only, the scoped absence line as UI text, never as evidence.

---

## 0. The shape of it

```
leave / idle / Read now / backlog ─► gate ─► window or pages (P2a, unchanged)
   └─► reader.v2 (fast, JSON, reasoning off): rules → record roster → topics roster (s3 · secret, t2 · thread)
         answer: c[] facts, knows facts (o: secret, how, fr), thread steps (r: thread, how, v), n[] names and new topics (kind, id x1, defining q)
   └─► ladder: presence · subject · learner Here or POV (code; else one on-page check) · Dismissed topic keys · topic caps
         └─► verify.v2 (one batch per page): facts, knows (learner, how, from), steps, Reveals (defining quote), Same (≤3 candidates)
               └─► topics: create silently (record + topic_quote) or merge (topic_quote 'merged', claims tagged) ─► reconcile ─► prune
code, on read: knowsAsOf (grid, readers-since, checked-up-to, tension) · threadsAsOf · storyYears · ageAsOf
```

---

## 1. Slice 1: the data layer and the pure rules (no AI; F-16.22 and F-16.23 data)

### 1.1 Migration `0036_story_knows` (generated: `npm run db:generate -- --name story_knows`)

| Change | Columns |
|---|---|
| `topic_quote` (derived) | `id`; `record_id` (FK record cascade: the secret or thread); `draft_id` (FK draft cascade); `node_id` (FK node cascade); `role` (`defining`, `merged`); `label` (the reader's label, ≤ 8 words); `para`; `quote`; `anchor` (JSON hashes, `anchorFor` as claims); `stating` (JSON gate texts of the quote's sentences: the Dismissed key's input); `reading_id` (FK reading set null); `state` (`live`, `stale`); `created`; `proved`. Indexes (`record_id`), (`node_id`, `draft_id`). A secret's or thread's reveal and every reveal merged into it (P2b-D3, D4). |
| `knew_before` (author-owned) | `secret_id` (FK record cascade) + `record_id` (FK record cascade), PK on the pair; `created`. *Knew before the book* (design §2.5). |
| `claim.topic_quote_id` | New nullable column, FK `topic_quote` set null: the merged reveal a knows or thread claim came in with, so *Split* moves exactly those (P2b-D5). If drizzle-kit wants to rebuild `claim` to add the foreign key, the statement is written by hand (`ALTER TABLE claim ADD topic_quote_id text REFERENCES topic_quote(id) ON DELETE SET NULL`), as 0031 was hand-written; never a table rebuild. |
| `scene_read.topics_read`, `scene_read.settled` | Two integer columns, not null, default 0. `topics_read`: a reader that reads knows and threads (`reader.v2`+) has read the whole scene (set by a v2 first, full or rebuild read; kept by v2 window reads). `settled`: nothing finished is unread (set by the gate when it decides `nothing` or `cosmetic`, and after a v2 reading that leaves nothing unread; cleared by the anchors job when a save leaves an unread finished sentence). Together they give "checked up to" without walking the book's text (P2b-D9). |

`migrate.test.ts`: a database at 0035 with a row in every table migrates to 0036; every older table keeps its rows; `claim` and `scene_read` keep their old columns and values and gain the new ones (null / 0); the new tables are empty.

### 1.2 Shared vocabulary and pure rules (`src/shared/memory/`)

| File | What it holds |
|---|---|
| `knows.ts` (new) | `KNOWS_HOWS` = `saw`, `told`, `overheard`, `read`, `deduced`, `suspects`, `believesFalse`, `knewBefore`, `tells`, `refers` (the test book's spelling); groups `LEARNS` (saw, told, overheard, read, deduced), `HOLDS` (knewBefore, tells, refers), `PARTIAL` (suspects, believesFalse); `FROM_HOWS` (told, overheard, read: only these keep a `from`, P2b-D6); `HOW_LABEL` ("overheard", "believes otherwise", "knew before"). `knowsCounts(claim)` (P2b-D7): mode `now` or `memory`; voice narration or thought, or dialogue whose speaker is the knower (tells, refers) or the `from` (told, overheard, read: the learner heard it); never rumour, hypothetical or dream; `PARTIAL` hows show as such and never count as knowing. `learnerHere(recordId, here, kind)`: a character must be in the Here set; a group is exempt (P2b-D8). |
| `topics.ts` (new) | `TOPIC_KINDS` (`secret`, `thread`); `SECRET_CATEGORY_ID = 'secret'` (v2 only; `recordKindOf('secret')` → `secret`, P2b-D1); `isTopicKind(kind)`; `NAMED_KINDS` (character, place, thing, group, term: what the name scan, the twin gate, name questions, the spellcheck and Rename in book read, P2b-D2); `THREAD_STEPS` (`opens`, `advances`, `resolves`) and `stepRank` (an advance before a resolve in one scene, the v1 rank rule); `TOPIC_LABEL_MAX_WORDS = 8`; `TOPIC_CAPS = { secret: 3, thread: 2 }` per page (P2b-D11); `topicTerms(label, quote, names)` (`queryTerms` over the label and the defining quote, each roster name folded to its record id); `sameAsCandidates(fresh, open, { max: 3 })` (P2b-D4: the open topics of the same kind sharing at least one content term or, for secrets, a holder; threads also a named record; highest overlap first); `topicLabel(text)` (trimmed, cut to 8 words, a leading "the" kept). |
| `whoKnows.ts` (new) | Pure, over claims, topic quotes, `knew_before` rows, the reading order and `scene_read` flags. `readersSince(topic)`: the scene of the earliest live reveal (`topic_quote`) or counted `LEARNS`/`HOLDS` claim (P2b-D7); null when none. `checkedUpTo(order, flags, atId)`: the last scene of the longest run of readable scenes, from the book's start in reading order up to `atId`, with `topics_read` and `settled` both set; null when the first one is not ("not checked yet") (P2b-D9). `knowsAsOf({ claims, topics, knewBefore, order, atId })` → per secret: label, readers-since, cells per knower (the strongest counted line as of the scene: `HOLDS`/`LEARNS` over `PARTIAL`; the author's `knewBefore`; the first later line as `later`), others (dialogue, rumour, memory) apart, never a "doesn't know" cell; secrets readers learn after `atId` counted as `later`. `sceneSecrets(knows, sceneId, here, pov)`: the secrets touched in the scene (a counted claim or a reveal there) and up to 3 tension lines (readers know and the POV has no counted line, then someone Here holds it and another Here has none; P2b-D21); `more` = the grid's other rows. Every "has none" is a reference to `checkedUpTo`, never a sentence. |
| `threadsAsOf.ts` (new) | `threadsAsOf({ claims, threads, order, atId })` → per thread: status (`notYet` before its first step, `open` after opens or advances, `resolved` after a resolve, P2b-D22), opened ref, last step ref, steps (claim id, how, value, ref, stale; mode `now` and not rumour, the rest listed muted), `later` count; an author's thread with no step reads `notYet` with `checkedUpTo`. |
| `years.ts` (new) | Decision 5, pure. `elapsedBreaks(hint)` (P2b-D14): a hint that can cross a year (years, winters, summers, springs, autumns, seasons, decades, generations, six months or more in words or digits, or a long vague span: "years later", "long after", "much later"); hours, days, weeks, "the next morning", "that evening" do not, and are neither hints for ages nor listed. `yearIn(text)`: one 3–4 digit year in a value, else null. `storyYears(rows)` over readable scenes in reading order (typed `story_year`, the held card's verified `year` and `flashback`, the held card's `elapsed`): a typed year sets the carry and is the scene's year (`typed`); a verified flashback takes neither the carry nor breaks it, and its own typed or quoted year applies to it alone; otherwise a breaking hint ends the carry; a quoted (verified) year applies to its own scene only (`quoted`); else the carry (`carried`, from its scene); else `unknown` with the hint that ended the carry. `birthYear(claims, pinned, atId)` (P2b-D15): a live narration-now `born` claim as of the scene with one year in its value, else a Pinned canon "Born: 1792" line. `ageAsOf({ born, year, stated, hints })`: with a birth year and the scene's year, `{ kind: 'computed', age, yearSource }` (age = year − born through `ageAt`; "about 19, year from 1.1"); else the last stated age (lasting slot `age`, narration now) with the breaking hints in later scenes up to the scene, listed and never added up ("19, stated in 2.1 · since then: 'Three winters later' (14.1)"); else null. Negative → "not born yet". |
| `views.ts` (extended) | `KnowsCellView` (knower, how, fromId, ref, nodeId, claimId or null, stale, `source`: `claim` / `author`, `later`); `SecretView` (recordId, label, origin, readersSince, defining quote ref, cells, others); `KnowsGrid` (asOf, asOfRef, `checkedUpTo`, columns, rows, `later`); `SceneSecrets` (touched, tension, more, `checkedUpTo`); `TopicView` (kind, origin, readersSince or status, defining `{ quote, ref, nodeId, para, stale }`, merged facets `{ topicQuoteId, label, quote, ref }`, knewBefore ids); `ThreadMemoryView`, `ThreadsMemory`; `TimelineRow` (nodeId, ref, title, year `{ value, source, from }` or `{ unknown, hint }`, flashback, elapsed hint, typed time, ages), `TimelineMemory`; `AgeView`. `SceneMemory` gains `secrets: SceneSecrets`; `SheetMemory` gains `knows`, `threads`, `age`, `topic` (null for a non-topic record). |
| `claims.ts`, `slots.ts`, `dismissed.ts`, `records.ts` (extended) | `Claim.topicQuoteId`; `readerAccepts` goes (`reader.v2` proposes every slot) in slice 2; `dismissedKey` gains `{ kind: 'notRight', topic: { kind, stating } }` → `topic|<kind>|statingKey` (an AI-made topic the author said is not one, P2b-D13), and a knows line's `notRight` key uses slot `knows:<secretId>` with the how as value (P2b-D6); `recordKindOf('secret')`. |
| `invariants.ts` (extended) | New kinds: `knowsObject` (a knows claim whose object is not a secret record), `knowsLearner` (a learner that is not a character or group), `topicEmpty` (an AI-made topic with no topic quote and no claim in any draft), `topicName` (a topic record in the name index). Clean after every operation in the tests. |

### 1.3 Main stores (`src/main/memory/reading/`)

| File | What it does |
|---|---|
| `topicStore.ts` (new) | `insertTopicQuote`, `listTopicQuotes(db, draftId)`, `createTopic(db, { kind, label, origin: 'ai', quote… })` (record in category `secret` or `thread` with its label as main alias; a label whose norm another record holds gets " (secret)" / " (thread)", then the scene ref, P2b-D1), `mergeInto(db, targetId, quote, claimIds)` (a `merged` topic quote; the claims re-pointed and tagged with its id), `splitTopic(db, topicQuoteId, now)` (P2b-D5), `pruneTopics(db)` (P2b-D12), `deleteTopicEvidence(db, recordId)`. |
| `knewBeforeStore.ts` (new) | `setKnewBefore(db, secretId, recordId, knew)`, `knewBefore(db)`. Author-owned: `memory:knewBefore` is a `write` channel (slice 4). |
| `sceneReadStore.ts` | Writes `topics_read` and `settled` (§1.1). |
| `anchors.ts` | Topic quotes get the claims' treatment: `holds`, `moved`, `stale`, `restored` (no free re-proof: a reveal is never literal); clears `settled` when the save leaves an unread finished sentence; runs `pruneTopics` when a scene's evidence went; pushes `memory:changed` with the topic's id. |
| `rosterCache.ts` | The `memoryRoster` row gains a `topics` part (ids `s3`/`t2`, base, additions, held labels), built after the record lines so a topic change never moves the cached record prefix (P2b-D10). Slice 2 renders it. |

### 1.4 Hooks into P1 and P2a code (each v2 only)

| Where | Change |
|---|---|
| Name scan, twin gate, name questions, spellcheck, Rename in book (`nameIndexer.nameScanShared`, `recordStore.rosterOf`, `questions.ts`, the v2 spellcheck names, `renameStore`) | Read `NAMED_KINDS` only: secret and thread records are not names (P2b-D2). Renaming one renames its label (the record's main alias) and rebuilds the topics roster; *Rename in book* is not offered on their sheets. P1's thread records stop producing mentions in v2. |
| `recordStore.createRecord` | No twin gate for the `secret` and `thread` categories: an exact-label duplicate warning instead (P2b-D19). |
| `recordStore.deleteRecord` | Deleting a secret also deletes the knows claims whose object it was (`object_id` is set-null, so they would be orphans) and its `knew_before` rows (cascade); a deleted learner's knows claims cascade as P2a's do. |
| `recordStore.sameAs` (and the P2a re-pointing) | Also re-points `claim.from_id`, `knew_before` (both columns, duplicates dropped) and `topic_quote.record_id`; rewrites `notRight` keys `knows:<old>` to the kept id. *Same as…* between two secrets or two threads is the author's merge (no topic quote is tagged). P1's *Split* (nicknames) is hidden on topic sheets; topics split by reveal (slice 4). |
| `renameEvidence.ts` | Rename in book rewrites names inside `topic_quote.quote` and recomputes its anchor, like claim quotes; its undo restores them. |
| `reconcile.ts` | `identity` gains `how` (two knows lines of one sentence with different hows are two lines); `FreshClaim` gains `topicQuoteId`. A rebuild's `replace` also deletes the scene's topic quotes the reading did not state again. |
| `asOf.ts` | Unchanged: knows and thread claims never set state and never appear in True now, From the book or the Story notes block (a test asserts the last). |

### 1.5 The test book, extended (`src/main/memory/testBook/`, test data only)

- **Two new hard-case scenes** (about 500 words, written for the book, no original names): `h13` "The regiment hears" (chapter 17, POV Lise, **no typed year**: carries 1814 from `h09`): a group learner ("By Sunday the whole regiment knew of the engagement"), a character who refers to the secret in dialogue, the Ashby-return thread mentioned in memory only; `h14` "The Captain's debts" (chapter 18, no typed year, opening "A year later,": breaks the carry): a second secret (the Captain owes Mr. Varrow money) with `deduced` (Lise), `suspects` (Johanna), `believesFalse` (Mrs. Harrow thinks him a man of fortune), Mr. Harrow present and never learning it, a rumour about it that must not count, and Lottie's stated age again.
- **Labels** (schema additions, all optional for older data): a `regiment` group record; `secret-debts` with its defining quote; thread records `thread-ashby-return` (its `h07` ¶6 mention is hypothetical, so it opens at `h08` ¶6 "he said that he was coming back to Thornmere" and resolves at `h09` ¶4) and `thread-lottie-match` (opens `h04` ¶2 with the engagement, advances `h08`, resolves `h09` ¶3); a new `threads` array (thread, how, scene, p, quote); knows additions (`h13` group learner, `refers`; `h14` deduced, suspects, believesFalse); `LabelNegative.kind` gains `knows` (a rumour, a dream, a hypothetical, and Mr. Harrow in `h14`: no counted knows claim may come from them); `years` (per readable scene: the expected year and source, `h13` carried, `h14` unknown with its hint) and `ages` (record, scene, expected `AgeView`: as of `h14`, Johanna's "22, stated in" `h08`'s ref with both later hints, "Three winters later" and "A year later", listed and not added; Lottie's stated ages).
- `testBook.test.ts` checks the new labels with the same helpers (quotes located once, no original names, threads and years labels consistent with `storyYears` on the book's typed details and labelled card fields).
- P2a's oracle replay and planted-error run read the two new scenes too, so they get claim labels like the others (Lottie's stated age, the Captain's role, Mrs. Harrow's mistaken belief as a negative state); the `reader.v1` and `verify.v1` token rows do not move (their cases name their scenes).

### 1.6 Tests

- `knows.test.ts`: `knowsCounts` for every voice, mode and how (dialogue from the `from` counts for told; rumour, dream and hypothetical never; suspects never counts as knowing); `learnerHere`.
- `topics.test.ts`: labels cut to 8 words; `sameAsCandidates` (shared word, shared holder, different kind never, at most 3, names folded so a renamed character still matches); caps.
- `whoKnows.test.ts`: readers-since from the earliest reveal or counted line, a suspects line not counting; `checkedUpTo` (all checked, a gap in the middle, the first unchecked, an Idea scene skipped, a scene read only by `reader.v1` unchecked); grid cells as of a scene, later lines counted, the author's knew-before, group columns; tension lines (POV first, at most 3), `more`; no cell or line ever says "doesn't know".
- `threadsAsOf.test.ts`: not yet, open, resolved, resolve and advance in one scene, a rumoured step muted, an author's thread with no step.
- `years.test.ts`: decision 5 end to end: typed carry, a flashback skipped in both directions, a flashback's own year, a breaking hint ("three winters later", "a year later", "six months", "years later") against a non-breaking one ("the next morning", "a week later"), a quoted year for its own scene only, the next typed year restarting the carry; `ageAsOf` computed ("about 19, year from 1.1"), stated with hints listed and never added, birth year from Pinned when the book states none, not born yet. The test book's `years` and `ages` labels pass.
- Store tests: create, merge, split, prune (and nothing pruned while the author touched it); deleting a secret leaves no orphan knows claim; `sameAs` of two secrets and of two characters re-points knows, `from`, knew-before and topic quotes; Rename in book rewrites a topic quote and its undo restores it; the anchors job stales, moves and restores topic quotes and clears `settled`; `checkMemoryInvariants` clean after each.
- `nameIndexer` / `recordStore` / `questions` tests: a secret labelled "the sold map" and a thread "Ashby's Return" produce no mention, no twin-gate block ("Ashby" is still blocked only by the character), no name question.
- `migrate.test.ts` as §1.1.

**e2e:** none (no request and no UI yet). **Ticks:** none; F-16.22 and F-16.23 note the data layer.

**Slice 1 notes (built 2026-10-12; calls in `QUESTIONS.md`):**
- `SceneMemory.secrets` and `SheetMemory`'s knows/threads/age/topic are added in slices 4 and 5 with the views that fill them (no placeholder values on `memory:scene`/`memory:sheet` meanwhile); slice 1 defines the view schemas the pure rules answer (`SecretView`, `KnowsGrid`, `SceneSecrets`, `TensionLine`, `ThreadMemoryView`, `ThreadsMemory`, `TopicView`, `YearView`, `BornView`, `AgeView`, `TimelineRow`, `TimelineMemory`).
- `pruneTopics` lives in `recordStore` (the one writer of `record`), fed by `recordEvidence.emptyTopics`; it runs in `deleteRecord` and after `tree:delete` (v2). The anchors job never deletes evidence, so it does not prune; slice 2's readings call it after reconcile.
- Slice 2 owes: the gate's `setSceneSettled(true)` on `nothing`/`cosmetic`, `writeSceneRead({ topics: true, settled })` in the pipeline, a rebuild's `replace` deleting the scene's topic quotes it did not state again, and rendering `ReaderRoster.topicLines` (the topics part exists, labels cut to 4 words past 400 tokens). Already in place: reconcile's identity with `how`, `FreshClaim.how/fromId/topicQuoteId` (the pipeline passes null until `reader.v2`), and `notRightLine` keying knows lines by `knows:<secretId>` (used by reconcile and `notRight.ts`).
- `knowsLine`: a knower's own words also show a `PARTIAL` how; the test book's h14 suspicion is in narration.
- The P2b records of the test book carry `addedFor: 'P2b'` and are left out of the `reader.v1` eval roster (`memoryFixtures.ts`), so the token report did not move; the P2a oracle replay reads h13 and h14 with their claim labels (`captain-farmer`, `lottie-age-again`).
- **Review fixes (2026-10-12; `QUESTIONS.md` items 1, 3, 4, 6–9, 12–15):** a name that takes a topic label's norm makes the label yield (" (thread)" added inside the write; `alias_norm_unshared_uq` keeps norms unique, so names and labels cannot simply share one), and labels are never name questions nor near-name words; a thought counts only for its thinker (P2b-D7); touched = any counted or partial line or any reveal in the scene (`SecretView.touchedIn`); readers-since and tension lines carry `stale`; a scene with no words passes "checked up to" (`empty`, the caller's word counts, slice 4); a thread opens only on a counted step (the plan's rule; the reveal is its quote); month counts in words and vague month spans break the carry; a flashback's stated age is not a later scene's; the Pinned birth line is `Born:` / `Born (…):` only; an author's *Same as…* of two topics demotes the merged one's defining reveal to `merged` and keeps one label; Rename in book renames AI-made topic labels with undo; `drafts:delete` prunes, `record:delete` reports pruned ids, and the roster lists AI topics only while the active draft backs them. Slice 4 owes: pass `empty` (scenes with `word_count` 0) to `knowsAsOf`, and dim `readersSince.stale` / `TensionLine.stale`.

---

## 2. Slice 2: `reader.v2`, `verify.v2` and the pipeline (F-16.22, F-16.23 reading)

### 2.1 Plumbing

| Change | File |
|---|---|
| `reader.v2` and `verify.v2` in `PROMPT_CATALOGUE` (features `reader`, `verify`, fast, JSON). The pipeline, the spot checks and *Not about* switch to them; `reader.v1` and `verify.v1` stay catalogued for their eval rows. The roster row's `readerVersion` moves to `reader.v2`, so the first v2 reading rebuilds it once. | `catalogue.ts`, `pipeline.ts`, `spotChecks.ts`, `notRight.ts`, `rosterCache.ts` |
| Budgets unchanged: `reader` 720 out / 6,000 in, `verify` 400 / 3,000 (P2b-D18). | `src/shared/ai.ts` |
| `request.test.ts`: a `reader.v2` and a `verify.v2` request leave Cloud with `reasoning: 'off'` and OpenRouter with `{ enabled: false }`; `openai.test.ts`: the lowest effort on a direct OpenAI key, as for v1. | tests |
| Cost rows: `reader.v2:first`, `reader.v2:window`, `verify.v2` move from `PLANNED_COST_NOTES` to `SHIPPED_PLAN_ROWS` with the fixture sizes; the task totals (index, session) read the v2 rows; `report.test.ts` keeps them within ±30 % of design Part 5 (§6). `AI_COST_NOTES.reader` / `.verify` gain the knows and thread words in `when` and their typical sizes. | `aiCostNotes.ts`, `switchover/plan.ts` |
| Data sharing (`reader` and `verify` rows, v2-only features, so their one text changes): `reader` adds "the secrets and plot threads already found (a short label each) and, for those the changed paragraphs touch, who is known to know them"; `verify` adds "for a fact about who knows a secret, the people who might have told them; for a new secret or plot thread, the sentence that reveals it and, when it may repeat one already found, that one's revealing sentence". `dataSharing.test.ts` snapshot updated. | `aiSettings.ts` |

### 2.2 `reader.v2` (fast, JSON, reasoning off on every route, input cap 6,000)

Same opening sentence as `reader.v1` (the e2e fake's sentinel): "You are the story-memory reader inside a novel-writing app."

| Part (in prompt order) | Budget | Cached |
|---|---|---|
| System: `reader.v1`'s rules plus the knows and thread rules below and the answer schema | ≤ 1,150 (golden asserts) | yes |
| System: the record roster (P2a, unchanged: characters, places, things, groups, terms; least-named dropped over 1,200) | ≤ 1,200 | yes |
| System: the topics roster, headed "Secrets and threads (id label · kind):", one line each, `s3 the sold map · secret`, `t2 Ashby's return · thread`, additions appended; never drops a topic (P2b-D10) | ≤ 400 | yes |
| User: position, typed details, current card (P2a) | ≤ 200 | no |
| User: facts known near the window (P2a's near lines) | ≤ 250 | no |
| User: topic lines for secrets whose terms match the window (`topicTerms` overlap) or that someone Here holds, and open threads named or matched there: `s3 the sold map: r7 overheard 9.3 (from r2); r2 knew before 5.1` / `t2 Ashby's return: open since 13.1, last 13.6` | ≤ 150 (the design's 400 tail, split) | no |
| User: facts anchored in the window and stale ones, knows and steps included (`c7 r7 knows s3 overheard ¶3`), stale reveals (`s3 revealed "…" ¶2, re-checking`) | ≤ 250 | no |
| User: the numbered paragraphs; "Card: yes/no" | ≤ 2,500 | no |

Trimming before sending (token rule 8): near lines first, then topic lines, then anchored lines; never the window or a roster. The maxed case (rules 1,150 + rosters 1,600 + 2,500 page + head) trims about 30 tokens of near lines; the golden asserts the total stays ≤ 6,000.

**New rules** (≈ 220 tokens, compact; the golden asserts the total):
- A secret is something the story keeps from some characters or from the reader: a hidden act, identity, plan or truth. A thread is an open question, promise, goal or mystery the story sets up to answer later.
- Knows fact: `{"p":5,"r":"r7","s":"knows","o":"s3","how":"overheard","fr":"r2","q":"…","voice":"narration","mode":"now"}`; `how` one of the ten; `r` must be on the page or the point of view (a group named in the sentence may know too); `fr` only for told, overheard, read; tells / refers when the person passes it on or shows they know it; knewBefore when the text says they already knew.
- Thread step: `{"p":2,"r":"t2","s":"thread","how":"opens|advances|resolves","v":"what happens, at most 12 words","q":"…","voice":…,"mode":…}`.
- A secret or thread not on the list goes in `n` with `"kind":"secret"|"thread"`, `"id":"x1"`, a label of at most 8 words and the sentence that reveals or opens it as `q`; its facts use `x1`. At most 3 new secrets and 2 new threads; never one already listed (use its id). A listed one marked re-checking whose reveal the paragraphs still state: `{"id":"s3","kind":"secret","p":4,"q":"…"}`.
- Only what the text shows. Not knowing is never a fact: never list who does not know.

**Output caps** unchanged (P2a §2.2): a first or full-read page 720; a window `min(600, 120 + 0.3 × prose)` plus 120 when the card is due. The salvage (`salvageJsonItems`) reads knows and step items like any `c` item and new topics like `n` items.

### 2.3 `verify.v2` (fast, JSON, reasoning off, one batch per page)

Same opening sentence as `verify.v1` ("You are the fact checker inside a novel-writing app."). Rules: `verify.v1`'s plus ≈ 120 tokens:
- **Knows** item (`Who:` the learner candidates; `From:` candidates: records named in the quote's sentences ±1, the quote's speaker, the reader's `fr`; `Secret: s3 the sold map: "<defining quote>"`; `Fact: knows, overheard (narration, now)`; `Text:` ±1 plus the antecedent span): ok only when the sentences show that record learning or holding that secret that way; answers `r`, `how` (the one the text shows), `fr` (an id from From, or null), `voice`, `mode`.
- **Step** item (`Thread: t2 …`, `Fact: advances: …`): ok when the sentences open, advance or resolve that thread; answers `how`.
- **Reveals** item (a new topic's defining quote, or a listed one's restated reveal): ok when the sentences reveal that secret or set up that thread.
- **Same** item (`Same: new x1 "the map sale" — "<its quote>" (14.2) | listed s3 "the sold map" — "<its defining quote>" (9.3)`): ok when both are the same hidden fact or open question, not merely related ones.
- Answer: `{"v":[{"i":1,"ok":true,"r":"r12","voice":"narration","mode":"now","how":"overheard","fr":"r7"}]}`; `parseVerifyAnswer` reads `how` and `fr` leniently (an unknown how is no verdict on it: `unconfirmed`).
- Caps: `verifyMaxTokens` = min(400, 20 + 36 per knows item + 28 per other fact + 12 per step, reveal, same, card or on-page check); `verifyBatches` splits by input (2,500) and by output as now. The strong spot check keeps 40 out (a knows spot check 48).

### 2.4 The pipeline (`pipeline.ts`), what P2b adds to P2a's ladder

1. **Parse** (`readerAnswer.ts`): `c` items with `s: "knows"` carry `o` (a secret's `s`/`x` id), `how`, `fr`; with `s: "thread"` the subject `r` is a thread's `t`/`x` id and `how` a step. `n` items with `kind` are topics (`ReaderTopic { id, kind, label, p, q }`); without it, names as before. A wrong-kind id is refused (`record`).
2. **Before any request to the checker:** a new topic whose defining quote fails presence is dropped with its facts (`topic`); its `stating` key on Dismissed (`topic|kind|…`) drops it silently with its facts; past the page caps (3 secrets, 2 threads) the rest are dropped (`topicCap`). A listed topic's restated reveal is kept only when that topic has a stale reveal in the window.
3. **Subject:** a knows fact's learner goes through `resolveSubject` as any fact (named, antecedent, first person; P2a). A thread step's subject is its thread (`kind: 'topic'`, no name needed). A group learner must be named in the quote's sentence (no antecedent, no new group: refused `group`, P2b-D8).
4. **Learner Here or the POV** (code first, P2b-D8): the Here set is `hereChips` over the typed details and the held card (P2a), plus this reading's card POV and on-page entries once verified. A character learner outside it gets one `present` check in the same batch (sentences ±1); supported → the learner counts as Here for that fact, and joins the card's on-page list when the card is written this reading; else refused `notHere`. Knows and steps never take literal proof.
5. **The checker batch** per page: facts, knows, steps, card and on-page checks as P2a, plus a Reveals item per new topic (and per restated reveal) and Same items: for each new topic, `sameAsCandidates` over the active draft's topics of its kind with live evidence (threads: not resolved as of the scene), at most 3.
6. **Topics after the verdicts** (P2b-D3, D4): a new topic whose Reveals item is not ok is dropped with its facts (`topic`). Otherwise: when a Same item is ok, the topic merges into the first such candidate (by overlap): a `merged` topic quote on it, its proved facts stored on it tagged `topic_quote_id`; else `createTopic` (origin `ai`, `defining` topic quote). A topic is created even when none of its facts passed, since the verified reveal is itself the proved claim that backs it (readers know). A restated reveal ok revives the stale topic quote (new quote and anchor). Two new topics of one reading with the same label fold into one before the checker.
7. **Store** in the reading's one transaction: reconcile (identity with `how`), topic quotes, records, `scene_read.topics_read` (v2 first, full and rebuild reads) and `settled`; then `pruneTopics`. Push `memory:changed` (the learners' and topics' ids) and, for created or merged topics, `record:changed { recordIds, roster: false }`, so the sidebar's Secrets and Threads lists update.
8. **Yields:** new rejection reasons `notHere`, `group`, `topic`, `topicCap` (`LadderReject` extended), and counts `topicsCreated`, `topicsMerged` in the reading's `rejections` JSON (no column change); the health gate reads them as items like any other (§8 risks).
9. **Not right on knows and steps** (`notRight.ts`): *Wrong value* keys on slot `knows:<secretId>` (or `thread:<threadId>`) and the how; *Not about* re-verifies the learner with a knows item. Spot checks build knows and step items through the same `claimCheck`.
10. **No back-fill for topics** (P2b-D17): a topic is not a name, so P2a's lazy back-fill does not run for one; earlier scenes that revealed it were read by then, and a duplicate merges.

### 2.5 Goldens, eval cases, token report

- **Goldens** (`reader.v2.test.ts`, `verify.v2.test.ts`): messages for a first read with both rosters, a window read with topic lines and anchored knows facts, a page proposing a new secret, the maxed case; a verify batch with knows, step, Reveals and Same items; the strong knows spot check. Assert the order (rules → record roster → topics roster → tail), the rules ≤ 1,150, the topics roster ≤ 400 and after the record roster, the total ≤ 6,000, the caps, the sentinels.
- **Eval cases** (`memoryFixtures.ts`, from the test book): `reader.v2` first reads of `h04` (tells, told), `h05` (overheard), `h08` (read, a thread advance), `h13` (the group learner, a refer), `h14` (deduced, suspects, believes otherwise, the rumour and Mr. Harrow as negatives), a window read with topic lines, the maxed case; `verify.v2` a typical knows batch, a Reveals + Same batch (the engagement read as "Lottie's engagement" against "the secret engagement"), the maxed batch, a strong knows spot check. Scoring kinds `reader` and `verify` extended: knows lines scored on learner, secret (by label), how and from; steps on thread and how; Same items on the expected verdict.
- `npm run eval:ai -- -u`; the commit quotes the token-report diff (the `reader.v1`/`verify.v1` rows unchanged; new `reader.v2`/`verify.v2` rows).

### 2.6 Tests

- `readerAnswer.test.ts`: knows, steps, topics in `n`, a wrong-kind id, a cut-off reply salvaging knows items, lenient `how`/`fr` in verdicts.
- `pipeline.test.ts` (the shared fake provider, `readingFixture.ts` extended): a knows fact stored with how and from; a learner off the page refused, and kept after a supported on-page check; a group learner named and one not named; a first-person learner via the typed POV; a new secret created silently with its defining quote and no learner (readers know); its Reveals check failing drops it with its facts; a Same verdict merging (claims tagged, `merged` quote, no new record); a Same verdict absent → a second topic; the caps; a Dismissed topic key dropping silently; a restated reveal reviving a stale topic quote; a thread opened then resolved across two readings; `topics_read` and `settled` written; the topics roster appended, then rebuilt on a merge; `pruneTopics` after a full read that dropped a topic's only evidence; rejections counted by reason.
- `roster.test.ts`: the topics part appended and rebuilt without moving the record part's bytes.
- `notRight.test.ts`, `spotChecks.test.ts`: knows lines.

### 2.7 e2e (`e2e/memory.spec.ts`, new test "story memory v2: who knows what and threads are read (P2b slice 2)", invoke level, Use AI on, own key at the fake)

The fake reader (§ the sentinel switch, extended): it reads the topics roster from the system message; in a paragraph `<A> sold the <thing>.` it proposes a new secret "the sold <thing>" (or uses the listed id) and `<A>` knewBefore; `<B> overheard <A>.` → B overheard the latest secret from A; `<A> swore to find the heir.` → a new thread "the missing heir" opens; `<A> found the heir.` → resolves the listed thread; `The <thing> had been sold by <A>.` → a new secret "the <thing> sale" (a planted duplicate); present entries for every roster character named. The fake checker echoes `how` and `fr` from the Fact line and answers a Same item ok only when both labels share a word.

Steps: create Mara Vell, Orrin and Tomas; Scene 1 "Tomas sold the map. Orrin overheard Tomas. Mara swore to find the heir." → *Read now* → `memory:scene`'s claims hold Tomas knewBefore, Orrin overheard from Tomas, a thread step `opens`; `record:list` has one secret "the sold map" and one thread "the missing heir", both origin `ai`, in no `names:byRecord` list; Scene 2 "The map had been sold by Tomas. Mara found the heir." → read → the checker request carries a Same item; still one secret (merged), the thread's step `resolves`; the reader request of Scene 2 carries "Secrets and threads" with both topics; no request carries "No scene shows".

**Ticks:** none; F-16.22 and F-16.23 note the prompts and the pipeline, and that the live run is owed.

**Slice 2 notes (built 2026-10-12; calls in `QUESTIONS.md`, P2b slice 2):**
- A thread step's verdict carries its voice and mode as well as the step (28 tokens, not 12), so a supposed opening is stored as hypothetical and never opens a thread.
- Knows lines never wait (a shared surname → `subject`, a pronoun the checker leaves open → `unconfirmed`); a pronoun learner gets no on-page check (Here before, or on this reading's verified card, or `notHere`); a new name's knows lines and steps are refused (`name`).
- The Same pool (`topicContext.open`) includes the author's topics with or without a reveal; a Dismissed reveal drops its topic and facts silently (not counted); each new topic and restated reveal counts as one item for the health gate (Same and on-page checks do not); `topicsCreated`, `topicsMerged` and `topicRosterOver` are counts in the rejections JSON beside the reasons.
- A rebuild's `replace` keeps a live reveal whose anchor holds (no `same` for reveals); stale reveals in what was read and not revived are deleted for every purpose (P2a-D23's rule), then `pruneTopics`.
- Extra cost rows `reader.v2:card`, `verify.v2:pro`, `verify.v2:spot` so every task, the rebuild and backlog prices read v2; index ≈ 12.8¢, session ≈ 1.44¢ (report.test within ±30 %).
- `ClaimView` gains `how` and `fromId` (the e2e reads them; slice 4's lines need them).
- h13's group sentence ("the whole regiment knew") does not name "the regiment" word for word: slice 3's replay must give the record the nickname "regiment" or loosen the group rule (QUESTIONS item 12).
- Owed: live fidelity for `reader.v2`/`verify.v2` (cases built; `MYTHSCRIBE_EVAL_LIVE=1`), the one-key live paths (slice 3), the knows replays and live run (slice 3).
- **Review fixes (2026-10-13; `QUESTIONS.md`, P2b slice 2 review):** the reader's pages shrink by what the topics roster runs past the near lines' room and the roster stops at 1,000 tokens (P2b-D10 amended), so no reading overflows its input cap; reveals, the Same pool and the roster read only live evidence in readable scenes (never an Idea scene's sentence); a Reveals verdict answers voice and mode (28 tokens) and a secret only rumoured, supposed or dreamt is not made (`topicNotCounted`; threads exempt); a group learner named by its head noun counts (`groupHeadIn`; h13 now passes); a rebuild re-checks every reveal in the scene and drops the ones not proved again (the plan's §1.4 rule, replacing slice 2's note); learners the card proposes get their own on-page check; earlier pages' new topics are Same candidates for later pages' (merged into whatever the earlier one became); a Same, Reveals or on-page check with no verdict, and a reply cut inside its `n` list (retried from the last new item it gave), leave the topic, its lines and paragraphs unread, never counted against the model, nor is a `notHere` refusal of a line the checker passed; a labelled new topic reusing a listed id is new; facts riding a topic dropped before the checker are not health items; `memory:changed` names the topic ids; *Not about* on a knows line takes only a knower, re-reads its source and keeps the Here rule; the data-sharing rows name the secret's and thread's sentence that knows and step items carry; the live planted run's spot checks use `claimCheck`/`agrees`.

---

## 3. Slice 3: the offline replays, the live knows run, one key for every live path (F-16.22's merge condition, built for the author)

### 3.1 One key: `OPENROUTER_API_KEY` everywhere

`src/main/ai/eval/liveProvider.ts` (new): `liveProviderFromEnv()` → `{ provider, models, openRouter, describe }`. `OPENROUTER_API_KEY` set → base URL `https://openrouter.ai/api/v1`, `openRouter: true` (reasoning off as the app sends it, reported cost read), models `MYTHSCRIBE_EVAL_FAST_MODEL` / `MYTHSCRIBE_EVAL_STRONG_MODEL` else `OPENROUTER_DEFAULT_MODELS` (V4 Flash, V4 Pro). Otherwise `OPENAI_API_KEY` with `OPENAI_BASE_URL` as today (an OpenRouter base URL still detected). Neither → one error naming both. Used by:
- `prompts.eval.ts`'s live fidelity run (today `OPENAI_API_KEY` only, no base URL; its prices from the reported cost when given);
- `memory.eval.ts`'s live planted-error run (P2a);
- the new `knows.eval.ts` (§3.3);
- `aiProbe.probe.ts` (`npm run ai:probe`): already `OPENROUTER_API_KEY`; also accepts `OPENAI_API_KEY` when `OPENAI_BASE_URL` is OpenRouter's.

`liveProvider.test.ts`: each env shape → the right base URL, flags and models, without a request. The doc comments, `docs/OPERATOR-SETUP.md` (the probe), `CLAUDE.md` 1b/1c and the F-16.17 text name the one-key commands: `MYTHSCRIBE_EVAL_LIVE=1 OPENROUTER_API_KEY=sk-or-… npm run eval:ai` (fidelity), `… npm run eval:ai -- memory` (planted errors), `… npm run eval:ai -- knows` (who knows what).

### 3.2 Offline replays (`src/main/ai/eval/knows.eval.ts`, in the `eval` project, so `npm run test` runs them)

- **Oracle replay**: P2a's oracle (`memory.eval.ts`, its reader and checker moved into `memoryOracle.ts` so both files share them, no copy) gains the knows, threads and topic labels: the oracle reader proposes each label's knows line, step and topic (with the label's defining quote) the first time its scene is read, using roster ids once a topic is listed; the oracle checker answers Same by the labels (same label id → ok). Read in book order: every labelled learning line is stored and counts; every topic is created once; no negative is counted; the grid as of `h14` matches the labels; `storyYears` and `ageAsOf` over the replayed book match the `years` and `ages` labels; invariants clean. Read in **reverse order** (`h14` first): the engagement and the debts are created late, the earlier scenes' reveals merge into them through Same, and the duplicate rate is exactly 1.0.
- **Adversarial replay**: a reader that plants: a learner not on the page (refused `notHere`, or kept only after an on-page check the honest checker refuses); the rumour in `h07` and the dream in `h06` as `told` (stored with their voice or mode, never counted); a group never named; a fourth new secret on one page (`topicCap`); a duplicate of a listed secret under a new label (merged); a secret on a Dismissed reveal (dropped); a step on a secret's id (`record`). Mr. Harrow never knows the debts; no line anywhere says he does not.

### 3.3 The live knows run (owed by the author; cannot run in the build sessions)

`MYTHSCRIBE_EVAL_LIVE=1 OPENROUTER_API_KEY=sk-or-… npm run eval:ai -- knows`

- Two passes on fresh copies of the test book project: book order, then reverse order (to force late creation and merges). Real `reader.v2` and `verify.v2`; stops when the reported cost passes 50¢ (about 3¢ expected for both passes on V4 Flash).
- **Scored:** knows recall (labelled `LEARNS` and `HOLDS` lines found: a live counted claim with the label's learner and secret in its scene, the quote overlapping), `PARTIAL` recall apart; **attribution precision** (stored counted knows claims whose learner, secret and how class match a label in that scene; `from` accuracy where the label has one); thread step recall and status at the book's end; **duplicate rate** per pass (topic records per labelled secret or thread, mapped by evidence overlap) and the extra topics with no label (listed for the author to read, no bar); negatives counted (rumour, dream, hypothetical, Mr. Harrow); topics from never-read scenes; yields by reason (`notHere`, `topic`, `topicCap`); the cut-off rate; cost.
- **Pass bars** (decided by Claude, unconfirmed, P2b-D23): knows recall ≥ 70 %, attribution precision ≥ 90 %, how accuracy ≥ 80 %, from accuracy ≥ 80 %, duplicate rate ≤ 1.25 in each pass, zero counted negatives, zero topics from never-read scenes.
- Output: `test-results/eval-knows/knows-<date>.md` and `.json` (no prompt text, no key); the author copies the report into `docs/research/story-memory-2026-10-11/eval/` and commits it.

**e2e:** none. **Ticks:** none; F-16.22 names the command as owed.

---

## 4. Slice 4: who knows what in the panel, the Book grid and the sheets (F-16.22 UI)

### 4.1 Main views and channels (`src/main/memory/reading/knowsViews.ts`)

| Channel | Access | What |
|---|---|---|
| `memory:scene` (extended) | `read` | `SceneMemory.secrets` (`sceneSecrets` over the active draft, the scene's Here set and POV). |
| `memory:knows { asOf: string \| null }` | `read` | `KnowsGrid` (default as of: the open scene, else the end of the book). |
| `memory:sheet` (extended) | `read` | `knows` for a character or group (its lines as of the scene, its knew-before, later count); `topic` for a secret (readers since, defining quote, merged reveals, holders, knew-before). |
| `memory:knewBefore { secretId, recordId, knew }` | `write` | The author-owned `knew_before`; pushes `memory:changed`. Refused after the trial like every `write`. |
| `memory:splitTopic { topicQuoteId }` | `write` | *Split* (P2b-D5) → `{ recordId }` and a `split` Dismissed row; pushes `record:changed`, `memory:changed`. |
| `memory:topicNotRight { recordId }` | `write` | *Not a secret* / *Not a thread* on an AI-made topic (P2b-D13): its claims and quotes go, a `notRight` row per reveal; *Undo* in Dismissed restores the snapshot (settings row `memoryTopicNotRight`, the `memoryNotRight` pattern). |
| `memory:rebuildSummary` (extended) | `read` | A group "New secrets and threads (n)" with the bulk *Not right* (`memory:rebuildAction` `notTopics`). |

Absence (rule 9): the views carry `checkedUpTo` and holders only. Tests assert that `buildStoryNotes`, every v2 prose prompt fixture, the `agent.v8` v2 tool outputs (`lookup`, `cards`, `find_passages`) and `reader.v2`/`verify.v2` messages never contain "No scene shows" or a not-knowing line, whatever the book holds.

### 4.2 Renderer

| Part | What | Files |
|---|---|---|
| Store | `memoryStore` gains `knows` by as-of (read while shown, by watch count, as `sheets`), refreshed on `memory:changed`; reset in tests. | `memoryStore.ts` |
| This scene: **Who knows what** | After True now. Each secret touched in the scene: its label with ⓘ (`TopicInfo`: the defining quote with *Go there*, "checked by a second AI read", the reading's cost, each merged reveal "also read as 'the map sale' in 1.2: judged the same by a second AI read · Split", *Not a secret* when AI-made), "readers since 1.1", then its holders Here (`ClaimLine`: "Orrin: overheard from Tomas (1.1)" with ⓘ and *Not right*; "Tomas: knew before the book (you said)"), then, muted, for each Here character with no counted line: "No scene shows Mara learning this (checked up to 1.2)" (or "not checked yet"). Then up to 3 tension lines ("Readers know the sold map (since 1.1); no scene shows Lise (POV) learning it (checked up to 14.2)") and "+ 9 more in Book", which opens the Book tab at the grid. The section shows nothing when the scene touches no secret and has no tension. | `features/memory/knows/WhoKnowsWhat.tsx`, `TopicInfo.tsx`, `knowsView.ts` (the words, the only place the absence text is made) |
| Book: **As of [scene ▾]** | One picker at the top of the Book tab (the `FromTheBook` picker extracted as `AsOfPicker`, reused, not copied), default the open scene. | `ThisScenePanel.tsx`, `records/AsOfPicker.tsx` |
| Book: **Who knows what** grid | Rows: the secrets readers know as of the scene, newest first, "N more later in the book"; columns: the characters and groups with any line or knew-before as of the scene, plus the scene's POV, by how often named (P2b-D20); first column sticky, the table scrolls sideways inside its own box. A cell: "overheard 9.3", "suspects 7.1", "believes otherwise 8.2", "knew before (text, 2.1)", "knew before the book (you)", "learns later (17.3)" muted; each opens its ⓘ. An empty cell shows "—" with its title "No scene shows Mara learning this (checked up to 14.2)" and a menu with *Knew before the book* (`memory:knewBefore`); a knew-before cell's menu has *Remove*. A row's label opens the secret's sheet. | `features/memory/knows/KnowsGrid.tsx`, `KnowsCell.tsx` |
| Sidebar **Secrets** | A v2 section after the categories (`buildV2Sections`), listed once a secret exists, `RecordTab` over category `secret` (list with "readers since 5.2 · 3 know", the AI mark on AI-made ones) with *New secret* (no twin gate, P2b-D19). | `shell/sectionList.ts`, `records/RecordList.tsx` |
| Sheets | A character's or group's **Knows, as of [scene ▾]** (its lines with ⓘ and *Not right*, partial ones muted, knew-before with *Remove*, "2 more later in the book"); a secret's **The secret** section in place of From the book (readers since, the defining quote with ⓘ, merged reveals with *Split*, who knows as of the scene, *+ Someone knew before the book* with a record picker, *Not a secret* when AI-made); no *Rename in book* and no nickname *Split* on topic sheets. | `records/KnowsSection.tsx`, `records/TopicSection.tsx`, `RecordSheet.tsx` |
| Rebuild dialog | The "New secrets and threads" group with *Not right*. | `RebuildMemory.tsx` |

### 4.3 Tests

`knowsViews.test.ts` (main: the grid and scene secrets over a stored book; knew-before; split and Not right with Undo; read-only refusals); `handlers.test.ts` (channels, `v2` in `CHANNEL_MEMORY`, `write` access); `channelAccess.test.ts`; renderer: `WhoKnowsWhat.test.tsx` (touched, holders, the muted scoped line, tension lines capped at 3, "+ N more" switching tabs, nothing when empty), `KnowsGrid.test.tsx` (cells, the empty cell's title and *Knew before the book*, later rows, as-of), `TopicSection.test.tsx` (Split, Not a secret, knew-before picker), `KnowsSection.test.tsx`; `sectionList` snapshot (v1 unchanged; v2 with and without secrets); the absence tests of §4.1.

### 4.4 e2e (`memory.spec.ts`, "story memory v2: who knows what in the panel, the grid and sheets (P2b slice 4)", continuing slice 2's fake)

A new project with Mara Vell, Orrin and Tomas. Scene 1 (Mara typed as POV): "Mara watched from the stair. Tomas sold the map. Orrin overheard Tomas." → *Read now* → the This scene panel's Who knows what shows "the sold map", "Orrin: overheard from Tomas (1.1)", "Tomas: knew before (1.1)" and, muted, "No scene shows Mara learning this (checked up to 1.1)". Scene 2 (Mara POV, Orrin and Tomas absent): "Mara waited at the quay." → read → a tension line "Readers know the sold map (since 1.1); no scene shows Mara (POV) learning it (checked up to 1.2)" and "+ N more in Book", which opens the grid. The grid's empty Mara cell → *Knew before the book* → the cell reads "knew before the book" and the scene's tension line goes. Scene 3: "The map had been sold by Tomas." → read → still one secret, whose sheet lists the merged reveal "the map sale" → *Split* → the sidebar's Secrets lists two and Dismissed (n) went up by one; *Not a secret* on the split one removes it, *Undo* in Dismissed brings it back. A ghost-text request from Scene 2 carries a Story notes block with no "No scene shows" and no knows line.

**Ticks:** none; F-16.22 notes the UI.

---

## 5. Slice 5: threads, the timeline and ages; final verification (F-16.23; ticks)

### 5.1 Main views and channels (`src/main/memory/reading/timeViews.ts`)

| Channel | Access | What |
|---|---|---|
| `memory:threads { asOf }` | `read` | `ThreadsMemory`: every thread record (the author's and the AI's) with live evidence or made by the author, `threadsAsOf`, `checkedUpTo`. |
| `memory:timeline { recordId: string \| null }` | `read` | `TimelineMemory`: readable scenes in reading order with `storyYears` (typed details, the held card's verified year and flashback, its elapsed hint standing on the text), the typed time text, and ages: for each row, the Here characters' `ageAsOf` (or, with `recordId`, that record's in every row). Idea scenes and scenes left out of compile are not rows. |
| `memory:sheet` (extended) | `read` | `threads` (steps whose quote's paragraph names the record, as of the scene); `age` (`ageAsOf` as of the scene); `topic` for a thread (status, steps). |

All local and free; the views reuse `readingOrder`, `heldCard` and the card store (P2a), and `storyYears` runs once per call over the book's rows (no text read; about 1 ms for 90 scenes).

### 5.2 Renderer

| Part | What | Files |
|---|---|---|
| Book: **Threads** | Each thread as of the picked scene: name (AI mark when AI-made), status "open since 2.1 · last 7.3" / "resolved in 20.1" / "not yet in the book", its steps as `ClaimLine`s ("advances 7.3: Johanna writes to Ashby", ⓘ, *Not right*; muted when remembered or rumoured), *Not a thread* on an AI-made one (`memory:topicNotRight`); an author's thread with no step: "No scene shows this thread yet (checked up to 14.2)" muted; *New thread*. | `features/memory/threads/ThreadsList.tsx` |
| Sidebar **Threads** (the P1 category list) | The same list's status beside each record ("open since 2.1"); its sheet's **The thread** section. | `RecordList.tsx`, `records/TopicSection.tsx` |
| Book: **Timeline** | One row per readable scene: ref and title, the year ("1811" typed; "1811 · from 1.1" carried; "1812 · stated here"; "flashback · 1798"; "year not known since 'A year later' (18.1)"), the elapsed hint quote, the typed time, and the ages of who is Here ("Mara about 19"); *Ages of [record ▾]* shows one record's age in every row instead. A row opens its scene. | `features/memory/timeline/TimelineView.tsx` |
| Sheets | A character's **Age, as of [scene ▾]** ("about 19 · year from 1.1 · born 1792 (1.1)" with ⓘ on the born line; or "19, stated in 2.1 · since then: 'Three winters later' (14.1)"; nothing when neither is known) and **Threads** (the steps naming them). | `records/AgeSection.tsx`, `records/ThreadsSection.tsx` |

### 5.3 Tests

`timeViews.test.ts` (threads and timeline over a stored book: carry, flashback, breaking hint, quoted year, ages computed and stated, the test book's `years` and `ages` labels through the real stores); `handlers.test.ts`, `channelAccess.test.ts`; renderer `ThreadsList.test.tsx`, `TimelineView.test.tsx`, `AgeSection.test.tsx`, `ThreadsSection.test.tsx`; the Book tab's order (Cast, Who knows what, Threads, Timeline, Rebuild memory) in `ThisScenePanel.test.tsx`.

### 5.4 e2e (`memory.spec.ts`, "story memory v2: threads, the timeline and ages (P2b slice 5)")

The fake reader also reads `Mara was born in <year>.` as `born`, `Mara was <word>.` as a stated `age`, and gives the card an `elapsed` field when a paragraph opens "Three winters later". Scene 1 typed year 1811 (scene details) with "Mara was born in 1792. Mara swore to find the heir."; Scene 2 (no year) "Mara was nineteen."; Scene 3 "Three winters later, Mara found the heir.". After reading all three: Book › Threads shows "the missing heir · resolved in 1.3" with its two steps; Book › Timeline shows 1.1 "1811", 1.2 "1811 · from 1.1", 1.3 "year not known since 'Three winters later' (1.3)", and Mara "about 19" in 1.1 and 1.2; Mara's sheet's Age as of 1.2 reads "about 19 · year from 1.1", as of 1.3 "19, stated in 1.2 · since then: 'Three winters later' (1.3)"; typing 1814 as Scene 3's year makes its row "1814" and Mara "about 22" there.

### 5.5 Final verification and ticks

Full gates on the last commit (typecheck, lint per folder, test, `eval:ai`, `test:e2e`: `memory.spec.ts` beside the unedited v1 smoke). Then tick F-16.22 and F-16.23 (P2a-D18's rule), each naming the author's checks still owed in a development build (`MYTHSCRIBE_STORY_MEMORY=v2 npm run dev`): the grid and tension lines on a real chapter, a merge and *Split*, *Knew before the book*, Threads, the Timeline and ages. Record in F-16.22, the M8 row and `CLAUDE.md` "Next up" (1b and 1c): **owed before the switch-over**, the live knows run (the merge condition, §3.3) and live fidelity for `reader.v2` and `verify.v2`, all with `OPENROUTER_API_KEY` (§3.1). `docs/ARCHITECTURE.md`: one bullet per slice ("Story memory v2: who-knows-what data and time rules", "reader.v2 and verify.v2", "the knows eval and one live key", "who knows what in the panel and sheets", "threads, timeline and ages"). `docs/OPERATOR-SETUP.md`: nothing to deploy (no new feature id; `reader` and `verify` already run fast with reasoning off on the Worker).

---

## 6. Costs (own key, list prices: V4 Flash $0.14 in / $0.28 out per million tokens; Cloud × 1.25)

| What | Requests | Tokens (in / out) | Own key | Cloud |
|---|---|---|---|---|
| A window read when she leaves or pauses | `reader.v2` + `verify.v2` | 4,370 / 320 + 1,500 / 140 | ≈ 0.095¢ (P2a: 0.09¢) | ≈ 0.12¢ |
| A first read of one scene | `reader.v2` + `verify.v2` | 4,170 / 560 + 1,500 / 140 | ≈ 0.1¢ | ≈ 0.13¢ |
| A 2-hour session | ~12 window reads, ~3 cards, ≤ 2 plan-link calls | 80k / 7.3k | ≈ 1.4¢ (P2a: 1.3¢; up to 2.6¢ hopping between scenes) | 1.75–3.3¢ |
| *Rebuild memory*, 90 scenes | 90 pages × 2, 50 fast + 20 strong spot checks | 541k / 67k Flash; 14k / 0.8k Pro | ≈ 12.5¢ (P2a: ≈ 12¢) | ≈ 15.6¢ |
| A same-as check | one Same item in the page's batch | ≈ 80 / 12 | ≈ 0.001¢ | |
| The grid, threads, timeline, ages, knew-before, Split | local | 0 | $0 | $0 |
| The live knows run (author, once) | two passes over the test book (about 16 readable scenes each) | ≈ 2 × 90k / 11k | ≈ 3¢ (stops at 50¢) | — |

The extra per reading is the rules (+220, cached), the topics roster (≤ 400, cached), the topic lines (≤ 150 of the tail's 400) and about 40 output tokens; the checker adds about 200 in and 30 out for knows, Reveals and Same items. The computed figures come from the registry (`npm run eval:ai -- -u` regenerates `docs/AI-COST-REGISTRY.md`); `report.test.ts` keeps them within ±30 % of design Part 5. Storage: topic quotes and knew-before rows add a few kilobytes per novel.

---

## 7. Decisions this plan makes (decided by Claude, unconfirmed; logged in `QUESTIONS.md`)

- **P2b-D1.** Secrets and threads are records with fixed categories: a new v2-only built-in category `secret` (a "Secrets" sidebar section listed once one exists) and the existing `thread`. Their category cannot be changed and no other record moves into them. A label whose norm another record holds gets " (secret)" or " (thread)" added.
- **P2b-D2.** Secret and thread records are not names: they are out of the name scan, mentions, the twin gate, name questions, the spellcheck and Rename in book. Renaming one renames its label. This changes P1 for thread records in v2, which stop producing mentions.
- **P2b-D3.** A topic's defining quote is stored apart (`topic_quote`, per draft, anchored like a claim). It must pass the presence check and a Reveals check in the same batch. Once it does, it is itself the proved claim that backs the topic, so a secret the narration reveals with no learner on the page still exists ("readers know").
- **P2b-D4.** Same-as candidates are the active draft's open topics of the same kind (all secrets; threads not resolved as of the scene) sharing a content term (names folded to records) or, for secrets, a holder: at most 3, highest overlap first. A Same verdict merges into the first one that says so. The merged reveal is kept as a `merged` topic quote, and the claims that came with it are tagged; ⓘ shows it with *Split*.
- **P2b-D5.** *Split* makes a new AI-made topic from the merged reveal, moves the claims tagged with it, and writes a `split` Dismissed row for the pair, so the two never merge again. *Undo* of that row only allows a later merge; it never re-merges (P1's *Split* semantics).
- **P2b-D6.** A knows claim's record is the knower (a character or group), its object the secret, `how` one of ten, and `from` is kept only for told, overheard and read (null otherwise, as the test book labels it). Its value is the how, and its *Not right* key uses slot `knows:<secretId>`.
- **P2b-D7.** What counts as knowing: mode now or memory; narration or thought, or dialogue spoken by the knower (tells, refers) or by the `from` (the learner heard it). Never rumour, a hypothetical or a dream. *Suspects* and *believes otherwise* are shown as such and never count, and they do not set "readers have known since" (only reveals and counted lines do).
- **P2b-D8.** The Here rule is checked in code first, from the typed POV, the held card's verified POV and on-page entries, *+ also here*, and this reading's verified card. A character learner outside that set gets one on-page check in the same batch. A group learner is exempt but must be named in the quote's sentence. No group record is made silently.
- **P2b-D9.** "Checked up to" covers the longest run of readable scenes, from the start of the book, that `reader.v2` has read whole with nothing finished left unread (`scene_read.topics_read` and `settled`). Scenes read only by `reader.v1` do not count. It is never stated as a fact, and it never reaches a prompt, the Story notes block or a chat tool.
- **P2b-D10.** The topics roster comes after the record roster in the cached system message, so topic churn never moves the record prefix. It never drops a topic. Past 400 tokens, labels shorten to 4 words; past that, the overflow comes out of the near-facts budget and is counted (`memory.topicRoster.over`). *Amended in the slice 2 review (2026-10-13):* what the near lines cannot give comes out of the page (`readerV2PageTokens`: pages and windows are planned smaller), so a reading always fits its 6,000; past `TOPIC_ROSTER_MAX_TOKENS` (1,000, about 140 topics) the AI-made topics with the least evidence are left out (the author's last; counted `topicRosterLeftOut`), and a left-out one the reader proposes again is merged by the Same check. Only readable scenes of the active draft back an AI-made topic in the roster.
- **P2b-D11.** New topics are capped at 3 secrets and 2 threads per page; the rest are dropped and counted. The live run's duplicate rate and topics per scene decide whether to change it.
- **P2b-D12.** An AI-made topic with no topic quote and no claim left in any draft, and nothing from the author (no Pinned or Ideas text, no knew-before), is deleted after the reading or anchors run that emptied it.
- **P2b-D13.** *Not a secret* / *Not a thread* on an AI-made topic deletes it with its claims and writes a `notRight` row per reveal, keyed by the reveal's sentences, so it is not made again from them. *Undo* restores it.
- **P2b-D14.** An elapsed hint ends the year carry, and is listed for ages, only when it can cross a year: years, seasons, six months or more, or a long vague span. "The next morning" or "a week later" do neither. A verified flashback neither takes the carry nor ends it, and its own year applies to it alone. A quoted year counts only once the checker has verified it.
- **P2b-D15.** The birth year comes from a live narration-now `born` claim with one year in it, else from the record's Pinned "Born: 1792" line (the switch-over's form of the v1 field), so the ages she had keep working. Ages always say "about".
- **P2b-D16.** P2b changes no chat prompt and no agent tool. P3's navigator and instant cards read P2b's pure functions, positive lines only.
- **P2b-D17.** No reader-upgrade notice and no topic back-fill. Scenes read by `reader.v1` keep their claims; knows and threads arrive as scenes are read again or on *Rebuild memory* (the switch-over's rebuild uses `reader.v2`). Until then those scenes are "not checked".
- **P2b-D18.** Output caps stay as the design set them (720, the window formula). `verify.v2` budgets 36 tokens per knows verdict. The live run's cut-off rate decides any change.
- **P2b-D19.** The author can make secrets (*New secret*) as well as threads. Neither runs the twin gate (labels are not names); an exact duplicate label is warned about.
- **P2b-D20.** The grid's columns are the characters and groups with any line or knew-before as of the scene, plus that scene's POV, ordered by how often each is named. Rows are the secrets readers know as of the scene, newest first, plus a "later in the book" count.
- **P2b-D21.** This scene shows every secret touched in the scene and at most 3 tension lines: first "readers know and the POV doesn't", then "someone Here knows and another Here doesn't". "+ N more in Book" counts the grid's other rows.
- **P2b-D22.** Thread status is derived, never stored: not yet, open, or resolved. A resolve and an advance in one scene read as resolved. Steps count only in mode now and not as rumour; the rest are listed muted.
- **P2b-D23.** The live knows run's pass bars: knows recall ≥ 70 %, attribution precision ≥ 90 %, how and from accuracy ≥ 80 %, duplicate rate ≤ 1.25 in book order and in reverse order, and zero counted negatives.

## 8. Gates, ticks, docs, and what P2b does not do

- **Gates per slice:** typecheck, lint per folder, test, test:e2e (`memory.spec.ts` and the unedited smoke), eval:ai. Slice 2 runs `eval:ai -- -u` and quotes the token-report diff. No live run is possible here; the knows run and the one-key change are built for the author (§3).
- **Ticks:** none in slices 1–4 (progress notes in the F-16.22/F-16.23 text); both after slice 5's final verification.
- **Docs in the same commits:** `docs/ARCHITECTURE.md` (one bullet per slice), `docs/AI-COST-REGISTRY.md` (slice 2), `QUESTIONS.md` (each slice's calls), `FEATURES.md` progress notes, `CLAUDE.md` "Next up" and `docs/OPERATOR-SETUP.md` (the one-key commands, slice 3; the final state, slice 5).
- **Not in P2b:**
  - C3 (a slip: telling before learning), C4 (an age against the birth year), C5 (a thread advancing after its resolve) and loose ends (an author's thread left untouched, a secret nobody learns): P4, which reads P2b's claims and functions;
  - instant cards ("does A know X", "who knows X"), the navigator's `knows` and `timeline` tools and `agent.v9`: P3;
  - group membership (who belongs to "the regiment"): P4 needs it for C3's group rule and decides it there;
  - thread lanes on a storyboard: P7.
- **Risks:**
  - **Over-creation.** The reader may call too much a "secret". This is bounded by the page caps, the Reveals check, Dismissed keys and the live run's extra-topics list; the grid stays readable because rows are only the secrets readers know as of the scene.
  - **Missed merges.** Two labels with no shared word and no shared holder are never compared. At worst the author sees two rows, never a false finding, and *Same as…* merges them by hand. The reverse-order live pass measures this.
  - **The health gate may pause reading.** Knows items are harder than eye colours, so a model that handles P2a's slots may fall under the 80 % verified bar. The live run reports verified rates by kind; if knows alone drags a model under, the gate can count them apart (a change to P2a-D16, logged then).
  - **Scenes read before P2b show "not checked yet"** until they are read again. That is honest, but it can look empty in a development project read under `reader.v1`; *Rebuild memory* fixes it.
  - **Slice 2 is the largest.** If it runs long, the Same items (§2.4 step 6 merge path) can ship in slice 3 with the replays that test them, and slice 2 then creates topics without merging.
