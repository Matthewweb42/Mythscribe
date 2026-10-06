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

## 2026-10-06 · F-14.14 · Learned voice (automatic exemplars and style notes)
- Question: how should the voice profile learn on its own, as asked ("scan occasionally on new stuff")?
- Chosen: a local `voice` job re-picks up to 6 automatic exemplars from the author's own paragraphs every 1,500 words of change (no AI, no cost; AI-origin text excluded, imported text included); AI-made style notes (`voiceNotes.v1`, fast tier, ≤ 8 notes) refreshed every 5,000 words once the manuscript holds 2,000, at Ask or higher with its own toggle; the notes ride inside the existing 600-token voice block (200 tokens for notes), so no prompt version was bumped. Clear empties the notes until 5,000 more words; removing an automatic exemplar remembers it. Hand-marked exemplars stay and rank first; their 12-row cap no longer counts automatic ones.
- Alternatives: re-pick on a timer instead of word counts; let the notes replace the stylometric rules; give the notes their own budget outside the voice block (a token increase on every prose prompt); a per-scene notes pass on the summary job instead of a project-level one.
- To change it: thresholds in `src/shared/voice.ts`; selection in `src/main/voice/autoExemplars.ts`; notes in `src/main/ai/voiceNotes.ts` and `prompts/voiceNotes.v1.ts`; the block in `src/main/voice/voiceBlock.ts`.

