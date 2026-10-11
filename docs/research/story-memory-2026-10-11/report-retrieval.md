# Lookup and retrieval in MythScribe: how AI prompts get story context

The chat agent does most of the lookups. Its ladder (look up a name, then scene cards, then passage search, then the scene itself) keeps most questions cheap, and its citation check catches made-up quotes. Five things hold it back:

- **Names depend on tags.** Who appears where comes from tag names (the mention index).
- **No search by meaning.** The only search is keyword search over paragraphs (FTS5/BM25). There are no embeddings and no search over scene cards.
- **The open scene isn't in the prompt.** The agent sees only the 1,500 characters before the caret.
- **Every answer takes several round trips** on the strong model.
- **Re-summarising while typing is wasteful.** A scene is re-summarised on every 3-second pause.

Branch: `claude/gallant-pasteur-sn3vn0`.

## 1. Paths that send story context

| Path | Model tier | Context it sends | Input budget / output cap | Eval sizes (tokens) |
|---|---|---|---|---|
| **Router** `route.v2` (`src/main/ai/route.ts:76`, fast at `:117`) | fast | Message, last 2 turns, open document title, first 200 characters of the selection | 1,200 / 120 | ~500–600 |
| **Chat agent** `agent.v8` (`src/main/ai/agent.ts:287`, strong at `:345`) | strong, **every step** | Rules, story map (≤1,200 tokens), open document (title, synopsis, notes ≤1,500 characters, stored summary, 1,500 characters before the caret, selection ≤2,000 characters), 10 history turns, then tool results | 12,000 per step / 1,500 (retry 3,000); ≤6 tool steps; $0.50 cap per message (`src/shared/agent.ts:23-43`) | rules alone 2,329 in Ask/Auto, 1,603 in Plan; "fact" case ~2,000 per step; "maxed" 10,684 |
| **Story Intelligence** `query.v4` (F-5.7) | strong | Top 3 scenes in full (12,000 characters), 10 summaries, entity sheets ≤1,500 tokens | 12,000 / 600 | 658–11,711 |
| **Story bible** block (`src/main/ai/context/storyBible.ts:50`) | — | All story-category tag names, the scene's tags and folders, neighbouring scenes' summaries, sheets of entities linked to the scene's tags | **400** tokens; **150** for ghost text (`src/shared/storyBible.ts:16,18`) | — |
| **Scene summary** `summary.v5` | fast | The whole scene plus name, tag and thread lists. Returns summary, key points, cast, ≤6 facts, tags, card, mood/theme, ≤4 relations, ≤4 thread events | 8,000 / 1,000 | 1,084–6,512 per run |
| Ghost text v4, Rewrite v4, Critique v3, What next v3 | fast / strong / strong / — | Voice profile and exemplars, story bible block, text around the caret | 2,200 / 3,000 / 8,000 / 4,000 | ≤2,113 / ≤2,914 / ≤7,113 / ≤3,027 |

Figures come from `src/main/ai/eval/token-report.md`, which estimates tokens as characters ÷ 4.

**Story Intelligence is unreachable from the app.** The renderer never calls `ai:query`. Both the router's `chat` and `query` actions go to the agent (`assistantStore.ts:1081-1093`). `runQuery` (`handlers.ts:3701`) and `rankCandidates` (`src/main/ai/context/queryContext.ts:263`) are left over as a second implementation. Only the old `search` tool still uses `rankCandidates` (`agentTools.ts:554`).

## 2. The lookup ladder (F-5.24, `src/main/ai/agentTools.ts`)

The model makes one JSON tool call per step. Each step resends the whole growing conversation to the strong model (`agent.ts:372-430`).

- **`lookup` a name** (`:259`, ≤1,200 characters): the author's sheet plus dated facts as of NOW, marked canon, plan or idea. It also gives relations, threads, how many scenes name it with the first and last paragraph, and the card of the last scene up to NOW that names it.
  - Scene names come from `listMentionsForTag` (`:322-330`). An entity whose `tagId` is null shows "Named in no scene yet", even when the book is full of it.
- **`cards`** (`:427`, ≤8 scenes, ~100 tokens each): takes scene ids or a name, never a topic. Cards are built at read time from the summary's AI card, with the author's metadata winning (`src/main/knowledge/sceneCard.ts:30`).
- **`find_passages`** (`:496`): FTS5 BM25 over manuscript paragraphs, terms joined with OR, 8 results with snippets (`src/main/search/passageIndex.ts:9-16`). Notes and sheets are **not indexed** (`:14`). This is the only free-text search: `search` and `read_summary` were removed in v6 (`src/shared/agent.ts:106-118`).
- **`read_scene`** (`:610`): 6,000 characters per call, paged with `from` or `para`.
- **Mentions** (`src/shared/mentions.ts`): a local regex scan for **tag** names and aliases. A character counts only as a capitalised proper noun. Pronouns and epithets ("she", "the captain") never count.

## 3. Accuracy safeguards

- **Agent citations:** a quote is kept only if `findQuote` finds it in the cited document after normalising (`agent.ts:558`; `src/shared/critique.ts:91`). A `{"sheet"}` citation is checked only for whether the sheet exists.
- **Summary extraction:** every fact, relation and thread event must carry a quote found in the scene, or it is dropped (`src/main/ai/summarize.ts:568,614,670`). This is the strongest guard in the system.
- **Story time and status labels:** "▶ NOW" marks where the author is, sources are tagged canon, plan or idea, and plan or idea material must be labelled in the answer (`agent.v6.ts` `AGENT_STATUS_RULES`).
- **Voice check** on any prose an agent edit carries (`agent.ts` `finishAnswer`, `checkChatFidelity`).

