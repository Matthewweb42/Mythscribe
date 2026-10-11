# MythScribe story memory: research brief

**Scope.** This brief synthesises six codebase maps of branch `claude/gallant-pasteur-sn3vn0` (read-only; no files were edited) and three web surveys. The sandbox blocked direct web fetches, so web figures come from search summaries. Claims a vendor made about its own product are marked *(vendor)*.

---

## 1. The current system on one page

### How data flows today

1. **On every save.** The autosave fires after 1 s (`autosaveStore.ts:8`), then a 3 s debounce runs (`src/shared/summary.ts:68`).
2. **One Flash call re-reads the whole scene.** It uses `summary.v5`, is capped at 20k characters and cuts long scenes from the head (`summary.ts:20`). It returns a summary, key points, the cast, up to 6 facts, up to 8 tags, a card, mood and theme, up to 4 relations and up to 4 thread events.
3. **The result is written into the bible.** `applyDerivedKnowledge` (`src/main/knowledge/derive.ts:179`) writes facts, auto-tags, new sheets, relations and threads, logged as one Changes run.
4. **Follow-on jobs run after each reading.** These are continuity, plan links and To do (`src/main/ipc/handlers.ts:616-674`).
5. **A free local scan runs in parallel.** It finds tag names and aliases and fills `tag_mention` and the FTS5 passage index. The passage index has no other writer (`src/main/search/passageIndex.ts:12-14`).
6. **Chat.** A Flash router hands off to the agent, which runs on Pro for every step (up to 6). It climbs a ladder: lookup → cards → find_passages → read_scene (`src/main/ai/agentTools.ts`).
7. **Prose features** (ghost text, rewrite, critique) get a story-bible block of 400 tokens (150 for ghost text). It is built from every tag name plus the sheets of entities linked to the scene's tags (`src/main/ai/context/storyBible.ts:50-95`, `src/shared/storyBible.ts:16-18`).

### What costs tokens

