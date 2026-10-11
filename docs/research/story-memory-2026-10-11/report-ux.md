# MythScribe: the author's maintenance burden and what the feedback history shows

Sources read: every entry in `QUESTIONS.md`, the change notes in `FEATURES.md`, and the commit history. The local clone is shallow (114 commits, 2026-10-08 to 10-11), so I also pulled the 100 commits from 2026-10-05 to 10-07 through the GitHub API.

## 1. Surfaces where the author looks up, curates, reviews or fixes AI data

| Surface | What the author has to do | Evidence |
|---|---|---|
| **Sidebar section picker** | Choose from up to about 20 sections. These are Manuscript, 13 built-in categories plus custom ones, Index, Threads, Outline, Timeline, Library, To do, Edits and Changes. Unused sections hide under "Show unused". | `src/renderer/features/shell/sectionList.ts:39-52,100-162`; `src/shared/categories.ts:118-324,347` |
| **Tags column** (per document) | Seven lists: Document tags (AI chips carry an "Added by AI" mark and an × to remove), Recommend suggestions, Inline tags, Mentions, Proposed tags (Create/Dismiss), Possible misspellings (Fix/Not a typo), From the title | `src/renderer/features/editor/TagsPanel.tsx:491,565,585,596,617,629,635,676` |
| **Index** (the tag bank) | "Open record" or "Make a record" per tag. Labels are listed apart. | `FEATURES.md:192` (F-9.15) |
| **Sheet** | Per-sheet Canon/Plan/Idea status; As-of scene picker; for each AI fact a status select, Hide and Go to passage; field history; "From a scene…" dating; hidden-facts list; Remove field; Relationships; Tag link; Scenes list; Age on the timeline | `src/renderer/features/entities/EntityEditor.tsx:300,322,356,409,471,526,574`; `src/renderer/features/entities/SheetFacts.tsx:60-77,186-212,291,356,415` |
| **Structured view and Blank page** | Two views of one sheet. An AI sync keeps them matching, with a bar offering Write up now / File now / Try again. | `src/renderer/features/entities/SheetSyncBar.tsx:94`; `FEATURES.md:195` |
| **Changes** | Undo or Undo run for each change, across 5 sources (reading, organise, library, chat, sync). Some undos are refused: merges, deletions, new categories, and anything edited since. | `src/shared/changes.ts:46,76,177-182` |
| **To do** | Four groups (Undefined, Contradictions, Loose ends, Gaps). Done or Dismiss per item, a pick composer, Go through one by one, and Check the whole book (manual). | `src/renderer/features/todo/TodoTab.tsx:62,184,249-263`; `src/shared/todo.ts:27-30` |
| **Review decks** | Accept/Skip/Edit on every card in Organise, the upload review, edit passes and the To do strip. The upload deck also has a review chat. | `src/renderer/features/review/ReviewDeck.tsx:66,78`; `QUESTIONS.md:114-121` |
| **Continuity view** | Findings, a fix proposal for each, and Dismiss | `FEATURES.md:228` |
| **Scene details and notes** | Location, POV and Timeline are entered by hand. Notes need a Plan/Canon/Idea pick. Synopsis is by hand, or an AI suggestion the author accepts. | `src/renderer/features/editor/MetadataPane.tsx:112-128,240`; `QUESTIONS.md:359-378` |
| **Outline, Timeline, Threads** | Plan links: Find links, then confirm or dismiss in Ask. Timeline events are kept by hand in a settings row and linked to each scene. There are two thread systems: plot-thread tags (the Outline grid) and thread records/events. | `src/renderer/features/outline/OutlineTab.tsx:252`; `FEATURES.md:210-212`; `QUESTIONS.md:145` (D6) |
| **Chat (Auto/Ask/Plan)** | Ask: Apply on every edit. Auto: an Undo per edit, and deletions or off-voice text still ask. Insertions arrive as ghost text (Tab/Esc). | `src/shared/chat.ts:26,40`; `FEATURES.md:130-131` |
| **One-off dialogs** | Conversion re-read (Update now / Later, with cost), Drive version conflict, activity drops | `QUESTIONS.md:160 (7)`, `:180` |

