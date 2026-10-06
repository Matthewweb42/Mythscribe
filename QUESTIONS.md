# Questions for the author

Written by Claude during unattended `/goal` runs. Each entry is a decision Claude made without
waiting (recorded in `FEATURES.md` as "decided by Claude, unconfirmed"), or a step only the author can
do. Review, then confirm, change, or delete the entry.

<!-- Entry format:
## YYYY-MM-DD · F-x.y · short title
- Question:
- Chosen: (what was built)
- Alternatives:
- To change it: (files or feature to revisit)
-->

## 2026-10-05 · F-11.2b · How birth years and ages work
- Question: where the birth year lives, which characters an event lists ages for, and how ages reach the continuity check.
- Chosen: a new character sheet field "Born (story year)" holding a whole number (exports gain a `born` column); an event lists ages for characters whose tag is on one of its scenes or who are a scene's POV; continuity sends "age N at this scene" in place of the sheet's static Age (no new reference kind, no prompt change), and an observed age whose number differs becomes a candidate.
- Alternatives: birth years kept in the timeline instead of the sheet; inline mentions counted as appearances (left to F-11.2c's logs); a separate `age` reference kind (needs a new prompt version).
- To change it: `src/shared/entities.ts`, `src/shared/timeline.ts`, `src/main/ai/continuity.ts`, `features/timeline/`.

## 2026-10-05 · F-11.2c · What counts as an appearance, and how conflicts show
- Question: what makes a character or setting "appear" in a scene, and whether the two-places-at-once conflict becomes a continuity finding.
- Chosen: an appearance is the entity's tag linked to the scene, mentioned in it (F-4.12 scan), or (characters) the scene's POV; "scenes set here" match the setting's name in Location; the conflict is shown on the character page and the timeline card only, never stored.
- Alternatives: count only explicit tag links; feed conflicts into the F-13.4 findings list (needs main-side storage and dismissal).
- To change it: `src/renderer/features/timeline/usageLog.ts`, `features/entities/UsageLog.tsx`.

## 2026-10-05 · F-11.2c · Appearances replaces the "Scenes" list on character and setting pages
- Question: the F-9.4 "Scenes" list (links and mentions) and the new Appearances log (links, mentions, POV) listed the same thing differently on one page.
- Chosen: for characters and settings, Appearances replaces the F-9.4 list and shows each scene's chapter as the old list did; world entities keep the F-9.4 list.
- Alternatives: keep both; add POV to the F-9.4 list and drop the log's reading-order view.
- To change it: `features/entities/EntityEditor.tsx`, `UsageLog.tsx`.

## 2026-10-05 · F-4.8 · Tagged ranges are a mark in the text, not stored character offsets
- Question: the spec says "ranges tracked as character offsets"; offsets stored beside the text drift whenever the author edits before them (the v0 schema's problem).
- Chosen: a `tagRange` mark in the document JSON (like the AI-origin mark), so the editor moves each range with every edit; offsets are derived when needed. Different tags overlap; the same tag over touching ranges merges; typing at a range's edge does not grow it. No migration.
- Alternatives: a `tag_range` table with offsets re-mapped on every save (drift-prone, needs a migration and a channel).
- To change it: `src/renderer/features/editor/TagRange.ts`.

## 2026-10-05 · F-4.8 · How tagged ranges show and where you tag from
- Question: "margin/overlay indicators" and the entry point were open.
- Chosen: a thin underline per tag in its colour under the text (stacked when tags overlap; hover names them) and a gutter bar beside each paragraph that holds a range; tag from the editor's right-click menu ("Tag selection…", "Clear tags in selection") or the shortcut in the menu. Tagging also links the tag to the document; clearing ranges keeps the link. Manuscript documents only; export and the compiled preview ignore ranges.
- Alternatives: background tint instead of underlines; a toolbar button; clearing a range also unlinks the tag when no range or mention remains.
- To change it: `TagRange.ts`, `DocumentEditor.tsx`, `src/renderer/styles/app.css`.

## 2026-10-05 · F-2.8 · Which titles offer a tag, and what accepting does
- Question: the spec names chapters, scenes, and characters; characters already get a tag on create (F-9.4). Which titles count, which category, and where the offer shows.
- Chosen: parts, chapters, and scenes only (not generic documents or section roots); never for the app's own default names ("Untitled Chapter", "Scene 1", "Part III"), a name already in the bank, or one you dismissed. The offer is a "From the title" row in that node's tag bar (documents, cork board, stacked view); Create makes a Custom tag and links it to the node, Dismiss joins the same never-propose list as F-4.12b. A new read channel `tag:dismissedNames` lets the tag bar see that list.
- Alternatives: a toast or dialog on create/rename (toasts have no buttons; dialogs interrupt); the Plot Threads category for chapter titles; no link on accept.
- To change it: `src/shared/titleTags.ts`, `src/renderer/features/tags/proposedTagStore.ts`, `src/renderer/features/editor/TagBar.tsx`.

## 2026-10-06 · F-5.13 · The book indexes itself once AI is allowed
- Question: existing text (written before AI was on, or imported) was only indexed when you pressed "Summarize all scenes", so the chat answered without summaries or story-bible facts.
- Chosen: 5 s after a project opens, the AI settings change, a key is saved, or an import commits, every scene without a current summary is queued, when the dial is at Ask or above, "Scene summaries, story bible, and tags" is on, and a key (or Cloud) is there. Scenes already current cost nothing. This spends tokens without a click (under a cent per scene on gpt-5.4-mini, once per scene until it changes); the daily cap still applies.
- Alternatives: keep it manual; ask once per project ("Index the 84 scenes written so far?").
- To change it: `backfillSummaries` in `src/main/ipc/handlers.ts`.

## 2026-10-06 · F-5.7 · The chat may answer from your sheets (query.v3)
- Question: the chat treated your character and world sheets as background only, so "What does Mara look like?" came back "not found" or "unverified" when the answer was only on her sheet; long sheet fields were cut to 120 characters, and a full sheet could be left out entirely.
- Chosen: your sheets are a source. The answer names the sheets it used, main checks them against what was sent, and the panel lists them as "From your notes" (click opens the page). Sheet values go out up to 600 characters within a 1,500-token block; when a question names nobody, the sheets of up to 3 entities the best-matching scenes name ride along. Observed facts and summaries still only orient. Costs about 30–75 more input tokens per question when there is no bible.
- Alternatives: keep sheets as orientation only; require a scene citation even when the sheet answers.
- To change it: `src/main/ai/prompts/query.v3.ts`, `src/main/ai/query.ts`, `src/main/ai/context/queryContext.ts` (`sceneEntities`).

## 2026-10-06 · F-4.11 · What a custom tag template keeps, and how it is edited
- Question: the spec says save the bank (or a selection), edit, and delete; it does not say what a template carries or what "edit" means.
- Chosen: a template is a tag-bank snapshot (F-4.9's file records): names, categories (Custom included), colors, nesting by parent name, and the mention-tracking switch. Edit is rename plus removing tags; to add tags, save a bank again. Names are unique ignoring case; up to 50 templates; they live app-wide (in app state), not in a project. Loading one skips names already in the bank, like the built-ins.
- Alternatives: names and categories only, with default colors like the built-ins; an editor that adds tags by typing.
- To change it: `src/shared/tagTemplates.ts`, `src/main/tag/customTemplates.ts`, `src/renderer/features/tags/TagTemplatesDialog.tsx`.

