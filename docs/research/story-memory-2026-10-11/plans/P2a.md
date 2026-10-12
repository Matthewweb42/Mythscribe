# P2a Evidence reader: implementation plan

**Features:** F-16.16 to F-16.21 (`FEATURES.md` §2.16). Phase P2a of the story memory redesign, approved by the author on 2026-10-11 (`../design.md` §2.1–2.3, §2.6 (the prose block, the beta reader, data sharing), §2.7, §2.10, Part 3, Part 4, Part 5; `../author-answers.md` answers 1, 4, 5, 7, 17, 19, 20, 21, 22; decisions 2, 4 and 7). **Size:** L, about 2.5 weeks, in five slices. **Status:** planned 2026-10-12; slice 1 (the evidence data layer) built 2026-10-12, review fixes the same day (§1.6).

**Goal:** the app reads the author's prose and keeps what it states, each line proved by a quote. When she leaves a scene or pauses, a code gate decides whether a finished sentence changed; if so, `reader.v1` reads the changed paragraphs (±2) on the fast tier with reasoning off, a verification ladder keeps only what is proved (in code where it can, by `verify.v1` where it cannot), and the claims stay live only while their sentences are unchanged. The This scene panel gains Here (on the page), Mentioned and True now; sheets gain **From the book, as of [scene]**; every AI line has ⓘ and *Not right*. *Rebuild memory* reads the whole book once, priced first. On Cloud, background reading spends up to a monthly cap ($1 by default). Everything that read stored summaries reads cards instead, plan links are applied automatically, and `summary.v5` stops in v2.

