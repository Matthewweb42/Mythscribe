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

## 2026-10-06 · F-12.2 · Where imported parts land in a project with content
- Question: when importing into a project that already has parts, should the imported chapters go into the last existing part, or arrive as new parts?
- Chosen: new parts after the project's own, marked New in the combined outline; the author drags chapters into an existing part (or uses Move up / Move down).
- Alternatives: pour the chapters of a file without real parts into the last existing part.
- To change it: `withExisting` in `src/main/import/existing.ts`.

## 2026-10-06 · F-12.2 · Generic documents inside a deleted part or chapter
- Question: the combined outline shows only parts, chapters, and scenes; what happens to a generic document or folder inside a part or chapter the author deletes in the review?
- Chosen: it moves to the end of the manuscript instead of being deleted with its container (nothing outside the outline is ever deleted).
- Alternatives: delete it with the container and list it in the "In your project" line; refuse the delete.
- To change it: the hidden-children step in `importDraft`, `src/main/import/commit.ts`.

## 2026-10-06 · F-12.2 · Import to start: no AI pass, format does not relabel
- Question: should the welcome screen's import offer the AI structure pass (F-12.3), and should changing the format relabel the draft's default titles?
- Chosen: no AI pass (the new project has no AI settings or key choice yet; run Import again from inside the project to use it); default titles stay as read (Part/Chapter/Scene N).
- Alternatives: offer the pass with app-wide settings; relabel `Scene N`/`Chapter N`/`Part N` when the format changes.
- To change it: `open()` in `src/renderer/features/import/importStore.ts`.

## 2026-10-06 · F-12.2 · Title lines become chapters
- Question: how strict is "a title at the beginning of a scene"?
- Chosen: a line after a scene break or a part heading, followed by prose, with no ending punctuation, an upper-case letter or digit first, at most 8 words and 60 characters, and all caps, Title Case, or three words or fewer. The file's first line counts only when the file marks no chapters itself (so a book title above Chapter 1 stays front matter). A closing "THE END" with nothing after it stays prose.
- Alternatives: also promote a short line right after a `Chapter N` heading into the chapter's title ("Chapter 1: The Return"); require all caps.
- To change it: `isTitleLine` and `promoteTitleLines` in `src/main/import/structure.ts`.
