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

## 2026-10-06 · F-5.19 · Chat router instead of native tool calling
- Question: How should the chat "act by itself" (rewrite, proofread, synopsis, …) when the provider layer and the Cloud Worker do not support tool calling?
- Chosen: a router: one cheap `fast` JSON call (`route.v1`, feature `route`, its own toggle and ledger line) picks the action, then the existing feature runs unchanged. An exact action name or a message without letters skips the call; anything unreadable falls back to plain chat.
- Alternatives: native tool calling (needs a provider-interface change and a Cloud Worker redeploy, an operator step); keyword matching only (free, but misses most phrasings).
- To change it: `src/shared/assistantRoute.ts`, `src/main/ai/route.ts`, `src/main/ai/prompts/route.v1.ts`.

## 2026-10-06 · F-5.20 · What the synopsis and notes suggestions read, and what the chat sees
- Question: What context goes into a suggested synopsis and suggested notes, and how much of the side panel does the chat see?
- Chosen: synopsis = the first 12,000 characters of the scene + its stored summary; notes = the same scene text + summary + brief + the first 1,500 characters of the current notes + the story bible + an optional focus, up to 8 points of 200 characters. The chat and Story Intelligence see the synopsis and the first 1,500 characters of the notes; Story Intelligence may not cite them. Both suggestions need 100 characters of scene text and a manuscript scene.
- Alternatives: include the voice profile (not prose, so no); send the whole notes (cost).
- To change it: `src/shared/sceneSuggest.ts`, `src/main/ai/sceneSuggest.ts`, `src/main/ai/prompts/chat.v5.ts`, `src/main/ai/prompts/query.v4.ts`.
