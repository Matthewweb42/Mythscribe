## MythScribe tagging system: what it does, what it costs, and what depends on it

Branch read: `claude/gallant-pasteur-sn3vn0`. No files were edited.

**Size.** About 7.9k lines of non-test code and 4.0k lines of tests. There are 29 `tag:*`/`documentTag:*`/`tagTemplate:*` IPC channels and 5 tables: `tag`, `document_tag`, `document_tag_dismissal`, `tag_mention`, `mention_scan` (`src/main/db/schema.ts:104,135,163,370,402`). There are also two coupling columns, `entity.tag_id` and `entity.aliases` (`schema.ts:444,452`).

### 1. Component map

| Piece | What it does | Manual upkeep | AI cost |
|---|---|---|---|
| Tag bank, Manager, templates (F-4.1–4.3, 4.9, 4.11) | Kebab-case names in 7 categories, colours, parents. Merge, recolour, import/export. | Author curates categories and names, loads templates, merges duplicates | none |
| Document links / Tags column (F-4.4, `src/renderer/features/editor/TagsPanel.tsx`, 892 lines) | Chips, Add, Recommend, inline-tag list, Mentions, Proposed, From the title, misspellings, all stacked | Opening the column, adding and removing tags | none |
| Inline `#tags` (F-4.6, `InlineTag.ts`) | An atom token in the prose that stores the id plus the name at insertion time (`InlineTag.ts:12-15`) | Typing `#` | none |
| Granular ranges (F-4.8) | `tagRange` mark | Select, then Mod+Alt+T | none |
| Recommend (F-4.7, `recommendTags.ts`) | Asks for 3–8 bank tags for one scene | Click, then accept chips | `tags.v1`, fast tier, about $0.000139 per click (`docs/AI-COST-REGISTRY.md:20`). The cost note itself says it "could reuse the summary pass" (`src/shared/aiCostNotes.ts:37`) |
| Mentions (F-4.12, `src/shared/mentions.ts`, `src/main/tag/scanMentions.ts`) | Local scan for tag names and aliases after each save. Character tags must be proper nouns; other categories match case-insensitively | Turn off "Track mentions" on a noisy tag (for example a `rain` content tag) | none |
| Proposed tags (F-4.12b, `src/shared/proposedTags.ts:18,25`) | A capitalised word seen 3 or more times mid-sentence becomes a proposal | Create or Dismiss. A multi-word name is proposed one word at a time | none |
| Title tags (F-2.8, `src/shared/titleTags.ts:9-13`) | A named chapter or scene is offered as a Custom tag | Create or Dismiss | none |
| Auto-tags (F-4.13, `src/main/ai/autoTags.ts:79-141`) | Rides the scene summary call: up to 8 tags per scene, 3 of them new (`src/shared/summary.ts:33-38`). The bank line lists up to 40 tone/content/thread/custom names | Remove wrong tags; delete junk tags | Part of `summary`, fast tier, about $0.000803 per scene reading (`AI-COST-REGISTRY.md:21`) |
| Tag rule (`src/shared/tagTerms.ts:1-20`, `autoTags.ts:96-116`) | Local check that limits new AI tags to names and repeated phrases. It exists because AI tagging made ordinary-word junk | none | none |
| Aliases and misspellings (F-4.14, `src/shared/aliases.ts`, `src/shared/misspellings.ts`) | Nicknames count as the tag; "Falseer → Falsire" is offered with Fix | Author types every alias by hand (see below). Fix or Not a typo for each misspelling | none |
| Filter by tag (F-4.10, `TagFilterBar.tsx`; search in `src/main/search/searchStore.ts:114-123`) | Filters the binder and search to one tag (linked or mentioned) | Picking the tag | none |
| Tags → records (F-9.4, F-9.12; `src/main/knowledge/records.ts:95-109`, `src/shared/knowledge.ts:58-63`) | Every character/place/world/thread tag is paired with exactly one sheet. Creating a sheet creates its tag | "Make a record" button | none |
| Organise (F-9.10, `src/main/organise/organiseProject.ts`) | Sends tags, sheets and notes in chunks for a strong-tier clean-up plan. Finds look-alike and ordinary-word tags | Review and Apply | `organise.v2`, strong tier, about $0.00418 per run, 4 or more calls (`AI-COST-REGISTRY.md:43`) |

**What tags cost in tokens.** Moving from summary.v2 to summary.v3 (the version that added tags) added +116 to +138 system tokens per call, and +328 when the bank is full (`src/main/ai/eval/token-report.md:105-110`), plus about 80–120 output tokens.

The code records DeepSeek V4 Flash at $0.03 per million input tokens and $1.28 per million output tokens (`src/shared/ai.ts:590-601`). At those prices the input side is close to free, and the tag output adds about $0.0001 per scene reading, roughly 15% of a reading. In AI money tags are cheap. Their real costs are the author's attention, the Organise clean-up runs, and accuracy. The same table records V4 Pro at $0.42 per million output, which is cheaper than Flash. That looks inverted and should be re-checked (I could not reach openrouter.ai from here).

### 2. What else depends on tags

Tags have become the name index of the whole knowledge model, not just labels.

