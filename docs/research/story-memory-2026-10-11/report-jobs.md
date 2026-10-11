# Background AI work and cost in MythScribe (branch `claude/gallant-pasteur-sn3vn0`)

## 1. Pricing basis, and a discrepancy to check first

`OPENROUTER_PRICING` in `src/shared/ai.ts:589-601` sets these prices:

| Model | Input per 1M | Cached input per 1M | Output per 1M |
|---|---|---|---|
| Flash | $0.03 | $0.03 | $1.28 |
| Pro | $0.21 | $0.017 | $0.42 |

Two consequences follow:
- **Output tokens drive almost every background cost.** In one scene reading, output is about 91% of the bill.
- **Flash output costs 3x Pro output** in this table.

Outside sources disagree with the table:
- DeepSeek's own Flash price is $0.14 in, $0.28 out and $0.0028 for a cache hit ([CloudZero](https://cloudzero.com/blog/deepseek-pricing/), [ZenMux](https://zenmux.ai/blog/deepseek-v4-flash-api-pricing)).
- Pro is listed at $1.74 in and $3.48 out, with a 75%-off promotion at $0.435 / $0.87 ([BenchLM](https://benchlm.ai/deepseek/api-pricing), [MindStudio](https://www.mindstudio.ai/blog/deepseek-v4-pro-pricing-value)).

I could not reach openrouter.ai from here (the proxy blocked it). The $1.28 may be a typo, or a different provider routed through OpenRouter. Figures below use the repo table, with list-price figures noted where they change the picture.

## 2. Inventory: what runs, when, and what it costs

| Job | Trigger (auto or on demand) | Tier | Typical tokens in/out (cap) | $ per call (own key) | Cache and invalidation |
|---|---|---|---|---|---|
| **Scene reading** `summary.v5` (summary, key points, cast, ≤6 facts, ≤8 tags, card, mood/theme, ≤4 relations, ≤4 thread events) | **Auto.** Every save, then a 3 s debounce (`SUMMARY_DEBOUNCE_MS`, `src/shared/summary.ts:68`), after a 1 s autosave (`autosaveStore.ts:8`). Wiring is in `handlers.ts:1021-1038`. A backfill of every stale scene runs on open, settings change, key save or import (`handlers.ts:1047-1074`). | fast, JSON, reasoning forced off (`request.ts:56-66`) | Fixture: 1,150 / 600. A real 1,000-word scene: about 2,500 / 600 (1,000) | about $0.00084 | sha256 of the sent text, the 3 metadata fields, and the story-bible names the scene contains (`summarize.ts:131-160`). A hash match costs $0 (`:315-327`). An older prompt version is held back until the author confirms (`conversion.ts`). |
| Background continuity | **Auto** after each reading, only when local rules find a candidate conflict (`continuity.ts:670-698`) | fast (on demand: strong, `:634`) | 944–1,334 / 300 (800) | about $0.0004 | In-memory memo of the context hash (`handlers.ts:616`), lost on restart |
| Plan links | **Auto.** 20 s after a non-cached reading (`PLAN_LINKS_DEBOUNCE_MS`). Skipped when nothing is planned (`planLinks.ts:281-283`). | fast | 3,086 / 150 (400) | about $0.0003 | Hash of the whole message |
| Learned voice notes (F-14.14) | **Auto.** First at 2,000 words, then every 5,000 words of *net* change (`voiceNotes.ts:36-41`, `voice.ts:81-84`). The 30 s debounced voice job also re-picks exemplars locally every 1,500 words. | fast | 1,190 / 250 | about $0.00036 | Word-count delta |
| Sheet sync (write-up and refile) | **Auto.** 30 s after a sheet edit (`sheetSync.ts:33`). One refile per 3,000 characters added. | fast | 308 / 350 (1,200) | about $0.00046 | Both views' hashes plus the response cache |
| To do | Local sync is **auto and free** (`handlers.ts:674`). The whole-book check is **on demand only**, ≤3 windows (`todo.ts:513`). Suggestions: one call per card the first time it is shown. | fast | Check: 415–9,965 / 600. Suggestion: about 200 / 300. | $0.0008–0.002 per check | Estimate memo |
| Conversion pass (summary.v4) | **On demand**, after a cost dialog and a backup. Prices each scene's prompt, 8 s per scene (`knowledge.ts:97`). | fast | Same as a reading | About $0.08 per book | Lazy upgrade since v5: a v4 row stays current |
| Mentions and FTS5 passage index | **Auto and free**, 1.5 s debounce (`passageIndex.ts`) | none | — | $0 | Hash of text plus tracked names |
| Embeddings | **Not built.** The registry row is $0. The agent's passage search uses FTS5/BM25 instead. | — | — | — | — |

How the queue behaves (`indexQueue.ts`, `jobs.ts:20-24`):
- Work runs serially, with at least 500 ms between requests.
- Transient failures retry 3 times, after 5, 15 and 45 s.
- A hard failure (key, quota or budget) pauses the queue.
- No batch API is used.
- A $2 daily cap applies by default (`ai.ts:658`). The local response cache holds 500 rows shared by every feature (`cacheStore.ts:8`).

## 3. Cost for a 90,000-word novel (90 scenes of about 1,000 words)

### (a) Indexing the whole book once

| Item | Cost (own key, repo prices) |
|---|---|
| 90 readings (225k tokens in, 54k out) | about $0.076 |
| Cascade re-reads: scenes go stale when a later scene creates a name they contain (+10–30%) | +$0.01–0.02 |
| Continuity on 10–20 scenes with candidate conflicts | +$0.004–0.008 |
| Plan links and voice notes | <$0.002 |
| An imported manuscript adds `importStructure` (about 36 × $0.000265) | about $0.01 |

- **Total: about $0.09–0.11 own key** (hosted, with the 25% markup: about $0.11–0.14; at DeepSeek list prices: about $0.06).
- It takes about 12 minutes of serial work.

### (b) Keeping it up to date during a 2-hour session (about 2,000 new words in 2–3 scenes, VibeWrite off)

- **Any pause of about 4 s or more re-reads the whole open scene** whenever any character changed. The reply is the full 600-token JSON every time, even when nothing meaningful changed.
- A save while a reading runs re-queues it once more, so the most it can happen is about every 12 s.
- A realistic 60–240 re-reads cost **$0.05–0.20**.
- Continuity on changed candidates adds $0.004–0.016. Plan links add $0.003–0.009. Sheet sync adds under $0.005. Ghost text, if on, is capped at about $0.016 a day.
- **Total: about $0.06–0.25 per session.** Roughly 85–90% is re-reading the scene under the caret, and about 90% of that is output tokens.
- **One session can cost 1–3x what indexing the whole book costs.** "Skip tiny edits" is listed only as an idea (`AI-COST-REGISTRY.md`, summary row).

### (c) One chat question

- **Routing** (`route.v2`, fast): about 510 tokens in, 40 out, ≈ $0.00007.
- **Agent** (`agent.v8`, strong): a typical question takes 3 requests, and the transcript grows each step (about 2.5k → 3.3k → 4k tokens in, about 300 out each).
  - About $0.0012–0.0025 with the 2,329-token system prefix cached; the registry says $0.00194.
  - A heavy question (6 lookups including `read_scene`) is about $0.01–0.02. The hard cap is $0.50 per message (`agent.ts:23-25`).
  - **At DeepSeek list prices for Pro, a typical question is about $0.004–0.016.** Chat is the line most sensitive to price.
- Retrieval itself is local: lookup (≤1,200 characters), cards (8 × about 100 tokens), and FTS5.

## 4. Failure modes (accuracy, staleness, re-reads)

1. **Re-reading drafts in progress.** Half-written prose is read, and its facts, relations and thread events are logged, then removed on the next pause. This makes noise in the Changes log and dated facts that flicker. It also costs money on every pause.
2. **No awareness of what changed.** A one-word edit costs a full read plus the full reply.
3. **A new name stales other scenes.** The hash includes the names a scene contains (`observedFacts.ts:100-130`). Creating a sheet or a name tag stales every scene that mentions it, but nothing re-queues them during the session; only the backfill on open or a settings change does. They read as "Out of date" until the next open, then cost a burst of paid re-reads.
4. **Long scenes lose their ending.** Scenes over 20,000 characters (`summary.ts:20`, about 3,500 words) are cut from the head, so facts and "what changed" in the tail are never read.
5. **Changing what the reading extracts means re-reading the whole book** (about $0.08). The v5 lazy upgrade avoids this only when old rows can stay valid.
6. **Hidden reasoning tokens.** Continuity, plan links, voice notes, the agent and routing are not in `NO_REASONING_FEATURES` (`request.ts:56-66`). If DeepSeek thinks by default, hidden reasoning is billed as output. On Cloud, the server decides.
7. **The cost estimates understate input.** The summary eval fixture scene is 343 tokens against about 1,400 for a real scene, so the registry's input figure is less than half of real. Cost is less affected because output dominates.
8. **These guards work and are worth keeping:**
   - Quotes must match the scene text (`findQuote`), and attributes must come from an allowed list.
   - The prompt says to leave a field empty rather than guess.
   - AI-derived data is stored apart from the author's own text and is removable.
   - Hash short-circuits skip unchanged scenes.
   - Mentions and search are local.

## 5. What this suggests for the redesign

- **Read on "settled", not on every pause.** Trigger when the author leaves the scene, after 2–5 minutes idle, or after a minimum share of the scene has changed. Do the facts, relations and threads extraction on settle or when a question needs it.
- **Make re-reads incremental.** Send only the changed paragraphs plus the stored card, and ask for changes only. That cuts output from about 600 tokens to about 50–150, the biggest saving under the repo's price table.
- **Shrink the reply schema.** Tags overlap with records and local mentions, and key points overlap the summary; dropping either saves output on every read.
- **Fix name staleness.** Take known names out of the hash, or re-read lazily only when a question touches that scene.
- **Keep FTS5 and skip embeddings.** Use the cached stable prefix wherever Pro is used.
- **Correct the price table before deciding anything**, since it changes whether input or output is the lever.

Key files:
- `/home/user/Mythscribe/src/main/jobs/indexQueue.ts`
- `/home/user/Mythscribe/src/main/ipc/handlers.ts`
- `/home/user/Mythscribe/src/main/ai/summarize.ts`
- `/home/user/Mythscribe/src/main/ai/continuity.ts`
- `/home/user/Mythscribe/src/main/ai/request.ts`
- `/home/user/Mythscribe/src/shared/ai.ts`
- `/home/user/Mythscribe/docs/AI-COST-REGISTRY.md`
- `/home/user/Mythscribe/src/main/ai/eval/token-report.md`

Sources:
- [CloudZero: DeepSeek pricing](https://cloudzero.com/blog/deepseek-pricing/)
- [ZenMux: DeepSeek V4 Flash API pricing](https://zenmux.ai/blog/deepseek-v4-flash-api-pricing)
- [BenchLM: DeepSeek API pricing](https://benchlm.ai/deepseek/api-pricing)
- [MindStudio: DeepSeek V4 Pro pricing](https://www.mindstudio.ai/blog/deepseek-v4-pro-pricing-value)
- [pricepertoken: DeepSeek V4 Flash](https://pricepertoken.com/pricing-page/model/deepseek-deepseek-v4-flash)