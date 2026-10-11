**(a) Corrections**

1. **"Cuts long scenes from the head" is backwards.** `headTruncate` keeps the first 20k characters and drops the rest: `text.slice(0, max)` (`src/main/ai/context/chatContext.ts:108-110`, called at `summarize.ts:136`). The brief's conclusion ("long scenes lose their ending") is right. Only the wording is wrong.
2. **"Mid-draft flicker" is mostly wrong.** AI facts are sticky (decision D13, `src/main/entity/factStore.ts:22-25`). A re-read adds new facts. A fact goes away only when its quote leaves the scene. The real problem is accretion. Duplicates are caught only by an exact match on the normalised value (`factKey`, `src/shared/observedFacts.ts:101-108`). So "grey", "grey-blue" and "grey eyes" from three re-reads of one scene become three facts. This also changes the wording of Q4(c). Option B's line "a fact survives edits as long as its quote is still in the text" describes today's behaviour, not something new.
3. **The contextual-retrieval figures are misread.** The 35% / 49% / 67% cuts are against a baseline that already uses plain embeddings. They come from *contextual* embeddings and *contextual* BM25, where an LLM writes a context line for every chunk before indexing. The failure rate went 5.7% → 3.7% → 2.9% → 1.9%, using the best embedding model only ([Anthropic](https://anthropic.com/news/contextual-retrieval), [Maginative](https://www.maginative.com/article/anthropics-contextual-retrieval-technique-enhances-rag-accuracy-by-67)). So the numbers do not show that "embeddings cut failures by 35%". Getting them also needs a paid LLM pass over every chunk, which is missing from option C's cost.
4. **The Pro "promotional" price is probably stale.** A listing says the discount was extended only to 2026-05-31 ([OpenRouter page](https://openrouter.ai/deepseek/deepseek-v4-pro/api), [llmreference](https://www.llmreference.com/model/deepseek-v4-pro/openrouter)). Until someone checks, assume list price: $1.74 in / $3.48 out. At that price chat costs about 4× the low end of the brief's ranges. Q12's "about 1 cent" should be costed at list price.
5. **Flash on OpenRouter.** Trackers show $0.09 / $0.18 or $0.14 / $0.28 ([Bifrost](https://www.getmaxim.ai/bifrost/llm-cost-calculator/provider/openrouter/model/deepseek-v4-flash), [ComputePrices](https://computeprices.com/providers/openrouter/models/deepseek-v4-flash)). One listing gives the `-latest` alias $0.03 / $0.80, which may be where the repo's $0.03 input came from. Either way, `src/shared/ai.ts:591-601` is wrong, and its own comment says the figures are "OpenRouter's live prices of 2026-10-07".
6. **"No leading tool asks authors to tag scenes" is overstated.** The competitor report itself lists Scrivener keywords and "on stage" columns, and Plottr filters. The accurate claim: no tool that works well *requires* tags to give the AI its context. Tags survive elsewhere only as optional labels.
7. **"One more dependency" for C.** sqlite-vec is already in the approved stack (CLAUDE.md Stack table) but is not installed: `package.json` has no sqlite-vec, onnx or embedding package. What C really adds is onnxruntime plus the model weights (a native module in Electron, bundled per OS). EmbeddingGemma is under the Gemma Terms of Use; Qwen3-Embedding is Apache-2.0. That licence difference matters for a paid app.
8. **The session cost is stated two ways:** $0.06–0.25 in §1 and $0.03–0.25 in the §5 table. Pick one and say which prices it uses.

**(b) Additions (verified)**

- **Hidden reasoning cost is missing.** The agent, continuity, plan links, voice notes and router are not in `NO_REASONING_FEATURES` (`src/main/ai/request.ts:56-66`). Reasoning defaults to `default`, which sends no parameter (`src/shared/ai.ts:535-541, 614`). If V4 Pro thinks by default, the agent pays for hidden output tokens that `token-report.md` does not count. Whether it does is unconfirmed: OpenRouter's page implies reasoning is opt-in.
- **Summary consumers are not mapped, and this decides whether option A is viable.** Stored summaries feed:
  - the agent's open document and story map (`agent.ts:313`, `context/storyTime.ts`);
  - the beta reader (`betaReader.ts`, F-14.11);
  - plan links (`planLinks.ts`);
  - scene steer (`context/sceneMood.ts`);
  - neighbouring summaries in the prose bible (`context/storyBible.ts`);
  - synopsis and notes suggestions (`sceneSuggest.ts`);
  - scene cards (`knowledge/sceneCard.ts`);
  - To do (`knowledge/todoLocal.ts`).

  "Nothing read in the background" breaks or degrades all of these, plus the Outline as a reverse outline.
- **The name-staleness cascade is dropped.** The reading's hash includes the known names a scene contains (`summarize.ts:139`). A new name stales every scene that mentions it, and those scenes are only re-read in a paid burst on the next open (jobs report §4.3). Any redesign must take names out of the hash.
- **The keep/change/remove table is missing subsystems:**
  - Library upload and review chat (F-9.8/9.9). The author uses these: "re-upload", `FEATURES.md:134`.
  - `importStructure`, which also proposes tag candidates (`src/shared/ai.ts` AI_FEATURE_IDS comment).
  - Character ages, built only from tag-linked characters (F-11.2b, `FEATURES.md:213`).
  - Timeline events.
  - The plot-thread grid (F-11.1c reads plotThread tags).
  - The "Clear story bible" chat tool (F-5.25).
  - The compile `keepTags` option (`compileModel.ts:146-149`, confirmed).
- **Confirmed:**
  - Story Intelligence is dead code. No renderer or preload code references `ai:query`, and the `query` action runs the agent (`assistantStore.ts:1092`).
  - `sceneEntities.ts:28` skips entities with a null `tagId`.
  - The focus (caret text) sits in the system message before the history (`agent.v8.ts:59-68`).
  - There are 82 prompt files.
  - FTS5 uses `porter unicode61 remove_diacritics 2` (`0022_passage_fts.sql:3`).
- **Storage constraint.** `project.db` lives in a synced Drive folder with exclusive locking (F-8.1, `FEATURES.md:166`). A vector index or more fact rows make every sync bigger, so C's index size matters, not only the size of the download.
- **The accuracy gap needs a measurement plan, not only a mention.** None of options A, B or C can be chosen on accuracy until there is a small gold set from the author's own book: known facts plus questions with answers. Run each option against it. Without that, "accuracy decides" cannot be acted on.
- **Diff-only extraction (B) has accuracy risks:**
  - Changed paragraphs lose the context of who "she" refers to.
  - A fact that spans paragraphs gets missed.
  - The model cannot see its earlier facts in order to replace them.

  Send the changed paragraphs plus their neighbours and the record names in scope. Do not send the bare diff.
- **Cloud (hosted) users.** Background readings draw down the prepaid Balance at a 25% markup (CLAUDE.md). "Automatic, no upkeep" spends money nobody visibly asked for. Local models (F-5.15) cost $0 but are likely worse at quoted JSON extraction, and the brief never discusses accuracy on local models.

**(c) Extra open questions for the author**

1. **Worldbuilding notes.** Are your worldbuilding notes (magic rules, history, maps) canon even when the prose never states them? Q1(a)'s "notes count as plans" would demote them, and the F-5.23 bug came from exactly such notes.
2. **Book shape.** How long are your scenes? Do any run past about 3,500 words? Do you write in MythScribe, or paste in from Word or Docs?
3. **AI off.** With Use AI off, or a local model only, what must still work: name index, mentions, search, "In this scene"?
4. **Cloud spending.** On Cloud, may background reading spend Balance without asking, or only on your own key?
5. **Gold set.** Will you give 20–30 questions about your book with known answers, and a list of known facts? We would use them to measure accuracy before and after the redesign.
6. **Speed or quality.** Is a chat answer in about 3 s on Flash acceptable, or is Pro quality worth 5–20× the cost per question?
7. **Features that depend on summaries.** Do you use the beta reader, plan links, the Outline drift flags and the threads grid? Each one needs a background summary to keep working.
8. **Hidden lists.** Should the AI's "never bring back" decisions sit in one visible list you can edit, or stay hidden?
9. **Uploads.** Should uploaded documents keep feeding the bible, or be read only when a question needs them?
10. **Leading wording to fix:**
    - Q4(c) "facts flicker": the real effect is facts piling up.
    - Q13(b) "your text leaves your machine": every AI option already sends text.
    - Q4(a) "about 90% cheaper": unsourced. Give a computed range instead.