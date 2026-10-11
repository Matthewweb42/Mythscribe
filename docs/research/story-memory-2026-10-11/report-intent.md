# MythScribe redesign brief: goals, rules, scope and drift

## 1. Stated goals and principles

- **Thesis:** "the author is the writer; the AI is the reader, the researcher, and the copyeditor." Generation is the least important feature (PLAN.md:16-18). There are three ranked promises: Voice, Intent, Control (PLAN.md:20-24). The planned wedge is Story Intelligence, cited answers about the manuscript (PLAN.md:26-29).
- **Assisted workflow (2026-10-01)** is the stated core goal and matches the author's request: "they write and keep writing; the AI does the bookkeeping behind them". The bible "comes to the author", with no flipping to notes, and facts are "few and durable" so "the bible needs no curating" (PLAN.md:137-164).
- **Vision principles** (FEATURES.md:20-29): local-first, never lose words, the editor is the product, AI assists and the author decides, novel-aware.

## 2. Rules that constrain any redesign (hard constraints)

1. **Manuscript gate.** Nothing enters the prose without an explicit accept. The one exception is chat Auto mode: it applies its own non-deletion edits, each with Undo, and deletions always ask (CLAUDE.md:62; F-5.21/F-5.22).
2. **Derived-data exception.** This is the principle that allows memory with no upkeep. Summaries, observed facts, auto tags, continuity findings and To do items may be written without asking, but only if they are stored apart, marked AI, removable, costed, and never in the manuscript (CLAUDE.md:62; PLAN.md:148-151).
3. **The author's text wins.** Sheets are ground truth over AI facts, and the author's sheet text is never overwritten (PLAN.md:151; F-9.13 "D1", FEATURES.md:190).
4. **Grounding.** Answers are cited or "not found" (CLAUDE.md:65; PLAN.md:127-131). Story time applies: an event found only in notes or plans "has not happened", and records carry [canon]/[plan]/[idea] labels (F-5.23 and F-5.24, FEATURES.md:132-133).
5. **Token rules** (CLAUDE.md:68-78):
   - `fast` for background work, `strong` only for agent, query, rewrite, critique and on-demand consistency.
   - Retrieve, never dump.
   - Stable prefix first, so provider caching applies.
   - Content-hash caching.
   - Count tokens before sending.
   - Cost recorded per proposal, and every `AiFeatureId` must appear in `src/shared/aiCostNotes.ts`.
6. **Privacy and switches.** Use AI is off at install. Own-key and local-model traffic never touches MythScribe's servers. The data-sharing panel must list every text that is sent (CLAUDE.md:22,64).
7. **Process.** Migrations are numbered and never edited (CLAUDE.md:51). The author has a live project in Google Drive (F-8.1) protected by the pre-migration backup (F-8.7). **Any redesign must convert existing data, not start blank.**
8. **Scope.** "Launch as soon as possible… Scope is cut toward the launch line, not expanded" (CLAUDE.md:24). A redesign should shrink scope.

## 3. Launch line vs what was built

- **Planned:** v1 ships after M3, with M4 and everything after it post-launch (PLAN.md:348-352; FEATURES.md:320).
- **Actual:** M-Cloud, M3.5, M4, M5, M6 and M7 were all built before launch, and launch is "on hold until the author says go" (CLAUDE.md:31).
- **Counts:** 141 features ticked, 24 unticked (FEATURES.md).
- **The unticked cluster is almost entirely the newest knowledge model (M7).** It includes F-8.7, F-9.11 to F-9.19, F-5.24 to F-5.26, F-4.14 and F-14.14. All are built but unverified by the author in the installed app. **This makes now the cheapest moment to redesign storage:** the M7 storage design has not been signed off.

## 4. Where the feature set has drifted from "low-upkeep story memory"

**D1. Tags are overloaded, and half of their job is already obsolete.** Tags currently serve four roles:
- (a) **Name and identity index.** Every character, place or world tag points at its sheet (F-9.12, FEATURES.md:189), and mention scanning keys on tag names (F-4.12).
- (b) **Labels:** tone, content, theme and custom (F-4.1).
- (c) **Generation steer** (F-14.13; ARCHITECTURE.md:90).
- (d) **Tree filter** (F-4.10).

The author's own 2026-10-08 rule already limits AI tags to names and coined terms (`src/shared/tagTerms.ts:5-20`). Since summary.v5, mood and theme are "the AI's reading, never tags" (FEATURES.md:115; ARCHITECTURE.md:92). So the system is already converging on "tag = an entity's name and aliases".

The tag surface is 15 features (F-4.1 to F-4.14) and about 5,600 lines: `src/renderer/features/tags` (2,526), `src/main/tag` (1,408), and shared tag/mention/inline files (1,721). It includes granular range tags (F-4.8), inline `#tags` (F-4.6), templates (F-4.3, F-4.11) and bulk merge (F-4.9). These are manual-organiser features, not low-upkeep ones.

**D2. Too many AI writers to the story bible, which is an accuracy risk.** Each of these is its own prompt, toggle and cost line, and each writes sheets, facts or tags:
- summary job (facts, tags, card, relationships, threads)
- context import
- review chat
- Organise
- agent edits
- sheet sync (write-up and refile)
- To do suggestions

