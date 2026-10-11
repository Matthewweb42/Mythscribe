## MythScribe knowledge model (M7 and later): map, overlaps, hotspots

Branch `claude/gallant-pasteur-sn3vn0`. F-9.11 to F-9.19, F-4.14, F-5.24 and F-5.25 are all built, but none is ticked (FEATURES.md:106,133-134,188-196). Live fidelity has not been run for summary.v4/v5, agent.v6–v8, sheetWriteUp.v1 or sheetRefile.v1, so **nobody has measured how accurate the model is on real prose.**

### 1. Data model (src/main/db/schema.ts, migrations 0002–0027)

| Layer | Tables / columns | Writer |
|---|---|---|
| Name index | `tag` :104 (kebab name, one of 7 fixed categories, `aliases`, `origin`, `track_mentions`), `document_tag` :135 (`source` author/ai), `document_tag_dismissal` :163, `tag_mention` :370 (ranges + paragraph numbers), `mention_scan` :402, FTS5 `passage_fts` (0022) | Author, background AI, local scan |
| Records (sheets) | `entity` :428 (`kind` = category id, `fields` JSON, `body` = Blank page, `aliases` only while it has no tag, `status`, `extra_fields`, `sync`), `story_category` :488 | Author, AI reading, upload, Organise, sheet sync |
| Facts | `fact` :547 (attribute/value, `object_entity_id` for relationships, `node_id` date, `quote`, `origin`, `status`, `hidden`, `fact_key`). The old `observed_fact` :512 is frozen but still converted on every open (factConversion.ts header, decision D9) | Author baseline mirror, AI reading |
| Scene level | `node.scene_meta` (synopsis, brief, location/POV/timeline, status, beats, `notesStatus` sceneMeta.ts:94-118), node notes, `scene_summary` :309 (summary, key points, characters, `card` JSON: where/when/POV/changed/mood/theme, sceneCard.ts:33) | Author, AI reading |
| Review / audit | `knowledge_change` :582 (Changes log with an undo JSON per row), `continuity_finding` :615, `todo_item` :850, `context_file` :816 | AI, local rules |

**How facts get in**
- **AI path.** One `fast` request per scene, `summary.v5`. It returns the summary, key points, cast, up to 6 facts, up to 8 tags, the card, up to 4 relationships, up to 4 thread events, plus mood and theme (summary.ts:20-66; prompt in summary.v4.ts:46-59). `applyDerivedKnowledge` (derive.ts:179) then writes facts, auto-tags, records for new name tags, relationships and threads, all logged in one Changes run.
- **Sheets for unknown names.** A fact about a name the bible lacks creates a blank, AI-made sheet on its own (observedFacts.ts:218-250). Matching uses only the exact name, an alias or the tag name (`resolveName`, :160); there is no partial matching.
- **Author path.** `writeAuthorFields` mirrors every filled field as an undated author fact (factStore.ts:194-260). "From a scene…" adds a dated author fact.
- **Other writers.** The upload (F-9.8) and Organise (F-9.10) write only after Apply. Sheet sync (F-9.18) writes on its own in every mode, 30 s after the author stops editing a sheet (sheetSync.ts:33).

**Status and as-of**
- Every sheet and fact is Canon, Plan or Idea (facts.ts:19). AI facts start as Canon, or Idea when the scene is marked Idea. Node notes default to Plan.
- `sheetAt` (facts.ts:173) is the one rule for "the sheet at scene N":
  - Short "replace" fields (age, status, alive, role…; facts.ts:67) show the newest canon value at or before scene N.
  - Every other field lists all details so far.
- "Position" means reading order, not story chronology (decision D2, QUESTIONS.md:139).

**Curation load**
- Nothing is mandatory: derived data lands without an accept step.
- In practice the author has a dozen optional review surfaces. Per field there are Hide and the status flip. Then come Changes (Undo / Undo run), To do, Continuity, and the tags column (AI chips, mentions, proposed tags, "From the title", misspelling fixes). Add the upload review deck, Organise plans (merges and deletes always ask), the conversion dialog and Story bible settings.
- Twins ("Dr. Vell" vs "Vell") and empty AI-made sheets are left for Organise or a manual merge.

### 2. Duplication and overlap

1. **Tag vs record.** Since F-9.12 every character, place or world tag has exactly one sheet (FEATURES.md:189), so for names the tag is just an index key in a second table.
   - Two `origin` flags, two alias stores (one-owner rule: an alias lives on the tag, or on the sheet only while untagged), two tombstone lists (`getDismissedNames`, `getObservedDismissed`; settingsStore.ts:356,473).
   - Two category systems: 7 tag categories vs 13+ sheet categories, bridged by `ENTITY_TAG_CATEGORY`.
   - Rename and merge propagation code: F-9.4, records.ts (239 lines), `entity:merge`.