- **Re-reading the scene under the caret is 85–90% of a writing session's AI spend.** Any pause of about 4 s triggers a full re-read with a full 600-token reply, even after a one-word edit. At the repo's prices, a 2-hour session costs $0.06–0.25. That is 1–3 times the cost of indexing the whole 90k-word book once (about $0.09–0.11).
- **Chat** costs about $0.002 for a typical question and $0.01–0.02 for a heavy one. The agent's 2,329-token rules are re-sent on every step (`src/main/ai/eval/token-report.md:249`). Prompt order defeats caching: the caret text sits before the history (`agent.v8.ts:59-68`).
- **Organise and upload** run on the strong tier in up to 16 chunks.
- **Sheet sync** is a paid loop whose only job is to keep two views of one sheet matching (`sheetSync.ts:33`).
- **Fix the price table first.** `src/shared/ai.ts:589-601` lists:

  | Model | Input per 1M | Output per 1M |
  |---|---|---|
  | Flash | $0.03 | $1.28 |
  | Pro | $0.21 | $0.42 |

  That makes Pro output three times cheaper than Flash output. Published prices disagree:
  - Flash: $0.14 in / $0.28 out. Flash V4.1 off-peak: $0.15 / $0.60 ([benchlm](https://benchlm.ai/deepseek/api-pricing), [eesel](https://eesel.ai/blog/deepseek-v4-flash-pricing)).
  - Pro: $0.435 / $0.87 on promotion, $1.74 / $3.48 at list ([cloudzero](https://www.cloudzero.com/blog/deepseek-pricing/)).
  - Nobody could reach openrouter.ai to check its own prices. Whether input or output is the cost lever depends on which table is right.

### What the author maintains by hand

- **Names and tags.**
  - Aliases are typed one tag at a time and never learned (`FEATURES.md:106`).
  - "Track mentions" must be switched off for common-word tags (`FEATURES.md:103`).
  - Proposed tags and title tags each need Create or Dismiss; misspellings need Fix or Not a typo.
  - Wrong AI tag chips have to be removed.
  - Organise has to be run to merge twins ("28 possible duplicates", `QUESTIONS.md:185`).
- **Labels and scene details.**
  - Canon, Plan or Idea on sheets, facts and notes.
  - Location, POV and Timeline for every scene, plus timeline events.
- **Hidden state.** About 8 "never bring back" lists.
- **Review surfaces.** About a dozen: Changes, To do, Continuity, four review decks and others.

The clearest symptom: the author asked the chat to "delete everything in my story bible to start fresh" (`FEATURES.md:134`).

### Where accuracy is at risk

1. **Accuracy is unmeasured.** Live fidelity has not been run for summary.v4/v5 or agent.v6–v8 (CLAUDE.md, Next up 1). The agent eval only checks that the JSON parses (`src/main/ai/eval/prompts.eval.ts:442`).
2. **Checks are shallow.**
   - A quote is checked for presence, not for support (`src/main/ai/summarize.ts:568`).
   - Scene cards are not quote-checked at all.
   - In Ask and Auto, an answer with no citation is never flagged (`agent.ts:578`).
3. **Twin sheets.** Name matching is exact only (`observedFacts.ts:160`), and any fact about an unknown name silently creates a sheet (`:218-250`).
4. **"Who is in this scene" has six sources and two conflicting rules.** Prose prompts use tag links; continuity uses names (`storyBible.ts:91-95` vs `continuity.ts:197-203`). A sheet without a tag never appears in "In this scene" (`sceneEntities.ts:24-28`).
5. **Mid-draft flicker.** Re-reads record facts from half-written prose, then retract them.
6. **Long scenes lose their ending.** Anything past about 3,500 words is never read.
7. **The chat cannot see the open scene.** It gets only the 1,500 characters before the caret (`agent.ts:307-316`).
8. **"As of" means reading order, not story time** (`QUESTIONS.md:139`).
9. **Inline tags compile as kebab-case text,** and keep the old name after a rename (`compileModel.ts:146-149`).

### Size and timing

- About 32k lines (21% of `src`) sit in the tag, entity, knowledge, library and Organise code.
- There are 27 `AiFeatureId`s and 82 prompt files.
- The whole M7 cluster is built but unticked (`FEATURES.md:188-196`). Storage has not been signed off, so **now is the cheapest time to redesign it.**

### Subsystems: keep, change or remove

| Subsystem | Candidate | Why |
|---|---|---|
| Local mention scan + FTS5 passage index | **Keep, re-key** | Free, exact and explainable. Move it onto records. Separate the passage index from the tag scan. Also index notes, sheets and cards. |
| Quote check on extracted facts | **Keep, extend** | The strongest guard today. Add a check that the quote actually supports the value. |
| Records (sheets) | **Keep as the one identity table** | Name, aliases and mentions live here. Today aliases live on the tag (`schema.ts:452`). |
| Dated facts + `sheetAt` | **Keep** | Facts that change over time are what writers ask for. Each field should have one source. |
| Background reading `summary.v5` | **Change** | Read when the scene has settled, send only what changed, drop tags from the reply, and quote-check the card. |
| Chat agent | **Change** | Match names locally and pre-load them, include the open scene, run tool steps on Flash, use a cache-friendly prompt order. |
| Story-bible block in prose prompts | **Change** | Build it from records mentioned in the scene; drop the list of tag names. |
| Threads (tags, records, events, grid) | **Change → one form** | The same thing is stored four ways today. |
| Where/when/POV (scene details vs card) | **Change → one field** | The AI fills it; whatever the author types wins. |
| Changes, To do, Continuity | **Fold** | One "Needs a look" list and one undo log. |
| Tag bank, templates, inline `#`, range tags, Recommend, AI auto-tags | **Remove** | Manual-organiser features that duplicate the name index. |
| Proposed and title tags | **Change** | They become proposed names. |
| Sheet sync (two views, F-9.18) | **Remove** | Pick one view instead of paying to keep two matching. |
| Organise (strong tier) | **Remove or shrink** | It mostly cleans up twins and junk tags the redesign would stop creating. |
| Story Intelligence `query.v4` | **Remove** | The app never calls it (`assistantStore.ts:1081-1093`). |
| Frozen `observed_fact` + 5 conversions run on open | **Remove** | Convert once, then retire. |

---

## 2. The verdict on tagging

**Tags carry four jobs today.**

1. **The identity index for everything:** mentions, lookup, cards, "In this scene", the bible block, To do, the dashboard and spellcheck (`agentTools.ts:323-342`, `sceneCard.ts:56-58`, `todoLocal.ts:40-47`).
2. **Author labels:** tone, content, custom.
3. **Steering prose** (F-14.13).
4. **Filtering** the binder and search.

**What only tags can do:**

- labels for things with no word in the text (a content warning, "needs research", a theme to steer by);
- marking that an unnamed or implied character is in a scene;
- an inline `#` reference inside the prose;
- colour-coded filtering.

**What could replace the rest:**

- **Jobs 1 and 4.** Records hold the name, the aliases and the mentions, and the local scan finds mentions for free.
  - The existing per-scene call proposes new names and nicknames ("Rynna" = "Rynna Falsire"). The author confirms each one once.
  - Matching follows NovelCrafter's rules: case-sensitive for names that are also common words ("Will", "May"), an exclusion list, and plurals ([docs](https://www.novelcrafter.com/help/docs/codex/aliases)).
  - Filtering works on record, POV, place, status and mood.
- **Job 3.** The v5 mood and theme plus the scene details.

| | Keep tags as they are | Remove tags (records + mentions) |
|---|---|---|
| **Tokens** | +116–328 system tokens and about 80–120 output tokens on every reading (`token-report.md:105-110`), roughly 10–15% of a reading. Recommend costs about $0.00014 a click; Organise about $0.004 a run on strong. | Saves all of that. Small in dollars. |
| **Accuracy** | The AI invented ordinary-word tags and needed two guards (`src/shared/tagTerms.ts`, Organise's sweep). Tags cause twins and the two answers to "who is in this scene". | One identity rule removes a whole class of error. Implied presence is lost unless the author keeps a label. |
| **Ease** | The tags column holds 7 stacked lists (`TagsPanel.tsx`). | Removes the chore writers complain about most. |
| **Migration** | none | Re-key about 15 consumers, write a new agent prompt version, add a drop migration. Inline `#tags` turn into plain words **in the prose**, which needs a backup and the author's consent. |

**Verdict.** The evidence supports removing tags as the identity layer and stopping AI tag creation entirely. No leading tool asks authors to tag scenes, and the author's own rules already reduce tags to names. Whether to keep a small layer of labels the author chooses is Q3.

---

## 3. What the field does, and the techniques that fit

**Competitors**

| Tool | How mentions are linked | What to take from it |
|---|---|---|
| NovelCrafter | Exact name and alias matching. Plurals, a per-entry case option, an exclusion list. "Progressions" are dated facts the author writes by hand. Each entry has a mode: Always, When detected, Never. | The best detection model. Its codex is typed by hand, and reviewers call it "powerful but a time sink" ([Medium](https://ilampadmanabhan.medium.com/novelcrafter-review-powerful-for-fiction-writers-frustrating-to-set-up-april-2026-64d391c629a2)). |
| Sudowrite | The AI picks context (the Saliency Engine). It underlines the elements it recognised. | Showing what reached the AI builds trust. Users report the bible drifting from the manuscript, and an import that stopped at chapter 1 ([feedback](https://feedback.sudowrite.com/p/manuscript-automatic-updates-changes-in-the-story-bible)). |
| NovelAI / SillyTavern | Keyword lorebooks. | When the lorebook is over budget, entries are dropped **silently**. SillyTavern's own docs call activation by embeddings unpredictable ([NovelAI](https://docs.novelai.net/en/text/lorebook)). |
| NovelCanon *(vendor)* | Three tiers: free underlines while typing, facts extracted per scene, and a whole-book scan that **shows its cost first**. | The tiered model. It admits weakness on implied contradictions ([blog](https://novelcanon.com/blog/novelcanon-vs-novelcrafter)). |
| Fictionary, ProWritingAid | Automatic analysis. | Fictionary split "Cratchit" and "Cratchits" into two characters; ProWritingAid flagged an action that never happened. AI analysis is not authoritative. |
| Chronicle *(vendor)* | Sends the whole bible on every call. | Cost grows with the bible. |

**Techniques that best fit accuracy, ease and token efficiency**

- **Do not dump the whole book.**
  - NoCha: the best model scored 55.8% on true/false claims about whole books ([EMNLP'24](https://aclanthology.org/2024.emnlp-main.948)).
  - NovelQA: the best model scored 62.3% ([ICLR'25](https://arxiv.org/abs/2403.12766)).
  - Every model tested got worse as its input grew ([Chroma](https://research.trychroma.com/context-rot)).
  - Editing the manuscript also breaks the cached prefix.
- **Retrieve first, widen only when needed.** "Self-Route" answers from retrieved chunks and widens to the full context only when the model says the chunks are not enough; it matched full-context quality at lower cost ([arXiv 2407.16833](https://arxiv.org/abs/2407.16833)). On NovelQA, retrieval cost $52.8 against $99.8 for the full novel, for equal scores ([arXiv 2407.01502](https://arxiv.org/pdf/2407.01502)).
- **Use summaries to find your way, not as canon.** A tree of summaries (RAPTOR) added 20 points on QuALITY ([arXiv 2401.18059](https://arxiv.org/pdf/2401.18059)). But summaries an AI writes contain about 50% more plot holes than the source ([FlawedFictions](https://arxiv.org/abs/2504.11900)).
- **Hybrid search.** Embeddings cut retrieval failures by 35%; adding BM25 brought it to 49%; adding a reranker, 67% ([Anthropic, via Maginative](https://www.maginative.com/article/anthropics-contextual-retrieval-technique-enhances-rag-accuracy-by-67)). FTS5 plus sqlite-vec merged with reciprocal rank fusion is a proven pattern ([Willison](https://simonwillison.net/2024/Oct/4/hybrid-full-text-search-and-vector-search-with-sqlite/)). Local embedding models are free: EmbeddingGemma needs under 200 MB of RAM ([Google](https://developers.googleblog.com/en/introducing-embeddinggemma/)). MythScribe already has the BM25 half.
- **Facts with validity windows.** Graphiti marks a fact invalid instead of deleting it ([docs](https://mintlify.com/getzep/graphiti/concepts/temporal-model)). Take the idea; skip the graph database, which needs several LLM calls per edit.
- **Verify what is extracted.** Rejecting quotes not found in the source, then checking that the quote supports the claim, cut hallucinations by up to 85% ([SafePassage](https://arxiv.org/html/2510.00276v1)). Quote checks are free; a second-pass verification multiplies cost 2–5 times, so keep it for writes into canon.
- **Index incrementally.** Re-extract only the units that changed ([Jigsaw-LightRAG](https://www.preprints.org/frontend/manuscript/a1f65d9e81808a8f55f50d249f585994/download_pub)).
- **Check continuity in pairs.** Let code find conflicting facts, then have the model judge each pair with both quotes in view. Asking for whole-book plot-hole hunting fails ([FlawedFictions](https://arxiv.org/abs/2504.11900)).
- **Skip pronoun tracking.** BookNLP finds names well (0.85) but resolves pronouns poorly (about 0.77) ([arXiv 2307.03734](https://arxiv.org/pdf/2307.03734)).
- **Caching.** A DeepSeek cache hit costs about 1/50 of a miss and needs an exact prefix match ([DeepSeek](https://api-docs.deepseek.com/guides/kv_cache)). OpenRouter keeps requests on the same provider after a cache hit unless `provider.order` is set ([OpenRouter](https://openrouter.ai/docs/guides/best-practices/prompt-caching)).

---

## 4. What writers need, ranked

| # | Need | Evidence | MythScribe today |
|---|---|---|---|
| 1 | Quick recall of small facts (eye colour, minor names, who died) | [Spann Craig](https://elizabethspanncraig.com/uncategorized/keeping-track-of-what-weve-written/), [Coppermind](https://coppermind.net/wiki/Karen_Ahlstrom) | `lookup` works, but it hangs off tags |
| 2 | No upkeep: a bible that is not updated is "a liability" | [Novela](https://novela.so/en/blog/story-bible-that-gets-used), [ProseEngine](https://proseengine.app/blog/what-is-a-story-bible-for-ai-writing-and-how-to-build-one-from-your-draft) | A dozen review surfaces |
| 3 | Time, ages, who was where, who knows what | [Fictionary](https://fictionary.co/journal/elements-of-a-mystery), [NovelCrafter progressions](https://www.novelcrafter.com/help/docs/codex/progressions-codex-details) | Dated facts, but in reading order; nothing tracks who knows what |
| 4 | "Where did I mention X?" and which scenes a character is in, without tagging | [L&L forum](https://forum.literatureandlatte.com/t/tracking-characters-how-do-you-do-it/128018) | The mention scan, keyed to tags |
| 5 | Trust: cited facts, and rejections that stay rejected | [ShakespeareAI](https://shakespeareai.net/blog/ai-story-bible-generator-for-novels), [Inkfluence](https://www.inkfluenceai.com/blog/best-ai-novel-continuity-checking-2026) | Quote checks; about 8 separate "do not bring back" lists |
| 6 | AI as clerk and librarian, not co-author (81% of AI-using authors use it for research) | [Authorlytica](https://authorlytica.com/state-of-author-ai/) | Matches PLAN.md:16-18 |
| 7 | The storyboard as a live reverse outline | [Dabble](https://dabblewriter.com/articles/fyfd-day-three) | Cards, plan links |
| 8 | Trying things out without polluting canon | [L&L](https://forum.literatureandlatte.com/t/best-practices-for-efficiently-saving-alternate-scenes/133587) | Idea status only |
| 9 | Visible cost per action | [NovelCrafter BYOK](https://docs.novelcrafter.com/en/articles/8695405-how-much-does-the-ai-the-models-cost) | Ledger exists |

---

## 5. Candidate from-zero architectures (not choosing yet)

**The same in all three:**

- The manuscript is the only canon.
- Records hold names and aliases; there are no tags.
- Mentions and search are local and free.
- Answers must cite a passage or say "not found".

**A. On-demand reader (no stored bible).** Nothing is read in the background. The free local index (names, aliases, FTS5 passages) is the only memory, and records hold only what the author writes. Each question makes the agent search and read passages fresh, with quotes checked in code. Scene cards are made lazily the first time a question needs them and cached by content hash.

- **Strengths:** never stale; nothing to review; the smallest codebase.
- **Weaknesses:** every question pays to re-read text; there is no "state as of chapter N" and no automatic continuity warning; paraphrased questions depend on keyword search.

**B. Quote-backed ledger, read when the scene settles.**

- **When it reads:** one Flash call per scene, when the author leaves it, after 2–5 minutes idle, or once enough of it has changed.
- **What it sends and gets back:** only the changed paragraphs plus the stored card in; only the changes out (about 100–200 tokens instead of 600).
- **What it stores:** facts as (record, slot, value, quote, scene), marked out of date rather than deleted. A fact survives edits as long as its quote is still in the text.
- **What code works out with no AI call:** the state of a record as of scene N, and ages.
- **Contradictions:** found by code and judged by the model one pair at a time, quietly or on request.
- **Review:** one "Needs a look" list holds only new names and conflicts; reviewing it is never required.
- **Questions:** name lookups are answered from the ledger with no AI call or one Flash call. Open questions use the agent with the open scene pre-loaded.
- **Gaps:** misses implied facts. The value can still paraphrase its quote wrongly unless a support check is added (about 30–50% more on each reading).

**C. B plus meaning search and chapter roll-ups.**

- **Meaning search:** a local embedding model (a one-time download of about 200–600 MB, free and offline afterwards) indexes paragraphs and cards. Search merges keyword and embedding results with reciprocal rank fusion.
- **Roll-ups:** chapter and book summaries are built from the cards whenever a chapter's scenes change, and serve as a map.
- **Chat:** Self-Route answers from what was retrieved and widens to the whole chapter only when the model says that is not enough.
- **Limit:** embeddings only *find* passages; they never decide which facts count as canon.
- **Strengths:** best on questions like "the scene where she first distrusts him".
- **Costs:** a larger install; one more dependency to maintain.

**Cost for a 90k-word novel** (90 scenes of about 1,000 words). Ranges run from list Flash and promotional Pro up to list Pro; the repo's own table gives similar background totals.

| | Today | A | B | C |
|---|---|---|---|---|
| Index the whole book once | $0.06–0.11 | $0 (cards when first needed: up to ~$0.03) | ~$0.04–0.06 | ~$0.05–0.07 |
| One 2-hour writing session | $0.03–0.25 | $0 | under $0.01 | under $0.01 |
| A name lookup ("Mara's eyes?") | $0.002–0.016 | $0.003–0.02 | $0–0.001 | $0–0.001 |
| An open question | $0.002–0.02 | $0.005–0.03 | $0.003–0.02 | $0.003–0.015 |
| Author upkeep | High (about a dozen surfaces) | None, but no stored canon | One optional list | Same as B, plus one download |

Every option costs cents per book. **Accuracy and upkeep should decide, not dollars.** Chat on Pro is the line most sensitive to price.

---

## 6. Open questions for the author (most important first)

1. **Where should the truth about your story live?**
   - (a) Only in the manuscript. The app builds the bible from your prose, and your notes count as plans. Least upkeep, but the bible knows nothing you have not written.
   - (b) Your own sheets are the core, and the AI adds dated notes beneath them (today). More control, but two sources to reconcile.
   - (c) No stored bible. Ms Scribe looks everything up fresh (option A). Never stale, but slower questions and no automatic warnings.

2. **What from your current Drive project must survive?**
   - (a) Everything, converted: tags become names and nicknames, and inline `#tags` become plain words in your text.
   - (b) Only what you wrote yourself. The AI rebuilds its own part, for about 5–10 cents and about 10 minutes.
   - (c) Start the story memory fresh.

3. **Do you use tags for anything besides names?**
   - (a) No. Remove tags entirely.
   - (b) A few labels you pick yourself (content warnings, "needs research", tone) to filter scenes. Keep a small label set the AI never touches.
   - (c) Yes, a lot, with colours. Keep labels as a real feature.

4. **When should Ms Scribe re-read the scene you are writing?**
   - (a) When you leave it or stop for 2–5 minutes. About 90% cheaper than today; memory lags a few minutes.
   - (b) Only when a question needs it. Cheapest; your first question after writing is slower.
   - (c) At every short pause (today). Freshest, but most of the session's AI spend, and facts flicker while you draft.

5. **Character and place sheets: what shape?**
   - (a) You mostly read them; the AI fills them from the text and you pin notes on top.
   - (b) Fields you sometimes fill in (Age, Eyes…).
   - (c) A free-form page you write, with the AI's facts listed separately.
   - Any single choice removes the paid sync between two views.

6. **Does your book tell events out of order?**
   - (a) Mostly in order. "As of chapter N" follows reading order.
   - (b) Some flashbacks. The AI marks flashback scenes and you fix the odd one.
   - (c) Parallel or non-linear timelines. Every scene needs a story date (the AI guesses, you correct), and ages and "has this happened yet" use it.

7. **Will sequels share this world?**
   - (a) A single book.
   - (b) A series. The memory has to span projects, which changes the storage design now.
   - (c) Not sure. Design so it can be added later.

8. **When the AI spots a contradiction (blue eyes in chapter 2, brown in chapter 9), how should it tell you?**
   - (a) A quiet entry in one "Needs a look" list.
   - (b) An underline at the line in the editor.
   - (c) Only when you press "Check the book".
   - (a) and (b) cost a small check per changed scene; (c) costs nothing until you ask.

9. **Where should story information appear while you write?**
   - (a) One side panel showing what matters for the open scene (who is here, what is true as of now, open issues) plus the chat. This folds about five sections into one.
   - (b) Keep the separate sections: Story bible, Threads, Timeline, To do, Changes.
   - (c) Chat only, with panels on request.

10. **Canon / Plan / Idea labels: how much of this should you set by hand?**
    - (a) None. The manuscript is what happened, and everything else is plans.
    - (b) The app sets the label by where a thing lives, and you override it rarely.
    - (c) Keep setting them by hand (today).

11. **Nicknames and descriptions ("Ry", "the captain", "her brother"): what should count as a character?**
    - (a) Names and nicknames only. The AI suggests a nickname once and you click yes. Free and exact.
    - (b) Also titles and descriptions. Small cost, occasional mistakes.
    - (c) Also "she" and "he". Costly and least reliable (about 77% accurate in research).

12. **Should Ms Scribe always read your whole open scene when you ask something?**
    - (a) Always. Better answers about "this scene", for up to about 1 cent more per question at list price.
    - (b) Only when the question is about the scene.
    - (c) Only the text near your cursor (today).

13. **Finding scenes by meaning ("where she first distrusts him"):**
    - (a) Yes, with a one-time download of about 200–600 MB that then works offline for free.
    - (b) Yes, through the paid AI. A small cost, and your text leaves your machine.
    - (c) No. Names, words and scene cards are enough.

14. **Do you need "who knows what" tracking (secrets, clues, what each character has learned)?**
    - (a) Yes, it is central. Adds a short field to each scene reading.
    - (b) Nice to have.
    - (c) No.

15. **What-if chats and alternate versions of a scene: should they feed the memory?**
    - (a) Never, until you promote them.
    - (b) Yes, stored as "idea" and never treated as true.
    - (c) Yes, the same as the manuscript.

16. **How do you plan?**
    - (a) Outline first. The app flags where the draft drifts from your cards.
    - (b) Discover as you write. Cards are built from the draft, and the planning tools stay out of your way.
    - (c) Both.