Gaps in these safeguards:

1. A quote is checked for **presence, not support**. A real quote can sit beside a false claim.
2. Claims without citations are allowed. `uncited` is flagged only in Plan (`agent.ts:578-579`); an Ask or Auto answer with no citation is never flagged.
3. Quotes are checked against the whole document, not the text the model was given.
4. The live eval for the agent only checks that the JSON parses (`src/main/ai/eval/prompts.eval.ts:442`). There is no gold question-and-answer set. The live eval has not been run for agent.v6–v8.

## 4. Where retrieval is weak

1. **The open scene is missing from the prompt.** The prompt says "mostly about the open document", but sends only 1,500 characters before the caret plus a summary that may be stale (`agent.ts:307-316`).
   - "What's wrong with this scene?" or a find/replace edit needs `read_scene` steps; a 20,000-character scene takes 4 of the 6 allowed steps.
   - `fitAgentPrompt` then drops the oldest tool results to stay under 12,000 (`agent.ts:488-498`), so the model can lose the start of the scene.
2. **No search by meaning.** Questions like "when did she first distrust him?" or "the betrayal scene" depend on the words matching. The 120-character map lines are the only thing close to semantic, and for a long book they shrink to a window around NOW (`src/shared/storyTime.ts:130-207`).
3. **Two different answers to "who is in this scene".** The agent uses the mention index. The story bible for prose uses `document_tag` links, author-made or AI auto-tags (`storyBible.ts:83-95`). A scene that names Mara but has no Mara tag gets no Mara sheet in Rewrite or ghost text.
4. **The identity layer is the tag.** F-9.12 makes "every character, place, world tag point at a sheet". Mentions, `lookup`, `cards {name}` and the bible's entity choice all hang off `tagId`. If tags go, the name and alias index has to move onto the records.
5. **Notes and sheets can't be searched by text.** `read_sheet` needs an exact name.
6. **The story bible is starved.** At 400 tokens (150 for ghost text), the full list of tag names competes with sheets, and observed facts are the first thing dropped.

## 5. Where tokens and time are wasted

1. **Every message makes 3–4 trips in a row:** router (fast) → step 1 (strong) → tool → step 2 (strong) → answer. Even a pure lookup takes 2 strong requests.
   - The name could be matched locally for free and the `lookup` result pre-loaded into step 1.
   - Tool-choice steps could use the fast model; the cost note already suggests this (`src/shared/aiCostNotes.ts:172-180`).
   - The router could be folded into the agent's first step.
2. **The prompt order works against caching.** The map and the caret text sit in the system message *before* 10 history turns (`agent.v8.ts:59-68`). The caret text changes with every keystroke, so history is never cached between messages.
   - Steps within one message are cached, and on DeepSeek a cache hit costs about 1/50 of a miss ([puter](https://developer.puter.com/tutorials/deepseek-api-pricing/)).
   - DeepSeek caches automatically by exact prefix match ([DeepSeek KV cache guide](https://api-docs.deepseek.com/guides/kv_cache)).
   - Better order: rules → map → history → open document → message.
3. **Re-summarising on every pause.** `SUMMARY_DEBOUNCE_MS = 3,000` (`src/shared/summary.ts:68`), and every save queues it (`handlers.ts:1032`). One pass is the whole scene in, up to 1,000 tokens out. Each run also queues a consistency check and the plan-link and To do jobs (`handlers.ts:616-660`). Facts, tags and threads are rewritten mid-draft, so the index churns while the author types.
4. **Rules are about 2,300 tokens** in Ask/Auto (bulk, organise, status and To do settle rules) on every strong step. They are cacheable but billed at full price on the first step of each message.
5. **Prices in the repo don't match published prices.** The repo table (`src/shared/ai.ts:590-600`) has Flash at $0.03 in / $1.28 out and Pro at $0.21 / $0.42 / $0.017 cached. Published prices per million tokens:

   | Model | Input | Output | Cache hit |
   |---|---|---|---|
   | Flash (DeepSeek direct) | $0.14 | $0.28 | ≈$0.003 |
   | Pro, promo | $0.435 | $0.87 | — |
   | Pro, standard | $1.74 | $3.48 | — |
   | Flash on OpenRouter (one source) | $0.09 | $0.18 | not found |

   Sources: [puter](https://developer.puter.com/tutorials/deepseek-api-pricing/), [Simon Willison](https://simonwillison.net/2026/apr/24/deepseek-v4), [eesel](https://eesel.ai/blog/deepseek-v4-flash-pricing), [aicybr](https://aicybr.com/blog/deepseek-v4-flash-complete-guide). I could not reach openrouter.ai to check its own pages.

   **What a question costs:** about 13,000 strong input tokens (~60 % cached) and ~400 out, so roughly $0.001–$0.01. Cost per question is small. The real costs are **delay** (round trips) and the **per-pause summaries**.

## 6. What a redesign would mean for retrieval

- **One name index on records,** with aliases and optionally pronoun or epithet links, used by the mentions, `lookup`, cards and the bible alike. With that in place, tags are not needed for retrieval.
- **Match names locally before the first strong call,** and pre-load the open scene, or its paragraphs near the caret, and the matched records.
- **A cheap search by meaning:** search over cards and summaries (FTS over summaries costs nothing), with embeddings optional later.
- **Summarise once the author goes idle or leaves the scene,** not on every 3-second pause.
- **A claim-support check and a gold question set** to measure accuracy.

Questions for the author:

1. Should the agent always see the whole open scene, at about 1,500–6,000 tokens each time?
2. Is embedding-based search acceptable? It needs a model, local or paid.
3. Can scenes be re-summarised only when the author leaves a scene or goes idle (for example 2 minutes)?