**Rules that hold in every slice** (P1's rules, carried over):
1. **Everything is behind `storyMemory === 'v2'`.** A v1 project sends, stores and shows exactly what it does today. New channels are `v2` in `CHANNEL_MEMORY`; main code that branches takes `memory: StoryMemoryVersion` as a required input; the smoke e2e (`e2e/smoke.spec.ts`, v1) is not edited.
2. **Migrations are additive** (0034+): new tables, new nullable columns. `migrate.test.ts` keeps the byte-identical check of every older table.
3. **Each prompt version** is a new file with a golden test, eval cases, a token-report row, its `aiCostNotes.ts` note and its data-sharing row, with one `npm run eval:ai -- -u` per slice that changes prompts; the commit quotes the token-report diff. Fast JSON features that never think join `NO_REASONING_FEATURES` (new ids) or `NO_REASONING_PROMPTS` (new versions of existing ids, so v1's versions keep their reasoning).
4. **No live run can happen in the build sessions** (no API key). Every live case and the planted-error run are built so the author can run them (§2.7); each slice says so, and the final slice records the owed runs in `FEATURES.md` and `CLAUDE.md`.
5. Tag, entity, knowledge, Organise and To do code is frozen for edit lists; P2a touches those files only for v2 early-outs.
6. Lint per folder (`npx eslint --max-warnings 0` on `src/shared`, `src/preload`, `src/main`, `src/renderer`, `cloud`, `e2e`, `scripts`); the full `npm run lint` runs out of memory. The full gate suite runs at most twice per slice. Node-heavy commands under `flock /tmp/mythscribe-heavy.lock`.
7. Each slice adds or updates its `docs/ARCHITECTURE.md` bullet, logs its open calls in `QUESTIONS.md`, and notes its progress in the F-16.x text. The six features are ticked after slice 5's final verification (§7, decision P2a-D18).
8. `src/main/ipc/handlers.ts` is over 5,000 lines: the reader's queue, triggers and policies live in a service module (`createReaderService`, the `createSheetSyncService` pattern); handlers only register channels and call it.

**Build order:** slice 1 (data and pure rules, no AI) → 2 (the two prompts and the pipeline, Read now, the eval harness and the live planted-error run) → 3 (when a scene is read, the backlog, back-fill, health gate, spot checks, Rebuild memory, the Cloud cap, `summary.v5` off) → 4 (the UI: panel, ⓘ and *Not right*, as-of sheets, the card in scene details with decision 4, Settings) → 5 (summary readers re-pointed, plan links, final verification and ticks). Each slice builds, gates and commits on its own.

---

## 0. The shape of it

```
editor save ──► anchors job (local, every save): sentences → hashes → claims stale or re-proved free
leave / idle / Read now / backlog ──► code gate (finished sentence changed? cosmetic? caret?)
      └─► plan: window (changed ¶ ±2, back to a naming ¶) or full read (pages of 2,500)
            └─► reader.v1 (fast, JSON, reasoning off) ─► ladder: 1 presence · 2 subject · 3 literal proof in code
                  └─► verify.v1 (fast, one batch per page) for what code cannot prove, card fields, presence
                        └─► reconcile (same / revive / drop / merge / Dismissed) ─► claim, card, reading, scene_read
                              └─► card lines into the passage index; plan links (code first, planLinks.v2 at most once)
```

Every derived row carries its `reading_id` and `draft_id`; only the active draft's rows are live (design §2.2). Nothing is read from Try, chats, inactive drafts, Idea scenes, scenes left out of compile, notes, Research or sheets (`readerMayRead`, P0).

---

## 1. Slice 1: the evidence data layer (no AI; F-16.17 and F-16.18 data, F-16.16's gate)

### 1.1 Migration `0034_story_reading` (generated: `npm run db:generate -- --name story_reading`)

| Table | Columns |
|---|---|
| `reading` | `id`; `node_id` (FK cascade); `draft_id` (FK `draft` cascade); `purpose` (`first`, `window`, `full`, `backfill`, `rebuild`, `retry`, `probe`, `notAbout`); `pages`; `paras` (JSON ranges sent); `prompt_version`, `verify_version`; `model`; `tokens_in`, `tokens_out`, `reasoning_tokens`; `cost_usd` (reader + verify, reported cost where given); `cloud` (bool); `finish_reason` (`length` if any page was cut off); the yields: `items`, `quotes_found`, `literal`, `verify_sent`, `verified`, `rejected`, `rejections` (JSON counts by reason), `cut`; `created`. Index (`model`, `created`) for the health gate, (`node_id`, `draft_id`). One row per reading, all its pages (decision P2a-D1). |
| `scene_read` | `node_id` + `draft_id` (PK, both FK cascade); `sentences` (JSON `[gateHash, text][]`: every finished sentence counted as read, its gate-normalised text kept so the cosmetic skip can compare, P2a-D2); `partials` (window reads since the last full one); `full_at`; `reading_id` (FK set null); `updated`. |
| `card` | `node_id` + `draft_id` (PK, FK cascade); `reading_id` (FK set null); `line` (≤30 words); `gist` (60–80 words); `fields` (JSON: `where`, `when`, `pov`, `year`, `flashback`, `elapsed`, each `{ value, quote, p, verified }` or null; `pov` holds a record id); `present` (JSON `{ recordId, quote, p, verified }[]`); `mood`, `theme`; `anchor` (JSON hashes of every quote's sentence, to know when the card is due); `line_hash` (plan links run only when it moves); `created`. |
| `claim` | `id`; `node_id` (FK cascade); `draft_id` (FK cascade); `reading_id` (FK set null); `record_id` (FK cascade; null while it waits on a new name); `pending` (JSON `{ kind: 'name', norm, text }` or `{ kind: 'subject', candidates }`, null when attached); `subject_text` (the name span that pinned the subject, null for a pronoun; *Split* uses it); `slot`; `value`; `value_key` (normalised for grouping and Dismissed keys); `object_id` (FK record set null: kinship and relation targets); `how`, `from_id` (null in P2a, written from P2b; added now so P2b needs no migration); `voice`; `speaker_id` (FK record set null); `mode`; `quote`; `para`; `anchor` (JSON hashes); `proof` (`literal` or `verified`); `change` (bool: the sentence states a change, "cut her hair"); `state` (`live`, `stale`, `waiting`); `spot` (`agree`, `disagree`, null), `spot_tier`, `spot_at`; `created`, `proved`. Indexes (`node_id`, `draft_id`), (`record_id`, `slot`), (`state`). |
| `plan_link` | `plan_id` (PK, FK node cascade); `scene_id` (FK node cascade); `origin` (`code`, `ai`); `score`; `reason`; `reading_id` (FK set null); `created`. AI-made links only; the author's stay in scene meta's `fulfilledBy` (P2a-D12). |
| `memory_backfill` | `record_id` (FK cascade) + `norm` (PK); `state` (`due`, `asked`, `done`, `declined`); `pages`; `created`; `done_at`. One row per name a late record or nickname brought, so a back-fill runs once. |

`migrate.test.ts`: a database at 0033 with a row in every table migrates to 0034; the pre-0034 tables dump byte-identical; the new tables are empty.

No migration for the passage index: `memory_passage_fts.source` and `memory_scan.owner_kind` are unchecked text, so card lines go in under a new source `card` and owner kind `card` (§1.2, §1.3).

### 1.2 Shared vocabulary and pure rules (`src/shared/memory/`, beside P0's and P1's helpers)

| File | What it holds |
|---|---|
| `slots.ts` | The closed slot list (design §2.2) with each slot's group: **fixed** `eyes`, `born`, `species`, `kinship` (with `object`); **lasting** `hair`, `alive`, `role`, `age` (stated age), `scars`; **transient** `location`, `injuries`, `clothing`, `objects`; **accumulating** `traits`, `history`, `relation` (with `object`); `knows` and `thread` listed for P2b and refused by the P2a parser. `DETAIL_LABELS`: about 20 `detail:<label>` slots, each with its group (fixed: `height`, `build`, `skin`, `handedness`, `birthplace`, `accent`, `mark`; lasting: `home`, `occupation`, `rank`, `title`, `faith`, `allegiance`, `income`, `wealth`, `language`, `weapon`, `companion`, `illness`), so the test book's `detail:income` parses. `SLOT_LABEL` for display ("Eyes", "Last seen at"). `slotGroup(slot)`. |
| `claims.ts` | `CLAIM_VOICES` (`narration`, `dialogue`, `thought`, `rumour`), `CLAIM_MODES` (`now`, `memory`, `hypothetical`, `dream`), `CLAIM_STATES`, `CLAIM_PROOFS` (P0's), the `Claim`, `Card`, `CardField` and `Reading` zod schemas, `valueKey(value)` (NFC, lower case, straightened quotes, collapsed spaces, a leading article dropped), `setsState(claim)` (narration in `now` mode only: design §2.2). |
| `sceneRef.ts` | `sceneRefs(rows)`: "14.2" for the second scene of the fourteenth chapter (chapters counted across parts as compile counts them; a scene outside a chapter takes its position or title). The panel's "since 12.1" and "last stated in 13.4" use it. |
| `gate.ts` | The reading gate (design §2.3 "When"). Paragraphs are `passageParagraphs(doc)` (`src/shared/mentions.ts`: non-empty text blocks in document order, with ProseMirror ranges), so the reader's `¶` numbers, the caret's paragraph and the name scan's `para` agree (reuse, no second numbering). `finishedSentences(paragraphs, { caretPara })` (every sentence of `splitSentences`; the caret paragraph is skipped whole while it has no closing punctuation; elsewhere a paragraph's last sentence counts as finished); `gateText(sentence, nameIndex)` (`normalizeForMatch` with every roster name and nickname span from `scanNames` replaced by one placeholder, so a rename never triggers a read); `gateHash`; `unreadSentences(current, read)`; `isCosmetic(before, after, { knownWords })` (whitespace or punctuation only, or one word changed by at most 2 characters where the old word is not a known word, P2a-D3); `readDecision(...)` → `nothing` \| `window` \| `full` with the reason (`first`, `half` when more than 50 % of the finished sentences are unread, `partials` after five window reads). Cosmetic sentences do not trigger a read and stay unread. |
| `windows.ts` | `planWindows(paragraphs, unreadParas, namingParas, tokens)`: each changed paragraph ±2, extended back to the last paragraph that names a record, merged; a window over 1,500 prose tokens split at paragraph boundaries. `planPages(paragraphs)`: full-read pages of at most 2,500 prose tokens, a longer paragraph split at sentence boundaries, never truncated. `cardDue(card, scene, unread)` (P2a-D17). `outputCap({ purpose, proseTokens, cardDue })`: 720 for a first or full-read page (600 claims + 120 card), else `min(600, 120 + ⌈0.3 × prose⌉) + (cardDue ? 120 : 0)`. |
| `literal.ts` | Literal proof in code (ladder step 3). `LITERAL_PATTERNS` per slot for the slots with plain cue words (`eyes`, `hair`, `scars`, `born`, `age`, `alive`, `location`, `clothing`, `objects`): "<Name>'s <value> <cue>", "<Name>'s <cue> was/were <value>", "<Name> had <value> <cue>", "<Name> was born in <value>", "<Name> was <value> years old", "<Name> was dead / died", "<Name> wore <value>", "<Name> carried / held <value>", "<Name> was at / in <value>". `literalProof(claim, sentence, names)` passes only when the sentence names exactly one character, the quote is outside quotation marks, and no marker is present (`markers.ts`); the displayed value is cut to words of the quote. Expect 15–30 % of claims to pass here. |
| `markers.ts` | Negation (`not`, `never`, `no`, `n't`, `nor`, `without`), modal, conditional, comparative, simile and pluperfect markers (the pattern's own "had <value> <cue>" excluded); `REPROOF_MARKERS` for the free re-proof (`dream`, `dreamt`, `remembered`, `rumour`, `said`, `if`, `imagined`, `perhaps`, `maybe`, `lied`, `not`, `never`, `pretended`, `wished`, `supposed`). |
| `reproof.ts` | Invalidation (design §2.3): `checkAnchors(claims, sentences)` → each claim `holds`, `reproved` (a literal claim whose quote is still word for word in the text, its code proof still passes, and the changed neighbouring sentences added no re-proof marker: new paragraph, new anchor) or `stale`. Card quotes get the same check (`cardStale`). |
| `reconcile.ts` | Reconciliation, pure: input = the scene's stored claims, the window read, the reader's `same`/`drop` ids and the claims that passed the ladder; output = inserts, revivals (a fresh item with its own quote replaces a stale claim's quote and anchor), deletes, merges. `same` counts only for an unchanged anchor; `drop` only for a stale claim or one whose current quote the verifier rejected; values merge by containment within one reading only ("grey" and "grey-blue" keep the longer); across scenes values sit side by side; Dismissed keys are dropped before storing; P2a-D23's stale deletion. |
| `asOf.ts` | What is true as of a scene (reading order up to and including it): `trueNow(claims, order, atId)` (lasting: the latest narration-`now` value with "since <ref>"; transient: "last stated in <ref>"); `sheetAsOf(claims, order, atId)` → fixed (every value, differing ones side by side "grey-blue · also 'grey' 2.1"), lasting, transient, accumulating, **others** (dialogue as "Mara says…", thought, rumour, memory, hypothetical, dream; never state) and a count of lines later in the book. Absence is never a line. |
| `typedVsText.ts` | Decision 4: `compareTyped(details, card, names)` → per field (`pov`, `place`, `time`, `year`) `same`, `textOnly`, `typedOnly` or `differs` (place: the card's quoted value contains the typed record's name or alias or the typed text, case and articles folded). `effectiveSceneLine` gives the text's value where it is quoted and the typed one otherwise (the v2 prompts' scene line, the Story notes block). |
| `views.ts` | The IPC shapes: `SceneMemory` (card, Here chips with why, Mentioned, True now, typed-vs-text, last read, unread, pause reason), `ClaimView`, `ClaimInfo` (quote, scene ref, ¶, proof, spot check, reading model, date and cost), `SheetMemory`, `MemoryStatus`, `MemoryNotice` (a union: `backlog`, `draftUnread`, `backfill`, `health`, `cloudCap`, `localCutoff`, `detailConflict`). |
| `health.ts` | `modelHealth(readings)` over the last 20 readings of one model: quotes found / items and verified / verify sent; judged only from 10 readings and 30 items (P2a-D16); `paused` below 90 % or 80 %. `probeDue(skipped)` (one probe read per 10 scenes while paused). |
| `dismissed.ts` (P1, extended) | `notRight` key: `recordId\|slot\|valueKey\|anchorKey` (`anchorKey` = a hash of the anchor), so a new sentence stating the same value is new evidence; `notProblem` for decision 4's *Keep mine*: `detail\|nodeId\|field\|valueKey`. |
| `passages.ts`, `sources.ts` (P1/P0, extended) | `PASSAGE_SOURCES` and `MEMORY_SOURCES` gain `card`; `MEMORY_OWNER_KINDS` gains `card`; `MEMORY_MEANINGS` gains `map` (a card is the AI's map of a scene: findable, never citable; `citesCard` already guards it). |

### 1.3 Main stores (`src/main/memory/reading/`)

| File | What it does |
|---|---|
| `claimStore.ts` | Insert, revive, stale, delete, attach (waiting → live), list by scene / record / state for the active draft (`ensureDrafts(db).activeId`; a P2a export `activeDraftId(db)` wraps it so the draft row exists before a derived row points at it), `invariantClaims(db)` mapping rows onto P0's `InvariantClaim`. |
| `cardStore.ts` | Upsert per scene and draft; card lines into the passage index (`indexOwner(db, 'card', nodeId)`: line and gist as source `card`, canon `notCanon`). |
| `readingStore.ts` | Insert a reading with its yields; `lastReading(nodeId, draftId)`; `recentReadings(model, 20)`. |
| `sceneReadStore.ts` | Read and update `scene_read` (cumulative read set, partials, full time). |
| `anchors.ts` | The local `anchors` job (§1.4): one scene's sentences, `checkAnchors`, writes stale / re-proved / holds, re-checks waiting claims whose shared alias the name scan now resolves (P2a-D22), runs `checkMemoryInvariants` for the scene, and self-heals a violation (the claim goes stale; `memory.invariant.<kind>` counted in diagnostics, P2a-D19). |
| `views.ts` | `sceneMemory(db, nodeId)`, `sheetMemory(db, recordId, asOf)`, `claimInfo(db, claimId)`, built from the stores and `asOf.ts`. Here = the typed POV (or the card's where it differs, with the typed one dimmed), on-page characters (`present` with a verified quote) and *+ also here*; Mentioned = certain name mentions minus Here (P2a-D21). |

### 1.4 Hooks into P1 code (each v2 only)

| Where | Change |
|---|---|
| `JobKind` (`src/shared/jobs.ts`) | Gains `anchors` (local, on the mention queue), and `read`, `rebuild`, `spotCheck` (the reader queue, slice 3). |
| `documentsWritten` (`handlers.ts`) | Takes `origin: 'editor' \| 'bulk'`; in v2 every write touches `anchors` beside `names` and `passages`. Slice 3 uses `origin`. |
| `renameStore.ts` `applyRename` / `undoRename` | In the same transaction: claim and card quotes rewritten with the same replacement, anchors recomputed from the new sentences, `scene_read` texts rewritten (gate hashes do not move: names are out of them); the undo record holds the old rows (F-16.13: "P2a adds claim quotes and anchors"). |
| `recordStore.ts` `sameAs` | Re-points `claim.record_id`, `object_id`, `speaker_id`, `card.present`, `memory_backfill`. `splitRecord`: claims whose `subject_text` norm is one of the moved aliases move; pronoun claims stay. Both mark the roster for a rebuild (§2.5). `deleteRecord`: claims cascade; `present` entries are filtered at read time. |
| `draftStore.ts` (switch, revert, duplicate) | Nothing moves: rows are keyed by draft, so switching back to a draft whose anchors hold costs nothing. Slice 3 hooks the backlog. |
| Tree delete / move | A deleted scene's rows cascade; a moved scene's claims re-date for free (order is computed at read time). |

### 1.5 Tests

- `slots.test.ts`, `claims.test.ts`, `sceneRef.test.ts`.
- `gate.test.ts`: finished sentences; the caret rule; names out of the hash (a renamed scene reads as unchanged); the cosmetic skip (whitespace, punctuation, a 2-letter typo fix, a real word change that is not cosmetic); first / half / partials.
- `windows.test.ts`: ±2, extension back to a naming paragraph, merging, the 1,500 split, 2,500 pages with a long paragraph split at sentences, output caps, `cardDue`.
- `literal.test.ts`: every pattern, and each blocker once (two names, inside quotation marks, negation, modal, conditional, comparative, simile, pluperfect); every `expect: literal` claim of `TEST_BOOK_LABELS` passes and every `expect: verified` or `reject` one does not.
- `reproof.test.ts`: an edit beside a literal claim keeps it live with a new anchor; a marker word added beside it stales it; a verified claim goes stale.
- `reconcile.test.ts`: same, revive, drop, merge by containment, side by side across scenes, Dismissed keys, P2a-D23.
- `asOf.test.ts`: since / last stated, a later scene ignored, dialogue never sets state, a dream death never sets `alive`.
- `typedVsText.test.ts`: each field's four outcomes.
- Store tests, the anchors job, and the hooks: rename rewrites quotes and anchors and its undo restores them; `sameAs` and split re-point claims; `checkMemoryInvariants` clean after each operation (P0's `aliasClash`, `anchorMissing`, `anchorEmpty`, `unproved`, `unreadableSource`).
- `migrate.test.ts` as §1.1.

**e2e:** none (no UI path and no request yet). **Ticks:** none; F-16.16 and F-16.17 note the data layer.

### 1.6 Built (2026-10-12): notes for the later slices

- **The gate** (`gate.ts`) replaces each roster name span, context-free, by `⟨record ids⟩` (not one placeholder): a rename is no change, a swap of people is. `scene_read` keeps the normalised text with the names in; `readSetOf(entries, names)` hashes it again under today's roster, so a record added later changes nothing (the back-fill stays the only way new names cost). `readDecision` takes `staleParas` (paragraphs of stale claims) and answers a window with reason `stale` when nothing else changed; a window's paragraphs include the cosmetic ones. `nextReadSet(previous, current, readParas | 'all')` gives the new read set: slice 2 passes every paragraph the pieces sent (`piecesParas`).
- **Literal proof** (`literal.ts`) takes the claim (with its `objectId`), `{ paragraphs, p, span }` (the scene's paragraph texts and the sentence's span, so a quotation opened earlier in the paragraph or left open in the paragraph before counts) and `sentenceNames(paragraph, span, mentions, kindOf)`; it proves only narration in `now` mode; a marker anywhere in the sentence (a `?` included) fails it (the design's rule; review 2026-10-12); the words between a possessive or "had" and the cue are modifiers only; an age or a death must end its clause; traits have no pattern (the verifier decides) and a kinship claim with an object is never proved in code; "died" proves nothing. The test book's labels were relabelled to match (5 `literal` → `verified`, the two traits too). `cutValue` is exported (typed-vs-text reuses it). `quote.ts` `locateInText` is the one single-text locator. QUESTIONS 2026-10-12 "P2a slice 1 review".
- **Anchors** hold *in place* (`anchorInPlace`: the run of the quote's sentences ±1 consecutive and in order); a pronoun claim's naming sentence outside the run is appended to the anchor marked `@` (`anchorFor(…, namingSentence)`, `NAMING_MARK`) and must stand before the run. `checkAnchors` answers `holds`, `moved` (the quote's paragraph now; the anchors job writes `para`, and moves the card's `p` with `cardParas`), `reproved`, `stale`, or `restored` for a stale claim whose anchor holds in place again (back to `live`, or `waiting` for a subject wait). Subject waits are judged too (stale when their sentences change; a reading over them then drops them, P2a-D23). The anchors job parks a non-readable scene's live claims as stale without counting them (`parked`) and restores them once it is readable; `queueMemoryIndex` queues `anchors` for every scene whose passages relabel (Idea status, compile inclusion).
- **Reconcile** keeps shared-alias waits (`subject_text` set) through a full read; the anchors job attaches them (P2a-D22). It revives only a stale claim with a record (never a wait); a subject wait's identity includes its sorted candidates and name span; a fresh item that restates a stored live or waiting claim word for word is not stored again and protects it from deletion. `same` and the positional check take the scene's hashes in order (`hashes`). Slice 2 must fill each fresh item's `stating` (the gate texts of the quote's own sentences): Not right keys on it (`statingKey`, record tokens folded), so a rename, a merge or an edit beside it keeps a dismissal.
- **Cards** keep `seen` (the gate hashes of the finished sentences they were made from, migration 0034 regenerated before shipping); `cardDue({ card: { anchor, seen }, full, present, finished })` counts what changed since the card. `readDecision` takes `cardStale` (a cosmetic edit under a card quote still reads) and never treats a changed number as cosmetic. Slice 2 writes `seen` with each card and inserts a reading's claims in text order (`asOf` breaks ties inside a paragraph by the quote's offset, which main computes, then by insertion).
- **Stores:** `claimStore` (`insertClaims` computes `value_key`), `cardStore.upsertCard` (indexes the active draft's card), `readingStore`, `sceneReadStore.writeSceneRead` (partials +1, reset on full), `views.ts` (`readingOrder`, `sceneMemory`, `sheetMemory`, `claimInfo`); `claimFixture.ts` stores claims as the pipeline will (tests only).
- **Roster:** `reading/roster.ts` holds `MEMORY_ROSTER_KEY` and `markRosterForRebuild` (drops the row); rename, restore, merge, split and delete call it. Slice 2 builds the row and must still detect additions and removals made through `record:setAliases` by comparing.
- **Not right keys** no longer need rewriting on a rename (they key on the stating sentences with names folded); a rename's value change still changes the value key ("waited for Hesk"), which slice 4 may rewrite in `rewriteEvidence` if it matters.
- **Views:** `readingOrder` numbers compiled chapters and readable scenes only and names Idea or left-out scenes by title; `ReadingOrder.at` places every manuscript scene for "as of" (an unreadable one as of the readable scene before it); `sheetAsOf` for a node outside the book shows nothing as current (all later) and `asOfRef` is null. A card POV whose record is gone counts as none (the typed POV stands); typed-vs-text counts a place or time only when its value is words of its quote or verified.
- **Rename in book** locates each quote in the scene before rewriting (a paragraph added above since the last anchors run no longer misleads it), rewrites the card POV's quote, and its undo restores another draft's evidence only with that draft's text. Open item (QUESTIONS): an undo refused in the open editor leaves that scene's evidence on the old name until it is read.
- **Diagnostics:** `memory.invariant.<kind>` counters ship with this build; the Worker must be deployed from it before a release that carries them (`docs/OPERATOR-SETUP.md` in slice 5).

---

## 2. Slice 2: `reader.v1`, `verify.v1` and the reading pipeline (F-16.17; Read now for F-16.16)

### 2.1 Feature ids and plumbing

| Change | File |
|---|---|
| `AI_FEATURE_IDS` gains `reader` and `verify`. Each needs an `AI_COST_NOTES` entry (compile), an `AI_DATA_SHARING` row (compile), budget lines and a default toggle (on). | `src/shared/ai.ts`, `aiCostNotes.ts`, `aiSettings.ts` |
| `FEATURE_BUDGETS`: `reader` 720, `verify` 400. `FEATURE_INPUT_BUDGETS`: `reader` 6,000, `verify` 3,000. | `src/shared/ai.ts` |
| `NO_REASONING_FEATURES` gains `reader` and `verify` (so Cloud sends `reasoning: 'off'`, OpenRouter `{ enabled: false }`). `request.test.ts`'s table-driven Cloud test adds both (P0 §1.2). | `src/main/ai/request.ts` |
| The OpenAI adapter's lowest `reasoning_effort` on a direct OpenAI key (`minimal` for `gpt-5`, `none` for `gpt-5.1` and later, `low` for the o-series, nothing for any other model), sent only for the story-memory requests (`reader`, `verify`, `planLinks.v2`), so a v1 request leaves as before (P2a-D15). A local server that answers empty with `finish_reason: length` raises `localCutoff` (slice 3 pauses on it). | `src/main/ai/providers/openai.ts`, `CompletionRequest` |
| The planned rows `reader.v1:first`, `reader.v1:window`, `reader.v1:card`, `verify.v1`, `verify.v1:spot`, `verify.v1:pro` move from `PLANNED_COST_NOTES` to `SHIPPED_PLAN_ROWS` with their fixture sizes; `plannedRow` in `switchover/plan.ts` reads both lists, so the switch-over's rebuild price keeps working; `report.test.ts`'s task totals still hold (index ≈ 12¢, session ≈ 1.3¢). | `src/shared/aiCostNotes.ts`, `src/main/memory/switchover/plan.ts` |
| Data sharing, one row per id (design §2.6). `reader` ("Story memory reading"): "The paragraphs of a scene you changed, with two either side (the whole scene on its first read), numbered; its place in the book; its typed POV, place, time and year; its current card; one line per record (name, nicknames, kind); and the facts already read near those paragraphs with their quotes. Sent when you leave a scene, pause for the minutes you set, press Read now, or rebuild. Never notes, Research, Pinned, Ideas, chats, other drafts, Idea scenes or scenes left out of compile." `verify` ("Story memory check"): "For each fact a reading proposed that code could not prove: the fact, the names it might be about, and its sentence with one either side (and the sentence that names the person a 'she' or 'he' points to); for spot checks, three sentences either side." | `src/shared/aiSettings.ts` |
| Toggles: in v2 Settings shows one grouped switch, **Story memory reading**, that writes `reader` and `verify` together (`FEATURE_GROUPS`); v2's list hides the v1-only ids (`tags`, `summary`, `continuity`, `organise`, `todo`, `sheetSync`) and v1's hides `reader` and `verify` (P2a-D24). The data-sharing table keeps one row per id. | `src/shared/aiSettings.ts`, `AiDialSection.tsx` |

### 2.2 `reader.v1` (fast tier, JSON, reasoning off on every route, input cap 6,000)

| Part (in prompt order) | Budget | Cached |
|---|---|---|
| System: rules, the slot vocabulary with groups and detail labels, voices and modes, the answer schema. The opening sentence is the e2e fake's sentinel: "You are the story-memory reader inside a novel-writing app." | ≤900 (golden asserts) | yes |
| System: the roster (§2.5), one line per record: `r12 Mara Vell (Mara; Captain Vell) · character`, additions appended `r12 +Ry`. Characters, places, things, groups and terms ≤1,200, least-named dropped first (the code gate still covers them); 400 held for P2b's secrets and threads. | ≤1,600 | yes |
| User: position ("Scene 14.2 'The Quay', page 1 of 2, whole scene" or "changed paragraphs"), typed POV, place, time and year, the current card | ≤200 | no |
| User: live claims near the window (records named in the window: their fixed and lasting values, newest first) | ≤400 | no |
| User: claims anchored in the window and stale ones there, with ids (`c7 r1 location "at the quay" ¶3, re-checking`) | ≤250 | no |
| User: the window, paragraphs numbered `¶3 …` (pages ≤2,500, window pieces ≤1,500); "Card: yes" or "Card: no" | ≤2,500 | no |

Trimming before sending (token rule 8): the near-claims block first, then the anchored block, never the window or the roster.

**Answer** (short keys, rule 6): `{"c":[{"p":3,"r":"r12","s":"eyes","v":"grey","q":"…","voice":"narration","sp":null,"mode":"now","o":null,"chg":false}],"n":[{"n":"Hesk","p":4,"q":"…","c":[…]}],"same":["c7"],"drop":["c9"],"card":{"line":"…","gist":"…","where":["the quay",3,"…"],"when":[…],"pov":["r12",1,"…"],"year":[…],"flash":[false],"elapsed":[…],"present":[["r12",2,"…"]],"mood":"…","theme":"…"}}`. A new name carries its claims in `n[].c`, which wait (§2.4). `knows` and `thread` items are refused until `reader.v2` (P2b).

**Caps:** a first or full-read page 720 (600 claims + 120 card); a window `min(600, 120 + 0.3 × prose tokens)`, plus 120 when a card is due. A reply cut off at the cap is parsed up to its last complete item (`salvageJsonItems`, a small tolerant reader over the `c` and `n` arrays); only the paragraphs after the last one quoted are read again, once (purpose `retry`); the reading's `finish_reason` is `length` and the ledger's rate shows in Settings › AI › Story memory.

### 2.3 `verify.v1` (fast tier, JSON, reasoning off, one batch per page)

- System: rules (supported means the sentences state it about that person, as written; a wish, fear, dream, memory, lie or rumour is supported only with that voice and mode), the schema. Sentinel: "You are the fact checker inside a novel-writing app."
- User: numbered items, each the subject candidates (roster lines), slot, value, voice, mode, the quote's sentences ±1 and, for a pronoun subject, the antecedent span back to the last sentence that names someone; then the card checks (POV, year and flashback with their quotes, which feed computation) and on-page presence checks (`r12` on the page here?). Never the whole scene. A batch over 2,500 tokens is split.
- Answer: `{"v":[{"i":1,"ok":true,"r":"r12","voice":"narration","mode":"now"}]}`; `max_tokens` = `min(400, 20 + 28 × facts + 12 × card or on-page items)` (review 2026-10-12: 15 per item cut real replies short), and a batch is also split so its verdicts fit the 400 (about 13 facts).
- A claim is stored only when `ok` with its subject, voice and mode confirmed (the verifier's subject, voice and mode win over the reader's).
- Spot checks reuse the version: the fast check of literal claims in batches of 10; the strong check one claim per call with three sentences either side, `max_tokens` 40 (P2a-D8).

### 2.4 The pipeline: `runReading(db, deps, { nodeId, purpose, caretPara, requestId })` (`src/main/memory/reading/pipeline.ts`)

1. **Gate** (`readDecision`): nothing unread → `{ read: false }` with no request.
2. **Plan**: windows or pages (`planWindows` / `planPages`); the card due or not.
3. **Prompt**: `buildReaderPrompt` from the cached roster row, the scene head, the near and anchored claims, the numbered window. Context hash over every message, so an identical request answers from the local cache (rule 4).
4. **Request** through `runAiRequest` (feature `reader`, tier `fast`, `json: true`). The daily cap, budgets and ledger are the request path's.
5. **Ladder**, per item:
   1. *Presence*: `locateQuote` (3–25 words, in the window sent, in paragraph `p`, exactly once); a miss is logged with its reason.
   2. *Subject*: a name or nickname in the quote's sentence pins it (`scanNames`, the same rules as the name scan, ambiguous shared aliases included); a pronoun goes to the verifier with its antecedent span and waits when more than one named character fits; first person resolves to the typed POV only when the card's verified POV agrees (a POV the AI read never anchors a claim).
   3. *Literal proof* (`literalProof`): passes are stored `literal`; 1 in 20 of them (by claim id hash) also joins the verify batch as a spot check after a rebuild has run.
   4. *Verifier*: one `verify.v1` batch per page for the rest, the card fields and presence; stored `verified` only when supported with subject, voice and mode confirmed.
   5. Every rejection is counted by reason in the reading's yields.
6. **Reconcile** (`reconcile.ts`), drop Dismissed keys, write claims, card (FTS line), `scene_read` (read set, partials, full time) and the `reading` row (cost = reader + verify) in one transaction; push `memory:changed { nodeIds, recordIds }`.
7. **New names**: each `n` item's name goes through the twin gate (P1). A name the gate blocks against a record becomes P1's nickname question ("Is 'Ry' Rynna Falsire?"), a clear one a new-name question (it qualifies when seen once with a proved claim), a dismissed one is dropped with its claims. The claims of an asked name pass the ladder with the name as their subject and are stored `waiting` with `pending.kind = 'name'`; nothing is guessed onto the look-alike record. No record is created silently (P2a-D7).

**Waiting claims attach** when the author answers Yes (`answerQuestion` `addAs` or a nickname Yes): an anchor check first; a claim whose anchor still holds goes live, any other is read again through the ladder (a `retry` window). No: the name goes to Dismissed (P1) and its waiting claims are deleted.

### 2.5 The roster cache (`src/main/memory/reading/roster.ts`)

A settings row `memoryRoster` `{ readerVersion, ids: { recordId: 'r12' }, base: string[], additions: string[] }` keeps the cached prefix byte for byte across calls and sessions. A new record or nickname is appended (`r12 +Ry`); a removal, rename, merge, split, *Rebuild memory* or a new reader version rebuilds it. Short ids are never reused within a build of the row.

### 2.6 Channels (v2)

| Channel | Access | What |
|---|---|---|
| `memory:readNow { nodeId, requestId }` | `ai` | Flush is the renderer's; runs the scene's reading ahead of the queue (slice 3 routes it through the queue's `runNow`); answers `{ read, reason }` (`upToDate`, `paused`, `disabled`). |
| `memory:scene { nodeId }` | `read` | `SceneMemory`. |
| `memory:claim { claimId }` | `read` | `ClaimInfo` for ⓘ. |
| Event `memory:changed` | | `{ nodeIds, recordIds }`. |

### 2.7 Eval cases, goldens, the offline pipeline run, and the live planted-error run

- **Goldens:** `reader.v1.test.ts` and `verify.v1.test.ts` snapshot the messages for a first read, a window read with near and anchored claims, a card-due window, a strong spot check; assert the order (rules → roster → tail), the system prefix ≤900 tokens, the roster ≤1,600, the caps.
- **Eval cases** (`src/main/ai/eval/fixtures.ts`, from `TEST_BOOK` and `TEST_BOOK_LABELS`): `reader.v1` first read of a disguised-Austen scene, of each hard-case scene (pronoun trap, the Captain, lie, memory, negation, shared surname, time skip, dream), a window read, and the worst case (a 2,500-token page with a full roster); `verify.v1` a typical batch, the worst batch, a strong spot check. New live scoring kinds `reader` (per slot against the labels) and `verify` (ok against `expect`). `npm run eval:ai -- -u`; the commit quotes the token-report rows.
- **Offline pipeline run** (`src/main/ai/eval/memory.eval.ts`, in the `eval` project, so it runs in `npm run test` too):
  - an **oracle** provider answers each reader page with exactly the labels' claims (rejects included) and each verify batch from `expect`: every `literal` label is stored literal, every `verified` one verified, no `reject` and no negative is stored, nothing comes from the Idea scene or the inactive draft, invariants clean;
  - an **adversarial** provider plants errors: a quote not in the text, a quote in another paragraph, a repeated quote, the pronoun trap answered as one woman, a negation as a literal fact, the dream death as `alive: no` in `now` mode, the lie answered as narration, a value with words not in the quote, a cut-off reply. None may reach a live narration claim; the yields count each by reason.
- **Live planted-error run** (the merge condition, design §2.3 point 4; **cannot run in the build sessions, so it is owed by the author before the switch-over**): `MYTHSCRIBE_EVAL_LIVE=1 OPENAI_API_KEY=sk-or-… OPENAI_BASE_URL=https://openrouter.ai/api/v1 npm run eval:ai -- memory`. The same pipeline with the real provider reads every readable test-book scene (first reads, verify batches, then the 50 fast and 20 strong spot checks). Models: `MYTHSCRIBE_EVAL_FAST_MODEL` / `MYTHSCRIBE_EVAL_STRONG_MODEL`, defaulting to the OpenRouter defaults (V4 Flash, V4 Pro) when the base URL is OpenRouter (with `openRouter: true`, so reasoning goes off and the reported cost is read), else `DEFAULT_MODELS`. It stops when the reported cost passes 50¢ (about 5¢ expected on V4 Flash and Pro). **Scored per slot:** proposed, quote found, literal, verified, rejected by reason; attribution precision (the subject matches the labels); literal precision; support precision; recall per slot (reported, no bar: sheets may be thinner); twin rate (names proposed that the gate maps to an existing record, and any that would have made a twin); false alarms (negatives stored); the `finish_reason: length` rate; cost. **Pass bars** (decided by Claude, unconfirmed): quotes found ≥ 90 % and verifier pass ≥ 80 % (the health gate's bars), attribution precision ≥ 95 %, literal precision ≥ 98 %, zero claims from never-read scenes, zero live narration claims from the negatives. Output: `test-results/eval-memory/planted-<date>.md` and `.json` (no prompt text, no key); the author copies the report into `docs/research/story-memory-2026-10-11/eval/` and commits it.

### 2.8 Tests and e2e

- `pipeline.test.ts` (a fake provider): gate → nothing sent; one window; pages; card due; cut-off salvage and the one retry; the ladder's every rejection reason; pronoun waiting; new-name waiting and attach on Yes, delete on No; Dismissed keys dropped; cache hit on an identical request; yields on the row.
- `roster.test.ts`: append, rebuild triggers, the 1,200 cap dropping the least named.
- `request.test.ts`: `reader` and `verify` leave Cloud with reasoning off; `openai.test.ts`: the lowest effort only for the story-memory requests and only on a direct OpenAI key.
- `aiSettings.test.ts`: the grouped switch writes both ids; the v1/v2 toggle lists.
- **e2e** (`e2e/memory.spec.ts`, new test "story memory v2: the evidence reader (P2a)", Use AI on with an own key at the fake): the fake answers a request whose system message starts with the reader sentinel by finding `Mara's eyes were <colour>.` and `She walked to <place>.` in the numbered paragraphs and returning those two claims with their `¶` numbers (and a card whose place is the quay), and a request with the verify sentinel with `ok` and the first candidate for every item. Create Mara Vell; type "Mara's eyes were grey. She walked to the quay." in Scene 1; `memory:readNow` → a reader request left; `memory:scene` lists `eyes: grey` (literal) and `location: the quay` (verified, the pronoun through the verifier). No reader request left while typing.

**Ticks:** none; F-16.17's text notes the prompts and the pipeline, and that the live run is owed.

### 2.9 Built (2026-10-12): notes for the later slices

- **Feature ids** `reader` and `verify` (fast, JSON, in `NO_REASONING_FEATURES` and `LOWEST_EFFORT_FEATURES`: `CompletionRequest.lowestEffort` makes the OpenAI adapter send `reasoning_effort` only on a direct OpenAI key, `lowestReasoningEffort(model)`). Budgets: output 720 / 400, input 6,000 / 3,000. One grouped switch (`FEATURE_GROUPS` `storyMemoryReading`, `featureToggleItems(memory)`, `withGroup`); `MEMORY_ONLY_FEATURES` hides v1's six memory toggles in v2 and the two new ones in v1. The shipped `reader.v1:*` and `verify.v1*` cost rows moved to `SHIPPED_PLAN_ROWS` with the design's sizes (QUESTIONS "P2a slice 2", item 8); `plannedRow` reads both tables.
- **Prompts:** `reader.v1.ts` (rules + roster as one system message, `READER_SENTINEL`; the user turn: position, `Typed:`, `Card now:`, the known and anchored facts, `¶p` paragraphs, `Card: yes|no`) and `verify.v1.ts` (`VERIFY_BATCH_TOKENS` 2,500, `verifyMaxTokens` = strong ? 40 : min(400, 20 + 15 n), `verifyBatches`; the review made it 28 per fact and 12 per other item, below). Answers parse in `src/shared/memory/readerAnswer.ts` (short keys, lenient defaults, `salvageJsonItems` for a cut-off reply, `parseVerifyAnswer`).
- **The ladder** (`src/shared/memory/ladder.ts`): `resolveSubject` answers `named`, `shared` (a shared surname: a subject wait), `antecedent` (a pronoun or a description: the checker picks among the records named in the 8 sentences before, `ANTECEDENT_SENTENCES`), `firstPerson` (the speaker, else the typed POV) or `none`. Every rejection is a `LadderReject` counted in the reading's yields.
- **The pipeline** (`pipeline.ts` `runReading`) takes `purpose: 'rebuild'` (slice 3 passes it: the whole scene whatever the gate says) and `observe` (the eval's per-item events). Each request registers as `<requestId>:r<n>` / `:v<n>`; an abort of the caller's signal (`ai:cancel` on its id) cancels the one in flight and nothing is written. A local provider's cut-off returns `reason: 'localCutoff'` with the cost spent; the service answers `paused` (slice 3's health gate takes it from there). Spot checks are not run in the app yet (slice 3: 1 in 20 riding the batches, 50 + 20 per rebuild).
- **New names** need a capitalised span in their paragraph (`countNameSpans`), then wait as `pending: { kind: 'name' }`; `nameQuestions(…, { proved })` asks after one sighting when facts wait (`waitingNameNorms`); `answerNameQuestion` settles them through `waiting.ts` `settleWaitingName` (attached live when the anchor holds in place, else stale; deleted on No; another draft's attached stale).
- **Roster cache** in `rosterCache.ts` (`readerRoster(db)` → lines, `shortOf`, `recordOf`, `whoLine`); `roster.ts` keeps the key and `markRosterForRebuild`.
- **Read now:** `readerService.ts` `createReaderService({ db, settings, requestDeps, changed, questions })`; `memory:readNow` → `ReadNowResult` (`READ_NOW_SKIPS`; a disabled switch is an AI failure `DISABLED`, not a skip); `memory:scene` now carries `claims` (`ClaimView[]`); `memory:changed` is pushed after a reading that wrote. The renderer does not listen yet (slice 4).
- **Eval:** `memoryFixtures.ts` (`MEMORY_EVAL_CASES`, scoring kinds `reader` and `verify`), `memory.eval.ts` (oracle and adversarial replays over `testBook/project.ts` `buildTestBookProject`, the live run with `PLANTED_PASS_BARS`). `readingFixture.ts` is the shared fake provider of the pipeline and service tests.
- **Review fixes (2026-10-12, QUESTIONS "P2a slice 2 review"):** `resolveSubject`'s antecedent offers every character named in the 8 sentences before the quote (`namedAt`, nearest first; `naming` is the earliest, where the checker's text starts), and the proposed record only as `unnamed` (Who line `VERIFY_UNNAMED_MARK`, "not named here"; `verify.v1`'s rule lets the checker pick it only for a role); a quote with no pronoun and an unknown capitalised name (`unknownName`, over `nameSpans`) is refused; null with one candidate refuses (`unconfirmed`); a resolved pronoun's anchor keeps its pick's naming sentence. The write transaction reloads the scene (`anchors.ts` `paragraphsOf`) and runs `runAnchors` over what it wrote when the text or readability changed mid-read; reconcile takes the current hashes. A piece whose reply (or retry) does not parse stays unread; no parsed piece → only the reading row; `cacheIf` keeps unreadable replies out of the cache; `scene_read.full` is `wholeRead`. A cut reply out of paragraph order (`inOrder`) is read again whole; `reader.v1` asks for paragraph order. Card fields are placed per source piece (`place`, first page whose quote locates), present entries from every page, checks in their own piece's batch; a card only a retry gave leaves the earlier paragraphs out of `seen`. `verifyMaxTokens(items)` by kind, `verifyBatches` also by output; a cut verify batch re-asks its unanswered items once (`yields.cut`); an item with no verdict is `unanswered` (not `unsupported`, not a rejected quote, not in `verifySent`) and its paragraph stays unread. Rejected stored claims match on value, voice and mode too. First person via a speaker needs the checker's dialogue or thought. New names: `nameAsker` (shared with `nameQuestions`) plus a mid-sentence span in ¶p, else `name`; the proved route of `nameQuestions` needs one mid-sentence sighting; a name two records share runs the ladder on its owners (named, or a shared wait); `settleOwnedNames` (on `rosterChanged`, v2) settles waits on names a record now holds; `settleWaitingName` attaches stale in an unreadable scene. `MEMORY_ONLY_FEATURES.v1` leaves `summary` out until slice 3 (§3.7 adds it back). The live run adds `supportPrecision` ≥ 90 % (label's record) and an unreviewed list; its 50¢ stop holds through the spot checks.

---

## 3. Slice 3: when a scene is read, Rebuild memory and the Cloud cap (F-16.16, F-16.19, `summary.v5` off for F-16.17)

### 3.1 Triggers

| Trigger | How |
|---|---|
| Leaving a scene | `src/renderer/features/memory/readerTriggers.ts` (v2 only) remembers the last manuscript scene opened (`useTreeStore.selectedId` filtered to manuscript documents); opening another manuscript scene settles it: `flushPendingSaves()`, then `memory:settle { nodeId, reason: 'leave', caretPara: null }`. Opening the chat, the Outline, a sheet or a Research page does not (design §2.3). |
| Idle pause | A timer restarted by every save of the open scene; after `AiSettings.reading.idleMinutes` (2–5, default 3; the VibeWrite idle pattern, per project, P2a-D5) it settles with `reason: 'idle'` and the caret's paragraph index (the `passageParagraphs` entry whose range holds the selection head, over the editor's JSON: the same numbering main reads). |
| *Read now* | The footer button (slice 4) → `memory:readNow`. |
| Closing the project | Nothing waits on the network: the scene left unread is read on the next open, through the backlog check (P2a-D4). |
| Writes outside the editor | `documentsWritten(..., 'bulk')` (Replace in project, revert, a draft switch, chat bulk tools, accepted edit passes) and an open: the backlog check (§3.3). Editor saves never start a read; they only run the anchors job. |

`memory:settle` (`ai`) asks the reader service, which applies the gate (the caret rule only on `idle`, P2a-D6) and queues a `read` job when something is due.

### 3.2 The reader service (`src/main/memory/reading/readerService.ts`, `createReaderService`)

- One provider-backed queue (`createIndexQueue`, kinds `read`, `rebuild`, `spotCheck`), the summary queue's pattern: serial, rate-limited, persisted in `index_job`, paused on a hard failure (no key, Use AI off, quota, budget). It owns `jobs:changed` and `jobs:status|cancel|resume` in a v2 project; the summary queue owns them in v1. On a v2 open, leftover `summary` jobs from P1 are deleted and the summary queue is not loaded.
- Gates in order before any request: Use AI and the **Story memory reading** switch; a provider; the health gate (§3.5); the Cloud cap for unasked work (§3.6). A blocked run leaves its job queued and raises one notice; nothing is retried in a loop.
- Status and notices are pushed (`memory:statusChanged`, `memory:noticesChanged`).

### 3.3 The backlog: one queue for changes made outside the editor

`backlog(db)` lists, for the active draft, the readable scenes with unread finished sentences (local, from `scene_read`). After a bulk write (debounced 2 s) and on every open: up to 5 scenes are queued at once; more raise a `backlog` notice with the computed price ("Read 37 changed scenes: about 3¢ · Read them · Later"); *Later* leaves each scene to be read when it is next left. A draft with no `scene_read` rows at all raises `draftUnread`, priced like *Rebuild memory*. Switching back to a draft whose anchors hold queues nothing.

### 3.4 Lazy back-fill

When a record or a nickname is added (`record:create`, `names:answer`, `record:setAliases`), the scenes whose readings predate it and whose paragraphs name it get a `memory_backfill` row. Its pages are the naming paragraphs ±2 in those scenes. Up to 3 pages are queued at once (counted against the Cloud cap); more raise a `backfill` notice with the price ("Read 14 scenes for Hesk: about 0.4¢ · Read · Not now"). The row ends `done` or `declined`, so a back-fill runs once.

### 3.5 Health gate, spot checks, local cut-off

- **Health gate** after every reading: `modelHealth` over the model's last 20 readings. Below 90 % quotes found or 80 % verified, background reading pauses, with one probe read per 10 due scenes. Notice: "Story memory paused: this model's readings aren't reliable enough. Switch to DeepSeek V4 Flash · Keep reading anyway · Details" (the switch shown only where Flash is a choice: OpenRouter or Cloud; *Keep reading anyway* is remembered per model in a project settings row `memoryHealth`).
- **Spot checks:** after a rebuild, a `spotCheck` job sends 50 literal claims to the fast verifier (batches of 10) and 20 verified claims to the strong model (one per call, ±3 sentences). Afterwards 1 in 20 new literal claims rides its reading's verify batch, and 1 in 20 new verified claims waits for the next strong batch (run when 5 are due). A strong rejection deletes the claim (logged); a fast disagreement on a literal claim is counted only (P2a-D8). Settings shows "proof agreement: 48 of 50 checked", never "accuracy".
- **Local cut-off:** a local model's empty answer with `finish_reason: length` pauses reading with one `localCutoff` notice (F-16.36 keeps this until calibration).

### 3.6 Rebuild memory and the Cloud monthly cap

- **Rebuild memory** (`memory:rebuildEstimate`, `memory:rebuild`): the price first, from `estimateRebuild` over the active draft's readable scenes (P1's function, now over shipped rows), then one `rebuild` job per scene (a full read in pages that replaces that scene's claims it did not re-prove, P2a-D25), then the spot checks. A settings row `memoryRebuild { startedAt, draftId, total }` survives a close; the queue resumes. At the end, `memory:rebuildSummary` groups what changed by sheet (new lines, waiting lines, names asked about) with bulk actions: *Not right* for a sheet's new lines, *Not names* for the question group. Dismissed and everything the author wrote are untouched. On Cloud the rebuild asks with its price and is spent as asked (§ below).
- **Cloud monthly tally** (`src/main/ai/cloudTally.ts`, pure over `app-state.json` like `dailyCap.ts`): `memoryCloud { month, backgroundUsd, askedUsd, extraUsd, capUsd: 1 }`, read leniently, rolled on a new local month. The reader service adds each Cloud reader, verify and plan-link request's reported cost to `backgroundUsd` or, for work the author started or confirmed with a price (Read now, Rebuild memory, a priced backlog or back-fill), to `askedUsd` (P2a-D9). Unasked work stops at `capUsd + extraUsd` with one notice per month: "Background reading reached your $1 Cloud cap for October · Allow another $1 this month · Change the cap". Asked work is never blocked by this cap; the daily cap applies to everything. Own key and local: no cap.
- **Reconciled with `/credits`:** after `accountService.credits()` answers, `reconcileTally` raises `backgroundUsd` to the server's `reader` + `verify` spend (`periodSpend`) minus the month's `askedUsd`, when the oldest charge in the server's rolling period (`periodFirstChargeAt`) falls inside this month, so the server's figure is this month's alone; it never lowers it (P2a-D10). Another machine on the same account is caught this way.
- Channels: `memory:rebuildEstimate` (`read`), `memory:rebuild { requestId }` (`ai`), `memory:rebuildSummary` (`read`), `memory:rebuildAction { action: 'notRightAll' \| 'notNames', recordId? }` (`write`, as P1's Dismissed writes are); `cloudCap:get`, `cloudCap:set { capUsd }` (`read`, memory `any`: app-wide); `memory:status` (footer: last read of the open scene, paused reason, today's spend, "Cloud 12¢ of $1"); `memory:notices`, `memory:answerNotice { id, action }` (`ai`); `memory:health` (Details).

### 3.7 `summary.v5` off in v2

In v2: `documentsWritten` never touches the summary queue, `backfillSummaries` returns early, the knowledge conversion hold is skipped, and leftover `summary` jobs are dropped on open; `MEMORY_ONLY_FEATURES.v1` gains `summary` again, so its toggle hides in v2 only once it sends nothing there (slice 2 review). The `summary:get`, `ai:summarize` and `jobs:indexAll` channels become `v1` in `CHANNEL_MEMORY` in slice 5, once their v2 callers are gone (the scene details' summary block in slice 4, the Outline and the cork board in slice 5), so no v2 window calls a refused channel in between. `scene_summary` rows already written stay for v1 until P9.

### 3.8 Tests and e2e

- `readerTriggers.test.ts` (renderer, fake timers): leave settles the previous manuscript scene only; Research, sheets, the Outline and the chat do not; the idle timer restarts on each save and sends the caret paragraph; v1 sends nothing.
- `readerService.test.ts`: settle → gate → job; the caret rule on idle only; nothing while AI is off (paused, one notice); the backlog at 5 and at 6; `draftUnread`; back-fill ≤3 queued, >3 asked, runs once; health pause and the probe every 10th scene; *Keep reading anyway*; spot-check selection and outcomes; rebuild resume after a reopen; the summary queue untouched in v2 and unchanged in v1.
- `cloudTally.test.ts`: month roll, background vs asked, cap and the extra $1, reconcile up only.
- `indexQueue.test.ts` unchanged; `handlers.test.ts`: the v2 open drops `summary` jobs and loads the reader queue.
- **e2e** (memory.spec, invoke level): typing in Scene 1 sends nothing; opening Scene 2 sends one reader request for Scene 1; editing "grey" to "brown" makes the claim stale once the save settles (`memory:scene`, the anchors job), and leaving reads it back as brown; a Replace in project across 6 scenes raises the backlog notice with a price; `memory:rebuildEstimate` gives a price; no request carries `summary.v5`'s opening sentence in v2.

**Ticks:** none; F-16.16 and F-16.19 note what is built.

---

## 4. Slice 4: the UI (F-16.18; the footer of F-16.16 and F-16.19)

| Part | What | Files |
|---|---|---|
| Store | `memoryStore` (renderer, normalised: `claims` by id, `scenes` by node, `sheets` by `recordId:asOf`, `status`, `notices`), loaded on a v2 open, updated from `memory:changed`, `memory:statusChanged`, `memory:noticesChanged`; reset in tests (CLAUDE.md). | `src/renderer/features/memory/memoryStore.ts` |
| Here / Mentioned | **Here**: the POV (decision 4: where the card's verified POV differs from the typed one, the text's chip with "you typed: Tomas" dimmed), on-page characters (hover: "on the page: ¶2 'Mara set down the lamp'") and *+ also here*. **Mentioned**: named, not here (P1's chips, *Not a mention* kept). The heading stays "Named in this scene" until the scene has a card (P2a-D21). | `ThisScenePanel.tsx` |
| True now | Per record Here or Mentioned: lasting values "since 12.1", transient ones "last stated in 13.4"; stale lines dimmed "re-checking after you pause" (or "reading paused" with AI off, design §2.10). Each line `ClaimLine`. | `TrueNow.tsx` |
| ⓘ and *Not right* | `ClaimLine`: value, ⓘ and *Not right*. ⓘ shows the quote with *Go there* (opens the scene at the quote, the F-9.6 jump guard), "Read by AI from 14.2 ¶3 on 12 Oct", "quote checked in code" or "checked by a second AI read", the spot check, and the reading's cost. *Not right* asks which: *Not about Mara* (a record picker) → `memory:notRight` re-verifies for the picked record (one `verify.v1` call, purpose `notAbout`; supported → moves, else dismissed); *Wrong value* → a `notRight` Dismissed row, the line goes, *Undo* in Dismissed brings it back. | `ClaimLine.tsx`, `ClaimInfo.tsx`, `NotRight.tsx` |
| Needs a look | Notices (backlog, draft unread, back-fill, health, Cloud cap, local cut-off) with their actions; **Conflicts** gains the typed-detail conflict, asked once: "14.2: the text says the quay; you typed the harbour · Update my detail · Keep mine" (P2a-D13; *Keep mine* is a `notProblem` Dismissed row). The badge counts conflicts only. | `ThisScenePanel.tsx` |
| Footer | "Read 3 min ago · Read now · today 0.3¢ · Cloud 12¢ of $1 · Dismissed (n)" (the Cloud part only on Cloud); *Read now* flushes saves, calls `memory:readNow`, and says "Nothing new to read in this scene" when the gate finds nothing. | `ThisScenePanel.tsx` |
| Book tab | Cast (P1) and **Rebuild memory**: the price, confirm, progress in the activity bar (a `rebuild` activity job), then the grouped summary with its bulk actions. | `BookTab`, `RebuildDialog.tsx`, `activityJobs.ts` |
| Sheets | **From the book, as of [scene ▾]** (default: the open scene, else the end of the book): fixed, lasting, transient, accumulating, then "In other voices" muted; "3 more lines later in the book" when the picked scene is not the last. | `RecordSheet.tsx`, `FromTheBook.tsx` |
| Scene details | In v2 the summary block becomes the **card**: line and gist (captioned "the AI's map of this scene, never quoted"), where / when / POV / year with ⓘ, and the typed value dimmed where the text differs. | `MetadataPane.tsx`, `CardBlock.tsx` |
| Settings › AI (v2) | The **Story memory reading** switch; "Read after a pause of [3] minutes" (2–5, committed like the VibeWrite idle field); on Cloud the monthly cap ($0.25 steps) and this month's spend; "proof agreement: 48 of 50 checked"; the cut-off rate; health per model with *Details*. "Summarize all scenes" is hidden in v2. | `AiDialSection.tsx`, `AiSettingsTab.tsx`, `MemorySettings.tsx` |
| Indexing indicator | In v2: "Reading 3 of 12 scenes", "2 scenes could not be read", paused reasons. | `IndexingIndicator.tsx`, `indexingStore.ts` |

**Channels** (`v2`): `memory:sheet { recordId, asOf }` (`read`); `memory:notRight { claimId, choice: { kind: 'wrongValue' } \| { kind: 'notAbout', recordId }, requestId }` (`ai`: *Not about* makes one verify call); the detail conflict's *Update my detail* and *Keep mine* go through `memory:answerNotice` (the detail write through `sceneDetail:set`, P1).

**Tests:** `memoryStore.test.ts`; `ThisScenePanel.test.tsx` (Here with on-page and typed-vs-text, Mentioned, True now, stale dimming, the footer, notices and their actions, the badge counting the detail conflict); `ClaimLine.test.tsx` (ⓘ, both *Not right* choices, Undo); `FromTheBook.test.tsx` (as-of picker, groups, later count); `CardBlock.test.tsx`; `MemorySettings.test.tsx`; `RebuildDialog.test.tsx`.

**e2e** (memory.spec, continuing slice 3's project): the panel shows Mara in Here and the True now line "Mara: at the quay, last stated in 1.1"; Mara's sheet shows "Eyes: brown" under From the book with ⓘ ("quote checked in code"); *Not right › Wrong value* removes it and Dismissed (n) goes up, *Undo* brings it back; *Read now* after an edit reads it; scene details show "you typed: the harbour" dimmed beside the card's place and Needs a look holds the conflict, *Keep mine* clears it; Settings shows the reading switch and the idle field; *Rebuild memory* shows a price, runs, and ends with the grouped summary.

**Ticks:** none; F-16.18 notes the UI.

---

## 5. Slice 5: summary readers re-pointed, plan links applied automatically, final verification (F-16.20, F-16.21)

### 5.1 Re-points (v2 only; v1 sends what it sent)

| Reader | v1 | v2 |
|---|---|---|
| Beta reader | `betaReader.v1` / `betaReaderRegen.v1`: earlier summaries, quotes checked against them | `betaReader.v2` / `betaReaderRegen.v2`: earlier scenes as their card gists, labelled "a map of the earlier scenes (not quotable)"; every item quotes the current scene, checked in code against its text; an item may name the earlier scene it relates to (`ref`). Same caps; about 150 tokens less per earlier scene (P2a-D14). |
| Synopsis | `synopsis.v1` with the stored summary | `synopsis.v2` with the card (line, gist, where / when / POV) in its place |
| Scene suggestions | `notesSuggest.v3` with the stored summary | `notesSuggest.v4` with the card in its place (P1-D7) |
| Story map (`storyMapItems`, What next, the agent) | the first sentence of each summary | each scene's card line; `STORY_MAP_SENDS` gets its v2 text |
| Scene steer (F-14.13) | `buildSceneSteer` from the scene's tags, plus the summary card's mood | the tone, content and theme labels are already lines of the Story notes block (P1); the mood now comes from the v2 card (the block's Mood line, below) |
| Scene mood (rewrite, edit passes) | `buildSceneMood` from `scene_summary.card` | from the v2 card's mood and theme |
| Story notes block (every v2 prose prompt) | — | gains each Here record's live lasting values (narration, now), this scene's transient values, and the card's mood; the effective scene line (text over typed, decision 4). Data inside the existing v2 versions, no new versions (P2a-D11); rewrite and edit passes take the block without the mood line, since they carry their own mood slot. `STORY_NOTES_SENDS` names the values read from the prose. |
| The chat agent in v2 (`agent.v8`) | — | tool outputs only (no prompt change): the open document's summary line → its card line and gist; `lookup`'s "Last seen" and `cards` → v2 cards; `read_summary` → the gist labelled "a map; read the scene to quote it". |
| Outline and cork board | the summary in grey where no synopsis | the card line in grey where no synopsis; a planned card with no link to a drafted scene reads **Not yet drafted** |
| Wizard text | "When you pause typing it summarizes the scene…" | in v2: "When you leave a scene or pause, it reads what changed and notes what your prose states, each line with its quote." (`app:info` gains `newProjectMemory`, so the wizard knows) |
| Activity and indicator | summaries | reading (slice 4) |

Then `summary:get`, `ai:summarize` and `jobs:indexAll` become `v1` in `CHANNEL_MEMORY` (§3.7).

### 5.2 Plan links applied automatically (decision 2, F-16.21)

- **Code first** (`src/shared/memory/planMatch.ts`, pure): for each open planned card (a planned scene with no author link and no AI link to a drafted scene), score every drafted scene: content-word overlap between the plan's title and synopsis and the scene's card line, gist and title, plus records named in both (the name scan). **Unambiguous** (top score ≥ 0.35 and at least 1.5× the second) → applied as an `origin: 'code'` row. The thresholds are tuned on fixtures and logged in `QUESTIONS.md`.
- **`planLinks.v2`** (fast, JSON, reasoning off through `NO_REASONING_PROMPTS`): only for an ambiguous top two, only when the reading changed the card's `line_hash` of one of them, cached by context hash, at most one call per reading. Input ≤1,500 tokens: the plan's title and synopsis and the two scenes' titles, card lines and gists; answer `{"pick":"S1"|"S2"|"none","why":"…"}`, `max_tokens` 100. Sentinel: "You are the plan-link feature inside a novel-writing app, choosing which drafted scene fulfils one planned scene."
- **Stored apart** in `plan_link` (derived; never scene meta), shown in the Outline with an AI mark, *Keep* (writes `fulfilledBy`, the author's from then on) and *Unlink* (deletes the row and writes an `unlink` Dismissed row, so the pair is never linked again). Links the author confirmed stay the author's. Structure-template beats stay the author's in v2 (P2a-D12).
- `planLinks:get` and `planLinks:unlink` branch by memory; `planLinks:keep` is new (`v2`); `planLinks:run`, `confirm` and `dismiss` become `v1`. The v1 job never runs in v2.

### 5.3 Prompts, registry, data sharing

Five versions: `betaReader.v2`, `betaReaderRegen.v2`, `synopsis.v2`, `notesSuggest.v4`, `planLinks.v2`; with slice 2's `reader.v1` and `verify.v1`, P2a ships 7 (the design's 6 plus the beta reader's regenerate twin). Each with a golden test, eval cases (synopsis and notes with a card, the beta reader with gists and a quote that must come from the current scene, plan links with an ambiguous pair), `aiCostNotes.ts` sizes (the planned `synopsis.v2`, `notesSuggest.v4` and `planLinks.v2` rows move to `SHIPPED_PLAN_ROWS`), and `sendsV2` rows for `betaReader`, `synopsis`, `notesSuggest`, `planLinks`, `whatNext` and `agent` (the map line), plus the new `STORY_NOTES_SENDS`. `npm run eval:ai -- -u`; the commit quotes the token-report diff, including the Story notes fixtures that gained values (P2a-D11).

### 5.4 Tests and e2e

- `betaReader.test.ts` (v2: gists sent, an item quoting an earlier scene dropped, one quoting the current scene kept); `sceneSuggest.test.ts` (v2 sends the card); `storyTime.test.ts` (map lines from cards in v2, summaries in v1); `sceneMood.test.ts`; `storyNotes.test.ts` (values, transient lines, mood, trimming order: Here values before Pinned, never dialogue as fact, never an absence); `agentTools.v2.test.ts` (cards in tool outputs); `planMatch.test.ts`; `planLinks.v2.test.ts` (one call per reading at most, cache, Keep, Unlink to Dismissed); `channelAccess.test.ts` (the summary and v1 plan-link channels refuse in v2).
- **e2e** (memory.spec): the Outline shows Scene 1's card line in grey (no synopsis); a planned scene "Mara at the quay" gets an AI link with *Unlink*, and *Unlink* adds an unlink row to Dismissed; a synopsis suggestion's request carries the card (the `synopsis.v2` sentinel) and no "Stored summary"; the beta reader's request lists earlier scenes as the map.

### 5.5 Final verification and ticks

Full gates on the last commit (typecheck, lint per folder, test, test:e2e: `memory.spec.ts` beside the unedited v1 smoke, eval:ai). Then tick F-16.16 to F-16.21, each naming the author's checks still owed in a development build (`MYTHSCRIBE_STORY_MEMORY=v2 npm run dev`), and record in F-16.17, the M8 row and `CLAUDE.md` "Next up": **the live planted-error run is owed by the author before the switch-over** (the merge condition; command in §2.7), as is live fidelity for the 7 new versions. `docs/ARCHITECTURE.md`: one bullet per slice ("Story memory v2: evidence data", "the reader pipeline", "reading triggers, Rebuild memory and the Cloud cap", "This scene, sheets and cards", "re-pointed readers and plan links"). `docs/OPERATOR-SETUP.md`: nothing to deploy (the Worker accepts the new ids since P0; `reader` and `verify` run fast with reasoning off).

---

## 6. Costs (own key, list prices: V4 Flash $0.14 in / $0.28 out per million tokens; Cloud × 1.25)

| What | Requests | Tokens (in / out) | Own key | Cloud |
|---|---|---|---|---|
| A window read when she leaves or pauses | `reader.v1` + `verify.v1` | 4,000 / 300 + 1,300 / 110 | ≈ 0.09¢ | ≈ 0.11¢ |
| A first read of one scene | `reader.v1` + `verify.v1` | 3,800 / 520 + 1,300 / 110 | ≈ 0.09¢ | ≈ 0.11¢ |
| A 2-hour session | ~12 window reads, ~3 cards, ≤2 plan-link calls | 73k / 6.5k | ≈ 1.3¢ (up to 2.5¢ hopping between scenes) | 1.6–3.1¢ |
| *Rebuild memory*, 90 scenes | 90 pages × 2, 50 fast + 20 strong spot checks | 490k / 61k Flash; 14k / 0.8k Pro | ≈ 12¢ | ≈ 15¢ |
| *Not about Mara* | one `verify.v1` | ~400 / 20 | ≈ 0.01¢ | |
| Synopsis, notes, beta reader | as v1, the card or gists in place of the summary | v1 or less | as today or less | |
| A busy month of background reading | 20 sessions | | 26–50¢ | ≈ 30¢, under the $1 cap |

The computed figures come from the registry (`npm run eval:ai -- -u` regenerates `docs/AI-COST-REGISTRY.md`); `report.test.ts` keeps them within ±30 % of design Part 5. Storage: claims, cards and read sets add 2–4 MB per novel in `project.db`.

---

## 7. Decisions this plan makes (decided by Claude, unconfirmed; logged in `QUESTIONS.md`)

- **P2a-D1.** One `reading` row per reading (all its pages), its cost the sum of the reader and verify requests; ⓘ shows that sum.
- **P2a-D2.** The read state lives in `scene_read` with each read sentence's normalised text (the manuscript stored once more, about 0.5 MB for 90,000 words), because the cosmetic skip has to compare the old sentence with the new.
- **P2a-D3.** "A word that was not in the dictionary" is read as a word that occurs nowhere else in the active manuscript and is not a record name or a project dictionary word: main has no spellchecker of its own. The live run reports how often the skip fires.
- **P2a-D4.** Closing never waits on the network; the scene left unread is read on the next open (≤5 scenes at once, more asked with the price).
- **P2a-D5.** The idle minutes (2–5, default 3) are a per-project AI setting beside VibeWrite's idle, and the timer runs in the renderer from the open scene's last save.
- **P2a-D6.** The caret rule applies only to the idle trigger; on leave, *Read now* and the backlog the caret is not in the scene.
- **P2a-D7.** No silent record creation in P2a: a new name the reader proposes becomes a P1 name question (once, even when seen once, if it carries a proved claim), and its claims wait. Silent secrets and threads are P2b's.
- **P2a-D8.** A strong spot check that rejects a verified claim deletes it (logged); a fast check that disagrees with a literal claim is only counted. Fast checks go 10 claims per call; strong checks one claim per call with three sentences either side.
- **P2a-D9.** The Cloud cap gates only unasked background spend. *Read now* and anything confirmed with a price (Rebuild memory, a priced backlog or back-fill) is spent on the author's say-so and recorded as asked. Past the cap: one notice a month, *Allow another $1 this month* or *Change the cap*.
- **P2a-D10.** Reconciling with `/credits` raises the month's background tally to the server's `reader` + `verify` spend in its rolling period minus the month's asked spend, only when the period's oldest charge falls inside this month (the server's period is not a calendar month), and never lowers it.
- **P2a-D11.** The Story notes block's new lines (live values, this scene's states, the mood) are data inside the existing v2 prose versions, not new versions; the eval fixtures gain them and the token-report diff is quoted. The alternative is 11 new prose versions.
- **P2a-D12.** v2 plan links cover planned scenes only; structure-template beats stay the author's. AI links live in `plan_link`, never in scene meta; *Keep* makes one the author's.
- **P2a-D13.** The typed-detail conflict (*Update my detail · Keep mine*) ships with F-16.18 in P2a, since decision 4 shows both values there; F-16.29 keeps book against book, notes, Research and loose ends. `FEATURES.md` F-16.18 and F-16.29 are updated in slice 4.
- **P2a-D14.** The v2 beta reader's items quote the current scene only (the one manuscript text sent; gists are never quotable), so the regenerate prompt needs its own version: 7 versions in all.
- **P2a-D15.** The lowest OpenAI `reasoning_effort` goes only on the story-memory requests; F-16.31 widens it to every request that asks for no reasoning.
- **P2a-D16.** The health gate judges a model only after 10 readings with at least 30 items; *Keep reading anyway* is remembered per model per project.
- **P2a-D17.** A card is due on a first or full read, when a card quote's sentence changed, or when a quarter of the scene's finished sentences are unread since the card was made.
- **P2a-D18.** The six features are ticked after slice 5's final verification, each naming the author's checks still owed, as P1 was; F-16.17's live planted-error run is owed before the switch-over and recorded in `FEATURES.md` and `CLAUDE.md`.
- **P2a-D19.** An invariant violation found on save demotes the claim (stale) and counts `memory.invariant.<kind>` in diagnostics; tests assert there are none.
- **P2a-D20.** The gendered-title rule for shared aliases stays deferred: the closed slot list has no gender.
- **P2a-D21.** "Named in this scene" stays the heading until the scene has a card (the AI-off form of design §2.10); then Here and Mentioned.
- **P2a-D22.** A claim waiting on an ambiguous shared alias attaches when the name scan later resolves the span (the anchors job re-checks it).
- **P2a-D23.** A stale claim whose anchor lay wholly inside a window that was read, and that no fresh item revived, is deleted; a full read deletes every stale and pronoun-waiting claim it did not revive.
- **P2a-D24.** One grouped **Story memory reading** switch in v2 Settings writes `reader` and `verify`; each memory's toggle list hides the other memory's ids.
- **P2a-D25.** *Rebuild memory* replaces scene by scene, so a stopped rebuild leaves each scene old or new, never empty; other drafts' rows are untouched.

## 8. Gates, ticks, docs, and what P2a does not do

- **Gates per slice:** typecheck, lint per folder, test, test:e2e (`memory.spec.ts` and the unedited smoke), eval:ai. Slices 2 and 5 run `eval:ai -- -u` and quote the token-report diff. No live run is possible here; the live cases and the planted-error run are built for the author (§2.7).
- **Ticks:** none in slices 1–4 (progress notes in the F-16.x text); F-16.16 to F-16.21 after slice 5's final verification (P2a-D18).
- **Docs in the same commits:** `docs/ARCHITECTURE.md` (one bullet per slice), `docs/AI-COST-REGISTRY.md` (2, 5), `QUESTIONS.md` (each slice's calls), `FEATURES.md` progress notes and, in slice 4, F-16.18 and F-16.29 for P2a-D13; `CLAUDE.md` "Next up" at the end.
- **Not in P2a:**
  - knows claims, secrets, threads, the timeline and ages (P2b: `reader.v2`, `verify.v2`);
  - instant cards, the navigator, `agent.v9`, `cite.v1` and Research for Ms Scribe (P3);
  - `judge.v1`, findings, underlines, *Check the book*, the other conflicts and loose ends (P4);
  - the in-place switch-over (F-16.31), which wires P2a's *Rebuild memory* into the flow;
  - embeddings (P8) and local-model calibration (F-16.36).
- **Risks:**
  - The prompts' real yield is unknown until the author's live run. The health gate, the ladder in code and the oracle and adversarial replays bound the damage: a weak model's readings pause instead of filling sheets.
  - A gate too eager reads more than the budget says; too lax, it misses facts. The cosmetic skip's rate and the reads per session are in the ledger and the live report.
  - Slices 2 and 3 are the largest. If one runs long, slice 3 can move the Cloud tally (§3.6) into slice 4, and slice 2 can move the adversarial replay into slice 3.
  - Writing `scene_read` texts doubles the manuscript's text in `project.db` (on Drive). It is small (about 0.5 MB for a novel) and rebuildable.