## 2. The same fact is stored in several places

- **Who is in a scene** is stored five ways:
  - author tag links;
  - AI tag links;
  - the mention scan;
  - the POV scene detail;
  - the scene card's "who" and the summary's cast.
- **Where and when** is stored four ways: the Location/Timeline scene details, the scene card, setting tags, and manual timeline events (`FEATURES.md:212`). Dated facts also carry time.
- **What is true about a character** is spread over:
  - the sheet's fields and its own extra fields;
  - the Blank page;
  - AI facts under each field;
  - relationship facts;
  - upload details appended to Notes as "Label: text" (`QUESTIONS.md:296-301`).
- **Threads** live in plot-thread tags (F-11.1c) and in thread records and events (F-9.14), side by side.

The sheet sync (F-9.18) exists only to keep two views of one sheet consistent. That is a symptom of the duplication, and it adds a paid AI job.

**Tags carry the whole identity layer.** A sheet with no tag never shows in "In this scene": `src/renderer/features/references/sceneEntities.ts:28` skips any entity whose `tagId` is null. Records were made only for the author's own name tags at the conversion. AI name tags got none and are not added later (`QUESTIONS.md:154`), so coverage is inconsistent.

Mentions of non-character tags match case-insensitively, so a tag named "rain" counts every rain. The documented fix is a toggle the author sets per tag (`FEATURES.md:103`).

There are about eight lists of things the app will not bring back, each changing what the AI does later:
- hidden facts;
- tags removed from a scene;
- deleted AI-made sheet names;
- dismissed proposed tags;
- To do items marked done or dismissed;
- deleted thread names;
- misspellings marked "Not a typo";
- the "Not names" tags Organise removed.

They interact in ways that are hard to predict. For example, a dismissed name would stop the AI recording facts about a re-uploaded sheet of that name (`QUESTIONS.md:102`).

## 3. What the author asked for repeatedly

1. **One place, one switch, and the chat does the work.**
   - "All AI related things should be in the AI panel … everything else can be done through the chat window" (`FEATURES.md:128`).
   - "as few switches as possible. Only one switch" (`:130`).
   - The AI "should be able to figure out what context it needs, retrieve it" (`:131`).
   - Asked for later: bulk clears from the chat (F-5.25) and "make this scene better" from the chat (F-5.26).
2. **No upkeep.**
   - Learned voice: "without the author doing anything" (`FEATURES.md:245`).
   - F-5.16 was revised so "the bible stays small enough to trust without curating" (`FEATURES.md:125`).
   - PLAN's idea that the story bible comes to the author (`PLAN.md:158-164`).
3. **Fewer confirmation steps, each with an Undo.** All of these defaults were reversed on 2026-10-10:
   - The upload review now starts with every card accepted (`QUESTIONS.md:118`).
   - The end of Organise's deck applies and closes (`:121`).
   - The sheet sync lands without Apply in every mode, including Plan (`:66`).
   - A specific edit request runs without a question (`:27`).
   - Plan answers drop the "unverified" warning (`:515`).
   - Fixes 5, 7 and 8 of the chat-tools audit were built immediately instead of waiting (`:97`).
4. **Accuracy about canon and story time.**
   - "it gave me an answer thinking that something that hadn't happened yet had already happened" (F-5.23, `FEATURES.md:132`).
   - Decision D1: the author's own text is never overwritten (`QUESTIONS.md:141`).
5. **Control over whole-book spend.**
   - The book check runs "only when you click" (`QUESTIONS.md:162`).
   - The re-read for a new prompt version asks first, with a cost estimate.
   - Mood and theme were added with no bulk re-read (`QUESTIONS.md:36-40`).
6. **Tags only for names and coined terms.**
   - "Tags should be capitalized words, and any abnormal words like memorial fragments."
   - Moods and themes are not tags: they became per-scene phrases instead (`QUESTIONS.md:108-112`).