- **Mentions index → chat lookups.** `lookup` reports "Named in N scenes", plus first and last paragraph, only through `entity.tagId` (`src/main/ai/agentTools.ts:323-342`). `cards {name}` works the same way (`agentTools.ts:455-458`). Name resolution falls back to the tag's aliases (`agentTools.ts:217-222`). A sheet without a tag reports "Named in no scene yet."
- **Passage full-text index (F-9.12).** Its only writer is the mention scan (`src/main/search/passageIndex.ts:12-14`), so `find_passages` is coupled to the tag pipeline.
- **Scene card cast** comes from character-tag mentions (`src/main/knowledge/sceneCard.ts:56-58`).
- **To do list** ranks by mention counts and uses proposed tags for "Undefined: make a record?" (`src/main/knowledge/todoLocal.ts:40-47`).
- **"In this scene" (F-9.7):** "an entity without a linked tag cannot appear" (`FEATURES.md:183`). The entity's Scenes list and the dashboard tallies (`src/main/stats/dashboardStore.ts:81`) also come from tags.
- **Story-bible block in every prose prompt** (ghost text, chat, rewrite, critique, what next):
  - It sends every story-category tag name (`src/main/ai/context/storyBible.ts:50-53`).
  - It sends sheets only for entities linked to the scene's **tag links**, not to its mentions (`storyBible.ts:91-95`).
  - Bank names are admitted before those sheets and before the neighbouring scenes' summaries, inside 400 tokens (150 for ghost text) (`src/shared/storyBible.ts:16-18,124-135`). In a large book, a flat list of names crowds out the useful facts.
- **Scene steer (F-14.13):** tone, content, plot-thread and custom tags steer prose (`src/shared/sceneSteer.ts:11-16`). This now overlaps summary.v5's mood and theme, which the author asked for on 2026-10-10.
- **Continuity:** entities named in the scene, or tagged on it (`src/main/ai/continuity.ts:197-203`).
- **Summary prompt:** gets known names (tags that no entity carries) through `knownNames` (`src/main/ai/observedFacts.ts:100-123`). Its fact resolver maps names through tags (`observedFacts.ts:160-178`). New sheets made from facts get a tag through `sheetTagRule`.
- **Chat and queries:**
  - A `#name` in a chat message pulls in the notes of the documents linked to that tag (`src/main/ai/context/chatContext.ts:65-66`).
  - Story Intelligence ranking gives tags weight 4 (`src/main/ai/context/queryContext.ts:128,188`).
  - The agent has a `tags` tool plus tag edits: bulk tag, rename_tag, delete (`agentTools.ts:192,1054-1086`).
- **Other UI and data:**
  - The Outline threads grid is built on plot-thread tags (`ThreadsView.tsx:19-26`).
  - Character ages on the timeline use tag-linked characters.
  - POV and Location autocomplete come from tags (`MetadataPane.tsx:33-34`).
  - Spellcheck names include tag names and aliases (`src/main/spellcheck/projectWords.ts:17`).
  - The Changes log and the story-bible clear both have tag kinds (`src/main/knowledge/changeLog.ts:23-44`, `src/main/knowledge/bibleClear.ts:62-78`).
  - Compile has a "keep tags" option; the v0 importer reads tags.

### 3. Accuracy and ease-of-use problems found

1. **Nicknames are not learned automatically.** Aliases are added only by hand, by a merge, or by the library upload (`src/main/library/apply.ts:284`). The reading prompts do not list aliases (`FEATURES.md:106`). So "Rynna" and "Rynna Falsire" end up as two tags and two sheets until Organise, a strong-tier call, merges them.
2. **AI tags needed two guard layers** (the tag rule, then Organise's ordinary-word sweep), which shows the model invents tags. Since 2026-10-08 the AI only creates names and repeated phrases, which the free local scan and proposals already find.
3. **Inline tokens export wrong text.** Compile prints the stored insertion-time kebab name as prose (`src/shared/compileModel.ts:146-149`): "rose-marsh", and still the old name after a rename.
4. **Mismatched rules for "who is in this scene".** The bible block uses tag links (`storyBible.ts:91-95`) while continuity uses names (`continuity.ts:197-203`). A character mentioned but not tagged gets no sheet in prose prompts.
5. **Two or three systems for plot threads:** plot-thread tags, thread records, and the reading's thread events (F-9.14).

### 4. If tags were removed

**What would need replacing:**
- Re-key `tag_mention` and `mention_scan` to `entity_id`, so the record becomes the name index. `entity.aliases` already exists (`schema.ts:452`).
- Decouple the passage index from the mention scan.
- Point lookup, cards, the scene card, "In this scene", To do, the dashboard, spellcheck and misspellings at records.
- Rebuild the story-bible block from records **mentioned** in the scene, and drop the bank list.
- Scene steer: use the v5 mood and theme plus scene metadata.
- Threads grid: use thread records.
- Binder and search filter: use records or scene-card facets.
- Chat `#name` becomes a record reference.
- Organise only needs to handle sheets.
- Proposed tags become proposed records.
- Remove the agent's tag tools, which means a new agent prompt version.
- A new migration to drop the tables (shipped migrations stay as they are).
- Existing inline tokens must become plain text. That changes scene text, so it needs a backup and the author's consent.

**What tags give that nothing else does:**
- Author-chosen labels with no name in the text (tone, content warnings, a theme the author wants to steer by, "needs-research"), plus colour-coded binder filtering by those labels.
- An explicit "this scene involves X" when X is not named, for example a scene in which a character is only implied.
- Inline `#` references inside prose.

Everything else tags provide (the name index, aliases, mentions, records, AI grounding) is really a records-and-mentions job that tags are carrying.

**Conclusion.** Collapse the name index into records: each record holds its name, aliases and mentions, and is found locally for free. Keep at most a small set of author-only scene labels (no AI creation) for tone and content. Drop AI tag creation and the Recommend button.