2. **"X is in scene Y" has six sources:** author `document_tag`, AI `document_tag`, `tag_mention`, inline `#tags`, `tagRange` marks, `scene_summary.characters`, and the card's cast, which is derived from mentions, else the summary.
3. **Where/when/POV twice:** `SceneMeta.location/pov/timeline` (author) and `card.where/when/pov` (AI), plus setting tags on the scene.
4. **Scene meaning in six places:** synopsis, summary, key points, `card.changed`, notes, brief, plus mood/theme.
5. **Sheet text in up to five places:** `fields`, `body`, author-baseline `fact` rows (a mirror kept only so `sheetAt` reads one source), `extra_fields` + `sync` (AI keeps Structured and Blank page in step both ways, with a rebase on `baseModified`), and the frozen `observed_fact`.
6. **Threads in four forms:** plotThread tags, thread records, thread-event facts, and the Outline thread grid (F-11.1c).
7. **Contradictions in three:** `continuity_finding`, To do contradictions computed locally from facts, and the old "Differs" mark.
8. **About 10 tombstone and undo mechanisms:** hidden facts, tag dismissals, two name lists, proposed-tag dismissals, kept spellings, To do done/dismissed, continuity dismissed, the Changes log, Organise's and the chat's in-memory undo for notes and the binder, and the clear snapshot (clearSnapshot.ts).
9. **Five conversions on open:** fact conversion, the record conversion, thread records (handlers.ts:4299-4301), the summary re-read dialog (D11), and the first sheet sync.

### 3. Complexity hotspots

- **Size.** About 32k non-test lines across the tag, entity, knowledge, library and Organise code: main about 8.2k, renderer about 13.3k, shared about 6.8k, AI callers about 3.5k. That is roughly 21 % of `src` (152k).
- **Largest files:** contextLibrary.ts 1,099; TagsPanel.tsx 892; ContextUploadDialog 853; entityStore 838; changeLog 819; todoPass 810; OrganisePanel 685 + organise.ts 655; EntityEditor 629; factStore 624.
- **Riskiest logic:**
  - F-9.18 two-way sync (an AI reconciliation with rebase).
  - Change-log undo checks (changeLog.ts:792-819).
  - The mirror of author fields into facts.
  - Upload conflict heuristics (`relateValues`, QUESTIONS.md:15), already patched after false conflicts and an Apply that failed.
- **Prompt drift.** Version chains are frozen per version: summary v1–v5, agent v1–v8. The agent's system prompt grew from 958 tokens (v6 fresh) to 2,329 (v8) and is paid on every step (token-report.md:224,249).

### 4. Token-cost hotspots

- **Background reading (largest recurring cost).**
  - Every save queues it (handlers.ts:1032), with a 3 s debounce (summary.ts:68).
  - Each run re-sends the whole scene, up to 20k characters (about 5k tokens), plus 750–1,500 system tokens, and asks for up to 1,000 output tokens (token-report.md:235-237).
  - There is no "minimum change" or minimum-interval gate, so drafting one scene can pay for many full re-reads.
  - A background continuity check follows each reading (handlers.ts:638).
- **Sheet sync.** One fast call per edited sheet after the 30 s pause, in both directions.
- **Upload and Organise.** `strong` tier, chunked, up to 16 chunks of 6k output (FEATURES.md:187).

### 5. Accuracy gaps

**What protects accuracy now:**
- Facts, relationships and thread events must carry a quote that appears verbatim in the scene.
- Name matching is local.
- Facts are sticky.

**Weak points:**
- The quote is checked but the paraphrased value is not.
- The card is not quote-checked at all.
- Name resolution has no partial matching, which creates twin sheets.
- An AI fact about any new name silently creates a sheet.
- Before F-5.24, Plan and Idea facts reached prompts without labels.
- "As of" uses reading order, not story time.

### 6. Implications for the redesign

These follow from the map above; they are not decisions.
- **Merge tag and record into one Name/Record table** with aliases. Keep tags only as an optional label layer (tone, theme), or drop them; the per-scene mood/theme already covers that.
- **One "appears in" index.** Use the local mention and FTS index plus the author's explicit links, and retire AI scene tags and `summary.characters`.
- **One source per sheet field.** Either author fields plus dated AI facts, or a Blank page with AI-derived fields, not both kept in sync by AI calls.
- **Gate the background reading.** Read on a meaningful change (paragraph-level diff, a minimum number of characters, an idle period or a scene switch). Send only the changed paragraphs plus the card. Cap output by what changed.
- **Fold the review surfaces into one feed:** Changes, To do and Continuity become a single "Needs a look" list.