7. **Simpler layout, asked for again and again:**
   - the tag bar moved to its own column, then the notes column was reorganised (layout 3b/3c);
   - the import review was reworked because it was "very hard to use and edit within" (`FEATURES.md:219`);
   - one List/Cards choice for every category (F-9.17);
   - the review deck kept at one size (`37b1240`).

## 4. Concrete frictions, with evidence

1. **False conflicts and duplicate names on upload.** The author reported conflicts that were not conflicts, and Apply failing on "Fathoms" because the model filed one name under two categories. It was patched with local word-by-word rules (`QUESTIONS.md:16-19`; `src/shared/contextLibrary.ts:403,409,462,745`).
2. **The AI duplicates sheets at scale.** Characters showed "28 possible duplicates" and Organise failed after about a minute (`QUESTIONS.md:185`). Organise is now up to 16 strong-tier chunks, about 4 calls per run.
3. **The author wanted to wipe the whole story bible.** They asked the chat to "delete everything in my story bible to start fresh and re-upload", and the chat ran Organise instead (`FEATURES.md:134`). That is strong evidence the AI-built bible had become untrustworthy and too much work to fix.
4. **Tags of ordinary words** ("loneliness", "dread", "river") needed a local classifier (`src/shared/tagTerms.ts:27,96`), Organise's "Not names — remove?", and a gate on what the AI may tag (`QUESTIONS.md:157`).
5. **Too many review steps.** There are four kinds of deck plus per-fact Hide and status, To do Done/Dismiss, continuity dismissals and plan-link confirms. The deck has been reworked five times in four days: `fced6b4`, `cc95a76`, `2dab51f`, `37b1240`, `59e82e2`.
6. **Hand labelling to stay accurate.** Canon/Plan/Idea has to be set on sheets, facts and notes, and sheets have an As-of picker. All of this was added because plans were being read as canon (F-5.23).
7. **Undo is not reliable.** It is refused for merges, deletions and new categories, and for anything edited since ("yours now", "has changed since… edit it by hand") (`QUESTIONS.md:156 (6)`, `:159 (4-5)`).
8. **Background jobs pile up.** One store of facts costs the following, each with its own toggle, ledger line and failure mode (`docs/AI-COST-REGISTRY.md:17-46`):

   | Job | Cost |
   |---|---|
   | Per-scene reading (`summary`) | about $0.0008 per scene |
   | Sheet sync | about $0.00046 each |
   | Plan links | about $0.00029 each |
   | Continuity | about $0.0004 each |
   | Router | about $0.00007 per chat message |
   | Chat agent | 3 calls, about $0.002 per turn |

9. **Prompt churn with accuracy unchecked.** The agent prompt is on v8 and the per-scene reading on v5 after about ten days, and live fidelity has not been run for summary.v4/v5, agent.v6–v8, todo, sheetSync and others (`CLAUDE.md`, Next up item 1). Accuracy has not been measured on real text.
10. **"Confirmed" means bulk-confirmed.** On 2026-10-10 the author accepted most open `QUESTIONS.md` entries in one pass (more than 60 "Confirmed by the author 2026-10-10" lines, `QUESTIONS.md:129-856`). The decision load is larger than the author reviews one by one.

## 5. What this means for a redesign

- The author wants a registry of names and aliases (characters, places, terms) that keeps itself up to date. The tag bank does that job today, but the author never asked to manage tags, only that they not be ordinary words. Mentions, the misspelling check, "In this scene" and retrieval all need only names and aliases, not user-facing tags.
- Each fact should live in one place: the manuscript is canon, and the author's own notes are plans. Remove the second copies (tag links next to POV, thread tags next to thread records, the two sheet views) instead of syncing them.
- Default to the AI applying changes itself with an Undo that always works, since every default change the author made went in that direction. Keep confirmation for deletions and whole-book spend only.
- A "do not bring back" list is hidden state. Keep at most one, and show it to the author.