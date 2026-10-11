# The author's answers (2026-10-11), story-memory redesign

1. Source of truth: the MANUSCRIPT is canon. If something in the manuscript contradicts the sheets, flag it and inform the writer.
2. Tags: remove tags as the identity system; keep a small set of LABELS the author picks (content warning, "needs research", tone) for filtering. The AI never creates or touches labels.
3. Worldbuilding notes/uploads: canon unless marked. Plus: each sheet has an IDEAS section the AI can read and edit but never treats as real; the author must be able to ask the AI to recall an idea they wrote down about a concept.
4. Layout: one "This scene" panel (who's here, what's true as of now, needs a look) + the chat (Ms Scribe); replaces Threads/Timeline/To do/Changes/Index as separate sections.
5. Re-reading: when the author leaves a scene or pauses 2-5 minutes; send what changed plus surrounding context (not a bare diff).
6. Contradictions: a quiet entry in the panel's "Needs a look" AND a soft underline in the editor (hover shows the other quote).
7. Sheets: AI-filled from the manuscript (each field with its quote, "as of" the viewed scene), mostly read-only; the author pins their own notes/worldbuilding and the Ideas section on top. One view (no two-view sync).
8. Timeline: mostly in reading order ("as of" = reading order is fine).
9. Mentions: names + nicknames only; when the AI notices a new nickname it suggests it once; the author confirms.
10. Ms Scribe always reads the whole open scene.
11. Meaning search ("where she first distrusts him"): yes, via the paid AI (no local model download).
12. "Who knows what" (secrets, clues, what each character has learned and when): CENTRAL.
13. Try things out (what-if chats, alternate drafts): never feed the memory until the author promotes them.
14. Planning: both (outline cards + discovery; cards from the draft plus the author's planned cards).
15. Series: depends on the project type the author chooses (a series project type shares the memory across books; a single novel does not).
16. Migration of the existing Drive project: keep only what the author wrote (sheet text, notes, uploads, labels); the AI rebuilds its part from the manuscript (with a backup first).
17. Cloud: background reading may spend Balance automatically up to a monthly cap the author sets; past it, ask. Own key/local: no cap needed.
18. Chat models: fast model for lookup/reading steps, strong model for the final answer.
19. With Use AI off (or a weak local model) these must still work: name/nickname index + mentions, word search, the This scene panel (who's here), the author's own sheets.
20. Accuracy test set: skipped (no gold set from the author).
21. Keep (need the per-scene reading): plot threads, timeline + character ages, beta reader / plan links, To do list.
22. Dismissed AI suggestions stay dismissed, in ONE visible list the author can undo from.
23. Uploads: filed into sheets once (the fixed review), originals stay searchable.

Standing constraints: CLAUDE.md AI rules (proposals, derived-data exception, Use AI off, per-feature toggles, cost visible, prompts versioned + eval); local-first, project.db in a Google Drive folder (working copy, F-8.1); own key (OpenRouter default, DeepSeek V4 Flash fast / V4 Pro strong; prices in src/shared/ai.ts are WRONG and must be verified), Cloud prepaid Balance at cost + 25 %, local models (F-5.15). Goal: launch as soon as possible; scope cut toward the launch line.
24. (Added by the author mid-design, 2026-10-11) Uploaded documents must be VIEWABLE AND EDITABLE inside MythScribe (as documents the author can open and change), not only filed into sheets. Being searchable and usable by the AI is a nice-to-have ("that would be cool though if it could"): design it so the AI can search and read them (e.g. same local FTS + meaning search as notes, labelled as source documents, canon unless marked like other notes), and say what it costs.