In total there are 27 `AiFeatureId`s (`src/shared/ai.ts:295`) and 82 prompt files under `src/main/ai/prompts/`. The old `observed_fact` table is kept frozen beside the new `fact` table (ARCHITECTURE.md:29, "D9"), so there is parallel storage.

F-9.18 has the AI rewrite the sheet's "Blank page" from its fields (FEATURES.md:195). That blurs the line between author text and derived data that rules 2 and 3 depend on.

**D3. A layer of tools exists only to tidy the derived data.** Organise (F-9.10), Review chat (F-9.9), Clear the story bible (F-5.25), To do (F-9.16), the Changes log (F-9.15), aliases and typo fixes (F-4.14), proposed tags (F-4.12b) and tag merge/templates. These exist because AI-derived records need curating, which is the opposite of the stated goal. A clear signal: F-5.25 was added after the author asked the chat to "delete everything in my story bible" to start fresh (FEATURES.md:134).

**D4. The bible no longer "comes to the author".** The sidebar picker now lists Manuscript | Story bible (+Index) | Threads | Outline | Timeline | Library | To do | Edits | Changes (FEATURES.md:192). On top of that there are a tags column, a notes column with Scene details, a References panel, and the assistant panel with a Continuity view. Compare PLAN.md:158-164 ("showing them without a click").

**D5. Token hotspots.**
- **Chat agent:** every step runs on `strong` (`src/main/ai/agent.ts:345`). It can take up to 6 steps (`src/shared/agent.ts:23`), and each step re-sends a system prefix of about 2,300 tokens (`src/main/ai/eval/token-report.md`, agent.v8). The cost registry itself suggests "fast tier for lookup steps, strong only for the answer" (`src/shared/aiCostNotes.ts:172-180`); this is not built.
- **Background scene reading:** this is the biggest background cost. It is one call per scene per burst of edits, with up to 6,512 tokens in and a 1,000-token output cap (token-report summary.v5 maxed). A new prompt version can trigger a whole-book re-read, which the author must confirm (F-9.14).
- **Sheet sync:** adds a second background loop of AI calls that only maintain a representation of the sheet (`src/shared/aiCostNotes.ts:203`).

**D6. Retrieval is weaker than PLAN assumes.** Embeddings and sqlite-vec were never built (PLAN.md:132-133 vs FEATURES.md:116 "no embeddings yet"; `src/shared/aiCostNotes.ts:76-78` "Not built"). Search is lexical ranking plus an FTS5 paragraph index (ARCHITECTURE.md:28). That is fine for names, but paraphrased questions like "where did Emma first suspect Tomas?" are exactly the planned wedge.

**D7. Accuracy is unmeasured.**
- FEATURES.md has 18 notes saying "live fidelity not run" and 65 decisions marked "decided by Claude, unconfirmed".
- Live evals are unrun for summary.v4 and v5, agent.v6 to v8, todo, and the sheet-sync prompts (CLAUDE.md "Next up" 1).
- Nothing measures how many extracted facts are false.

**D8. Stale documents** (a redesign should rewrite these first):
- PLAN.md §4.2 still describes a $39 Supporter license and subscriptions, and lists OpenAI-first and local models deferred (PLAN.md:235-249, 257, 361-364). These are superseded by CLAUDE.md:22-23 and F-5.15.
- FEATURES.md principle 4, "never a silent edit" (FEATURES.md:27), contradicts Auto mode.
- The §1 domain model (FEATURES.md:34-48) still describes References and Tags, not records, facts and cards.

## 5. What the evidence says for a redesign

**Keep** (all local, free, and aligned with the goal):
- mention and alias scan
- FTS5 passage index
- story names in the spellchecker
- proposed names
- "In this scene"
- the derived-data exception
- one background `fast` call per scene, keyed to content hash
- canon/plan/idea status
- cited answers

**Candidates to cut or merge:**
- Label tags (tone, content, custom) and granular, inline and template tags. Replace them with entity records plus aliases, and AI-read mood and theme on scene cards.
- Organise, Review chat and sheet sync.
- Separate Threads, To do and Changes surfaces. Fold them into one "needs attention" list and one undo log.
- One writer path into the bible, not seven.
- `fast` lookup steps in the agent.

**Questions to put to the author before deciding:**
1. Do they ever use tags as tags (filtering, colour labels), or only as names?
2. Do they want to edit sheets by hand, or only read them?
3. What accuracy floor is acceptable for auto-recorded facts? Should facts show "AI, from scene X" or be silently trusted?
4. Is embedding retrieval worth one more dependency, or should questions stay on names, cards and FTS?
5. How much existing project data must survive the change?

Main files: /home/user/Mythscribe/PLAN.md, /home/user/Mythscribe/FEATURES.md, /home/user/Mythscribe/CLAUDE.md, /home/user/Mythscribe/docs/ARCHITECTURE.md, /home/user/Mythscribe/src/shared/ai.ts, /home/user/Mythscribe/src/shared/aiCostNotes.ts, /home/user/Mythscribe/src/shared/tagTerms.ts, /home/user/Mythscribe/src/main/ai/agent.ts, /home/user/Mythscribe/src/main/ai/eval/token-report.md