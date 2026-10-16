import type { AiFeatureId, Tier } from './ai'

/**
 * The AI cost registry's hand-written half (author request 2026-10-08: "keep track of every single
 * thing the AI ever does … with its estimated associated costs … append to it every time we add a
 * new feature with AI"). Every `AiFeatureId` must have an entry: adding a feature without one does
 * not compile. The computed half (prompt versions, budgets, token counts, prices) comes from the
 * code; `npm run eval:ai -- -u` regenerates docs/AI-COST-REGISTRY.md from both.
 */
export interface AiCostNote {
  /** What starts it: the author asks, it runs on its own, or it runs while the author types. */
  trigger: 'on request' | 'background' | 'while typing' | 'every chat message'
  /** When and how often, in plain words. */
  when: string
  /** Provider requests one use makes (a chunked or multi-step feature makes several). */
  callsPerUse: number
  /** A typical answer size in tokens: an estimate until the ledger has real numbers. */
  typicalOutTokens: number
  /** Ideas to make it faster or cheaper later. */
  ideas: string
}

export const AI_COST_NOTES: Record<AiFeatureId, AiCostNote> = {
  ghostText: {
    trigger: 'while typing',
    when: 'VibeWrite on: after a pause, at most once per 12 new characters (the first at a spot is free); capped per day.',
    callsPerUse: 1,
    typicalOutTokens: 40,
    ideas:
      'The most frequent call: keep the caret window small; stable prefix for provider caching; consider a smaller/faster model; skip when the author is deleting. Story memory v2 (F-16.14) sends ghostText.v5: the Story notes block in the bible’s slot within the same 150-token ghost budget and no separate scene steer (the labels are in the block), so a v2 request is a little smaller than v4 (fixtures: 960 vs 1,024 tokens typical, 1,963 vs 2,085 worst).'
  },
  tags: {
    trigger: 'on request',
    when: 'Recommend in the Tags column for one scene.',
    callsPerUse: 1,
    typicalOutTokens: 80,
    ideas: 'Could reuse the summary pass (which already returns tags) instead of a separate call.'
  },
  summary: {
    trigger: 'background',
    when: 'Indexing: once per scene after edits settle (content-hash cached), and for every stale scene after open; a new prompt version re-reads the book only after the author confirms the cost (F-9.14 conversion dialog); summary.v5 (mood and theme, F-5.6) re-reads nothing: a summary.v4 scene gets them with its next reading.',
    callsPerUse: 1,
    typicalOutTokens: 600,
    ideas:
      'The biggest background spend on a large book: batch API when latency allows; skip tiny edits; cap scene text sent; one pass also yields facts, tags, the scene card, relationships, and thread events (summary.v4 added about 150 output tokens, summary.v5 about 20 more for the mood and theme); drop empty lists from the JSON shape if the ledger shows cut-offs.'
  },
  chat: {
    trigger: 'on request',
    when: 'Plan-mode brainstorming and Author-mode drafting from the chat. Story memory v2 (F-16.14) sends chat.v6: the Story notes block (400-token budget) in the bible’s slot, no separate steer; a little smaller than chat.v5 (fixtures: 708 vs 749 tokens for Plan, 1,264 vs 1,350 for Author), and the worst case fills the same 8,000-token budget.',
    callsPerUse: 1,
    typicalOutTokens: 400,
    ideas: 'Trim history turns sooner; keep the voice block only where prose is written.'
  },
  authorMode: {
    trigger: 'on request',
    when: 'Author-mode placement (shares the chat prompt: chat.v5, or chat.v6 with the Story notes block in story memory v2; no prompt of its own).',
    callsPerUse: 0,
    typicalOutTokens: 0,
    ideas: 'Folded into chat/agent drafting; candidate for removal from the feature list.'
  },
  query: {
    trigger: 'on request',
    when: 'A question about the book (Query answers with citations).',
    callsPerUse: 1,
    typicalOutTokens: 300,
    ideas:
      'Strong tier with a large retrieval context: fewer full scenes, more summaries; cache by question+context hash.'
  },
  critique: {
    trigger: 'on request',
    when: "Editor's notes on one scene. Story memory v2 (F-16.14) sends critique.v4: the Story notes block (400-token budget) in the bible's slot; about 40 tokens less than v3 (fixtures: 1,223 vs 1,264 typical, 7,001 vs 7,025 worst).",
    callsPerUse: 1,
    typicalOutTokens: 900,
    ideas: 'Long scenes are head-truncated; split very long scenes instead of truncating.'
  },
  embeddings: {
    trigger: 'background',
    when: 'Not built: reserved for semantic search indexing.',
    callsPerUse: 0,
    typicalOutTokens: 0,
    ideas: 'If built, use a cheap embedding model and content-hash caching.'
  },
  rewrite: {
    trigger: 'on request',
    when: 'Rewrite a selection (bubble, chat, or agent edit).',
    callsPerUse: 1,
    typicalOutTokens: 250,
    ideas:
      'Strong tier since 2026-10-10 (author: voice matters more than cost here); on an OpenAI key that is about 3x the fast tier, on the OpenRouter defaults about the same. Answer length tracks the selection: set max_tokens from the selection size. rewrite.v4 adds the scene mood and theme (about 25 input tokens, from the stored reading, no extra call). Story memory v2 (F-16.14) sends rewrite.v5: the Story notes block (400-token budget) in the bible’s slot and no separate steer; about 100 tokens less than v4 (fixtures: 841 vs 936 typical, 2,659 vs 2,802 worst).'
  },
  brief: {
    trigger: 'on request',
    when: 'Draft a scene brief from the scene text.',
    callsPerUse: 1,
    typicalOutTokens: 120,
    ideas: 'Could reuse the stored summary instead of the whole scene.'
  },
  betaReader: {
    trigger: 'on request',
    when: 'Beta reader reaction to a scene, reading earlier summaries (betaReader.v1). Story memory v2 (F-16.20) sends betaReader.v2: the earlier scenes as their card gists (a map the reader may relate to, never quote), quotes checked in code against the current scene; fixtures 710 vs 673 tokens typical (a longer rule), 10,981 vs 11,599 worst (gists are shorter than summaries with key points).',
    callsPerUse: 1,
    typicalOutTokens: 700,
    ideas: 'Strong tier: try fast tier with a tighter rubric and compare quality.'
  },
  importStructure: {
    trigger: 'on request',
    when: 'Detect chapters/scenes in an imported manuscript, one request per ~2,500 words (importStructure.v1, story memory v1). Story memory v2 (F-16.15): importStructure.v2, the same without the tag bank and tag output.',
    callsPerUse: 40,
    typicalOutTokens: 150,
    ideas:
      'Local heuristics first, AI only for ambiguous breaks; batch API (not latency sensitive).'
  },
  continuity: {
    trigger: 'background',
    when: 'After a scene summary (background) and on demand (Check consistency).',
    callsPerUse: 1,
    typicalOutTokens: 300,
    ideas:
      'Only send paragraphs with candidate conflicts (already done in the background path); skip unchanged scenes.'
  },
  proofread: {
    trigger: 'on request',
    when: 'Proofread a scene or a selection.',
    callsPerUse: 1,
    typicalOutTokens: 600,
    ideas: 'Local spellcheck first; send only paragraphs that changed since the last proofread.'
  },
  whatNext: {
    trigger: 'on request',
    when: 'What should come next? Three directions for the scene. Story memory v2 (F-16.14) sends whatNext.v4: the Story notes block in the bible’s slot, no separate steer; about 100 tokens less than v3 (fixtures: 968 vs 1,079 typical, 2,885 vs 3,027 worst).',
    callsPerUse: 1,
    typicalOutTokens: 200,
    ideas: 'Cheap already; cache per caret context.'
  },
  route: {
    trigger: 'every chat message',
    when: 'Classifies an Auto/Ask message to pick the feature (skipped for exact action names). Since route.v2 (F-5.26) it also picks an edit pass (its type or "ask", and the selection, scene, or chapter): ~200 more input tokens in the cached system turn, ~15 more output tokens on an edit request. Story memory v1 only since F-16.25: a v2 project routes with navigator.v1 (the navigator row).',
    callsPerUse: 1,
    typicalOutTokens: 40,
    ideas:
      'Local keyword match first; merge into the agent step to save a round trip. A quick pick on an edit request (F-5.26) costs no routing: it starts the pass directly.'
  },
  synopsis: {
    trigger: 'on request',
    when: 'Suggest a synopsis for a scene (synopsis.v1, with the stored summary). Story memory v2 (F-16.20) sends synopsis.v2: the scene card in the summary’s place; fixtures 580 vs 495 tokens typical, 3,531 vs 3,400 worst.',
    callsPerUse: 1,
    typicalOutTokens: 120,
    ideas: 'Derive from the stored summary without re-sending the scene.'
  },
  notesSuggest: {
    trigger: 'on request',
    when: 'Suggest key points for a scene’s notes. Story memory v2 (F-16.14) sent notesSuggest.v3: the Story notes block in the bible’s slot. Since F-16.20 it sends notesSuggest.v4: the scene card in the summary’s place, and the block carries the scene’s lasting values and mood; fixtures 1,006 vs v3’s 961 tokens typical, 4,892 vs 4,802 worst.',
    callsPerUse: 1,
    typicalOutTokens: 300,
    ideas: 'Share context building with synopsis; one call could answer both.'
  },
  voiceNotes: {
    trigger: 'background',
    when: 'Learned style notes: about once per 5,000 new words of the author’s own prose.',
    callsPerUse: 1,
    typicalOutTokens: 250,
    ideas: 'Rare and cheap; could run on the batch API.'
  },
  editPass: {
    trigger: 'on request',
    when: 'An Editor-tab pass: one request per scene piece across the chosen scenes. Since F-5.26 also from the chat ("make this scene better", a quick pick, or a specific request), on the selection (one request), the open scene, or a chapter; the chat shows each choice’s estimate first.',
    callsPerUse: 60,
    typicalOutTokens: 1500,
    ideas:
      'The largest single job: batch API, fast tier for copy/proofread passes (already), skip unchanged scenes on re-runs. editPass.v2 adds the scene mood and theme to developmental, line, and custom pieces only (about 25 input tokens each, from the stored reading). Story memory v2 (F-16.14) sends editPass.v3: a continuity piece is checked against the Story notes block (up to 400 tokens, its continuity form with no label lines) instead of the sheet references (worst continuity piece 3,641 vs 4,692 tokens), and a scene with no Pinned line to check against sends nothing; every other pass type is v2’s messages, so its cost is unchanged.'
  },
  agent: {
    trigger: 'every chat message',
    when: 'The per-feature table prices story memory v1 (agent.v8, up to 3 calls a message, every project until the switch-over); story memory v2’s agent.v9 (1 call a message, 2 when widened) is priced by its shipped rows (agent.v9:open, :lookup, :need, :widened) in the story-memory tasks below (a lookup, an open question, an open question widened). Story memory v2 (F-16.25, F-16.26): Ms Scribe answers in one strong-tier call (agent.v9), no lookups: the rules, the edit list on a write run and the roster of names (about 1,000 tokens, cached), then the earlier turns (≤ 1,500), the voice block on edit and draft turns, the whole open scene (≤ 12,000, typically 3,000–4,000), the labelled evidence (≤ 3,000; 1,200 for a lookup) and the question; input cap 24,000. Reasoning off and 700 out for answer, idea and to-do turns (300 for a lookup), low with 2,500 out for edit, draft and what-if turns; one retry at 3,000 after a cut-off reply; one Self-Route a turn ({"need":…}, about 20 out) asks again with up to 8,000 tokens of one chapter or range of scenes. Since P3 slice 3 an answer whose first sentence is unsupported (no kept citation, cite.v1 says no, or an earlier passage for a first, last, ever or never answer) is asked once more with a retry turn (one more call, about 6,500 / 350), and still unsupported it reads Not found in the manuscript (I looked in …). Sheet lines the author asks for land locally (record:addLine), no AI. Story memory v1: Auto/Ask/Plan chat: research steps then an answer (up to 6 lookups; since agent.v6 a ladder: lookup ≤ 1,200 characters, scene cards ~100 tokens each, local passage search, whole scenes last); prose drafts stream separately. Since agent.v7 (F-5.25) a bulk delete is one clear edit answered without lookups (the clear itself runs locally, no AI); the bulk rules, the organise rule, and the bulk and story-bible edits add ~250 input tokens to a read request and ~470 to a write request (a cached prefix). Since agent.v8 (F-5.25 fixes 5, 7, 8) the write edit list gains status, To do settle, notes clearing, undo, summaries, and open: ~110 more input tokens on a write request, none on a read request; the todo tool prints a short ref per item (~2 tokens each). The actions themselves run locally (summaries queue the existing summary jobs).',
    callsPerUse: 3,
    typicalOutTokens: 300,
    ideas:
      'Check the agent.v6 ladder against the ledger (fixtures: a fact question: the answer step 44 % less input than v5, the whole three-request run 25 % less); fast tier for lookup steps, strong only for the answer; answer a lookup-only question in one step.'
  },
  contextImport: {
    trigger: 'on request',
    when: 'Sorting uploaded worldbuilding files: one request per ~8,000-character piece (contextImport.v2, story memory v1). Story memory v2 (F-16.9) files a Research page into Pinned instead (contextImport.v3): once per page, after the estimate, one request per ~8,000 characters of its canon text, strong tier with reasoning off; about 3,200 tokens in and 1,500 out per chunk, so a 20,000-word page is ~14 requests, about 15¢ on an own key.',
    callsPerUse: 10,
    typicalOutTokens: 1500,
    ideas:
      'Fast tier for simple lists; skip unchanged files (already); batch API. Filing (v3): a smaller chunk for dense pages if the ledger shows cut-offs; skip paragraphs that only restate what Pinned says (a local pre-check).'
  },
  planLinks: {
    trigger: 'background',
    when: 'About 20 s after a summary run (and from Find links): links planned scenes and template beats to the written scene that fulfils them (planLinks.v1). Story memory v2 (F-16.21): code matches each plan against the card lines after a reading at no cost; planLinks.v2 picks between an ambiguous best two at most once per reading, only when the reading moved one of their card lines, reasoning off and cached (fixtures 211 tokens typical, 872 worst, vs v1’s 243 and 5,928).',
    callsPerUse: 1,
    typicalOutTokens: 150,
    ideas:
      'Skip when no planned beat is open; match locally by title/summary words first and ask the AI only for ambiguous ones.'
  },
  organise: {
    trigger: 'on request',
    when: 'Organise (button, the quiet offer, or the chat): one request per chunk of the tags, sheets, notes, and outline listing (up to 16 chunks, reasoning off); a chunk whose answer is cut off is halved and each half sent again, at most twice.',
    callsPerUse: 4,
    typicalOutTokens: 1200,
    ideas:
      'Send only the local findings for a quick tidy; skip sections the instruction does not name (already); fast tier for tag-only runs.'
  },
  sheetSync: {
    trigger: 'background',
    when: 'Thirty seconds after the author stops editing a sheet whose fields or page changed (or on Write up now / File now): one write-up when the fields moved, one filing per 3,000 characters of added page text when the page moved; nothing while the hashes say both views agree; identical requests answer from the local cache.',
    callsPerUse: 1,
    typicalOutTokens: 350,
    ideas:
      'Write up only the sections whose fields changed (keep the rest of the page); skip a filing when the page edit is whitespace or punctuation only; batch several sheets edited in one sitting into one request.'
  },
  todo: {
    trigger: 'on request',
    when: 'Only when you click Check the whole book (one request per window of scene cards, at most 3); and one small request per To do card when its suggestions are first shown.',
    callsPerUse: 1,
    typicalOutTokens: 600,
    ideas:
      'Fold suggestions into the check for the top items; skip the check when no card changed meaningfully (an identical input already sends nothing).'
  },
  reviewChat: {
    trigger: 'on request',
    when: 'A message on the upload review screen that changes the pending plan (reviewChat.v2, story memory v1). Story memory v2 (F-16.9): a message on the filing review (reviewChat.v3), strong tier with reasoning off; a little smaller than v2 (fixtures: 580 vs 670 tokens typical, 3,909 vs 5,618 worst).',
    callsPerUse: 1,
    typicalOutTokens: 300,
    ideas: 'Send a compact review summary instead of every record.'
  },
  reader: {
    trigger: 'background',
    when: 'Story memory v2 (F-16.17; F-16.22, F-16.23): reader.v6 again since the author’s decision of 2026-10-15 (plan Suggestions.md: concrete-only suggestions; every fact a reading proves is a suggestion the author accepts or dismisses; reader.v7, which read traits and history again as suggestions, stays catalogued but unsent after its sixth live run found them about half noise), reader.v6 first from the author’s decision of 2026-10-14 (plan ReaderNarrow.md: concrete facts only; traits, history, relations, roles, clothing and objects are no longer read, Ms Scribe finds them in the text; rules 211 tokens fewer than v5, v4’s cap, shorter replies; figures about 4,520 / 250 for a window, 2,350 / 450 for a first-read page, `READING_V3_ROWS`), reader.v5 from the third live planted-error run of 2026-10-14 (plan ReaderPrecision.md: the voice field named "src", what each open-ended slot holds and who did it; rules +177 tokens, v4’s cap; figures about 4,730 / 400 for a window, 2,560 / 650 for a first-read page, `READING_V3_ROWS`), reader.v4 since the second live planted-error run of 2026-10-14 (the slot list first and alone, what each value must be, max_tokens min(1,000, 160 + 1.4 per prose token + 240 with the card): v3 clipped a 400-token page with its card to 720, so most pages were read again in halves), reader.v3 since the first run that day, reader.v2 from P2b, reader.v1 before; fast tier, reasoning off. The rest describes reader.v3, which v4 keeps but for its rules and cap; figures for v4: about 4,550 / 400 for a window, 2,380 / 650 for a first-read page (`READING_V3_ROWS`). Only when a finished sentence of a scene changed (a local gate decides, nothing is sent while typing): the changed paragraphs ±2 when the author leaves the scene or pauses (from P2a slice 3; Read now meanwhile), the whole scene in pages of 400 prose tokens (2,500 until reader.v3: 83 % of those replies were cut off at the 720-token cap) on a first read, after half of it changed, or after five window reads. One request per window piece or page, max_tokens min(720, 160 + 1.2 per prose token + 240 with the card), facts in a compact form (defaults left out); a reply cut off at its cap is read again once from the last paragraph it quoted, in two halves. The rules, the record roster and the topics roster (the secrets and threads found, a short label each, never dropped) are a stable prefix (provider caching), the record roster rebuilt only on a removal, rename, merge or split. reader.v2 also reads who learns or holds which secret (how, and from whom: the learner must be on the page or the point of view), thread steps (opens, advances, resolves) and new secrets and threads, and its tail carries, for the secrets the changed paragraphs touch, who is known to know them (never who does not). Once after the switch-over (F-16.31), Rebuild memory is asked once with its price; until it starts, nothing nobody asked for is read but a scene the author wrote in and then leaves or pauses in (one Needs a look notice offers the rebuild instead of the backlog), and its spend counts as asked (outside the Cloud monthly reading cap, inside the daily cap). Figures (reader.v3, decided by Claude, unconfirmed until the next live run): about 4,400 tokens in and 380 out for a window, 2,230 / 600 for a first-read page of 400 prose tokens (`READING_V3_ROWS`).',
    callsPerUse: 1,
    typicalOutTokens: 500,
    ideas:
      'Skip the card when it is not due (already: +120 output only then); a smaller window when the edit is one sentence; batch Rebuild memory through the provider batch API; measure the cut-off rate in the ledger and trim the claim list before raising the cap.'
  },
  verify: {
    trigger: 'background',
    when: 'Story memory v2 (F-16.17; F-16.22, F-16.23): verify.v4 in the reading since the third live planted-error run of 2026-10-14 (plan ReaderPrecision.md: who did it and what each open-ended slot holds, rules +150 tokens), every batch on the fast tier since reader.v6 (plan ReaderNarrow.md, 2026-10-14: about 900 / 50 a page, `verify.v4`); with reader.v5 the facts of the open-ended slots (history, traits, relation, kinship, role) went in batches of their own on the strong tier (about 950 / 75 a page, `verify.v4:strong`, retired with those slots); the spot checks and Not right stay on verify.v3. verify.v3 from the first run that day (verify.v2 from P2b, verify.v1 before; v3 refuses one person for several, a want for a thing, and a value of the wrong kind), fast tier, reasoning off. Batches per reading page (at most 13 facts each, so every verdict fits), only for the facts code could not prove (each with its sentences ±1, and for a she or he up to eight sentences back to those naming whoever it could mean), the card POV, year and flashback, and who is on the page; nothing when code proved everything. max_tokens min(400, 20 + 28 per fact, thread step or reveals check + 36 per knows item + 12 per card, on-page or same check); a batch cut off at its cap asks its unanswered items once more. From P2a slice 3 also the spot checks after Rebuild memory: 50 literal facts on the fast tier in batches of 10, 20 verified facts on the strong tier one per call (40 tokens out). On request (F-16.18): Not right › Not about is one fast call per use, one fact with the picked record and every record named in the eight sentences before it, its sentences ±3 (about 400 tokens in, about 40 out); nothing is sent for Wrong value or a line whose sentence changed. verify.v2 adds knows items (the learner, how and from whom, with the people named around the line; 36 tokens a verdict), thread steps, a reveals item per new secret or thread (with its voice and mode, 28 out, so a rumoured secret makes none), and up to 3 same-as items each (the two revealing sentences, one an earlier page found included, about 80 in and 12 out), plus an on-page check for each learner not here before the reading. Figures (plan P2b §6): about 1,500 tokens in and 140 out per batch; with reader.v3’s pages of 400 about 1,000 / 120 (`READING_V3_ROWS`).',
    callsPerUse: 1,
    typicalOutTokens: 120,
    ideas:
      'Prove more in code (literal patterns per slot) so fewer items are sent; fold presence checks into the reader once the live run shows they agree; the strong spot check only while the proof agreement is new.'
  },
  navigator: {
    trigger: 'every chat message',
    when: 'Story memory v2 (F-16.25): navigator.v1, fast tier, reasoning off, on every chat message an instant card does not answer (none for an instant card, none for a stale or contested lookup, which goes straight to agent.v9, and none for a typed action name). Step 1 classifies the message with route.v2’s actions and edit-pass fields (a routed edit request, “make this scene better”, ends there: about 4,000 tokens in, 60 out) and the turn kind; for a chat or question it then calls up to three local tools per step (search with its own synonyms over the passage index, cards, read, state, knows, timeline, ideas, outline, to-dos) and ends with the evidence ids to use, at most three steps of 150 tokens out each. The cached prefix (rules and tools, the roster of names, secrets and threads, the first line of each Ideas page, the story map: ≤ 3,000 tokens) stays the same within a chapter; the tail is Now, the open document, the selection’s opening, the last two turns, the question and the evidence menu (≤ 1,000), and steps 2–3 add what the tools found (≤ 1,400). Input cap 6,000. Figures (plan P3 §4, design Part 5): about 6,000 tokens in and 150 out per step, two steps for an open question.',
    callsPerUse: 2,
    typicalOutTokens: 150,
    ideas:
      'Answer step 1 from the tail alone when the live run shows routing is no better with the prefix (a new version); let Step 0’s menu end the search at step 1 more often (`use` at once); cache the prefix per chapter (already stable).'
  },
  cite: {
    trigger: 'every chat message',
    when: 'Story memory v2 (F-16.25): cite.v1, fast tier, reasoning off, after every Ms Scribe answer that kept a citation, and after an answer that found nothing when the search found passages to check it against (none otherwise, and none for an instant card): the question and Now (the open scene), each cited sentence (at most 8; the first always, its contexts cut around the quotes to fit) with its quotes in their evidence sentence ±1, and for a first, last, ever, never or how-many answer (or one that found nothing) the scope item (what code searched, the answer’s main claim and cited scene, up to 5 passages the search found before it, or every one for an absence; none sent when it found none). max_tokens min(200, 20 + 10 per sentence + 20 for the scope). A main claim it finds unsupported asks agent.v9 once more, which is checked again (a second cite.v1 call). Figures (plan P3 §3): about 1,000 tokens in and 60 out; the eval fixtures measure about 300–550 on the test book (2,435 at the cap).',
    callsPerUse: 1,
    typicalOutTokens: 60,
    ideas:
      'Skip a sentence whose quote is the whole sentence word for word; measure the yes rate in the live run and check only the first sentence if it stays near 100 %; the scope item is already left out when the search found nothing before the cited place.'
  },
  judge: {
    trigger: 'background',
    when: 'Story memory v2 (F-16.27): judge.v1, fast tier, JSON, reasoning off (lowest effort on a direct key), only for the candidate pairs code found that no remembered verdict covers: rules C1–C6 in the background and on the rebuild sweep (two values for one fixed thing, a death then a presence, a secret passed on before it is learned, a stated age against a birth year and that scene’s story year, a thread advancing after its resolve, the book against a canon note), and C7 too on Check the book (two different histories or details given for the same thing). Each batch of at most 10 pairs (≤ 2,500 tokens of pairs) goes twice, as two separate requests, the second with every pair’s passages swapped; only two "contradiction" verdicts make a finding. In the background (the Contradiction check switch on, Use AI on, a provider, under the daily cap and, on Cloud, the monthly cap): after a reading or a note save, at most 10 pairs a run, the scene just read first, at most 30 pairs a day; never during a rebuild, which ends with one asked sweep of 10 pairs per 15 scenes read, at most 60 (priced in Rebuild memory’s estimate; held back when it would run, it is dropped, never run later); the rest wait for Check the book (F-16.30, asked and priced first: free when everything is remembered), which judges every uncached pair (C7 included) with no daily pair limit and has the strong model confirm at most 20 open findings (one pair at ±3 sentences, 90 out, each verdict remembered). Check the book and the sweep are asked spend: they may go past the Cloud monthly cap, never past the daily cap. max_tokens min(300, 20 + 26 per pair); a reply cut off is read up to its last whole verdict and the rest wait for the next run. Every pair-order’s verdict is remembered (`verdict_cache`, scene numbers masked and names folded), so an unchanged pair, a scene move or a Rename in book costs nothing. Figures (plan P4 §7): about 1,200 tokens in and 120 out per call for a background run of 1–4 pairs, two calls per batch; a full ten-pair batch (Check the book) is priced at 1,500 in and at most 280 out (the judge.v1 row).',
    callsPerUse: 2,
    typicalOutTokens: 120,
    ideas:
      'Skip the second order when the first says ok, once the live run shows how often the two orders disagree; drop the context sentences for pairs whose quotes alone settle it (the live run’s unclear rate says when); judge C6 note pairs only on a note save.'
  },
  scribe: {
    trigger: 'every chat message',
    when: 'Notes redesign phase 1 (story memory v1): scribe.v3 since 2026-10-15 (scribe.v2: each source with the exact words she relied on, checked locally so the source opens there, refs written as chapters; v3: every tool in the rules and the mode said in the moment, so switching mode keeps the provider cache, and in Vibe she proposes up to 3 prose changes unasked, each a tracked change; rules about 200 tokens longer than scribe.v2 in Brainstorm, 15 in Write, 80 in Vibe), strong tier (DeepSeek V4 Pro), JSON, on every chat message the router sends to the chat. One system prefix in cache order: the rules, every note page (≤ 30,000 tokens; story-bible sheets and Library uploads as pages until phase 4), the book map (each scene’s synopsis and notes), the book whole when everything is under 60,000 tokens (else the scenes picked for the question, ≤ 24,000; "Whole book" forces it up to 80,000), then the moment (the open scene, its notes, the selection), the recent turns and the message. Then up to 6 tool steps (search, open a scene or a page, edit or create a note page, suggest a prose change), each a request with the same prefix (cached by the provider after the first). max_tokens 3,000 a step, 6,000 for the one retry. Figures for the author’s book (about 47,000 tokens of book and notes): about 2¢ for a fresh first step and about 0.2¢ cached on V4 Pro; a typical answer is one or two steps.',
    callsPerUse: 2,
    typicalOutTokens: 400,
    ideas:
      'Send the picked scenes only once the book passes the whole-book line (already); move the moment after the history if the provider’s cache shows misses; answer a lookup the map already answers without a tool step; batch note edits into one tool call.'
  },
  editFlow: {
    trigger: 'on request',
    when: 'Notes redesign phase 2: the edit flow, run from the Edit button in the right column (or opened pre-filled by the chat) and priced before Run. editFlow.v1 for the stages and the focused checks, editNotes.v1 for Update notes; JSON. One system prefix shared by every request of a run (cached by the provider after the first): the rules, every note page (≤ 30,000 tokens), the book map; then one slice of the scope’s text and the family’s task. Quick: fast tier (DeepSeek V4 Flash), a chapter a slice (≤ 16,000 tokens). Deep: strong tier (DeepSeek V4 Pro), slices of ≤ 60,000 tokens (the author’s whole book in one); a Deep run of a scene or a chapter also carries the rest of the book in the prefix (with the slice ≤ 60,000). Requests = slices × (one per stage picked, one for the checks together, one for Update notes). max_tokens 8,000. Figures for the author’s book (about 23k words of prose, 12k of notes): a Quick copyedit of a chapter about 0.2¢; a Deep developmental edit of the whole book about 2–3¢ fresh. Notes redesign phase 3: also Update notes Quick on a chapter, automatically when the author leaves it after writing in it (Settings › AI, off by default, at most 10 runs a day by default; one request a chapter, about 0.2¢).',
    callsPerUse: 4,
    typicalOutTokens: 1500,
    ideas:
      'Batch the stages of one slice into one request when the ledger shows the outputs are small; skip a slice whose text and notes did not change since the last run of the same scope; send the book map only to the families that use it (continuity, plot holes, developmental).'
  }
}

/**
 * The story-memory redesign's planned AI requests (F-16.1, `FEATURES.md` §2.16, design Part 5),
 * priced at the corrected prices before any of them is built, so the registry shows what the
 * redesign will cost and a drift from the design's budget fails a test. One row per request
 * shape; a prompt with two shapes (a first read and a window read) has a row each. When a row's
 * feature ships (P1–P5) it moves into `AI_COST_NOTES`, where the compile check takes over.
 */
export interface PlannedCostNote {
  /** The row's own key: the prompt version, with a suffix for a second shape of it. */
  id: string
  /** The prompt version the row will run. */
  prompt: string
  /** The planned feature id, or an existing one for a new version of its prompt. */
  feature: string
  /** True when `feature` is already an `AiFeatureId` (a new version of an existing prompt). */
  existing: boolean
  phase: 'P1' | 'P2a' | 'P2b' | 'P3' | 'P4' | 'P5'
  tier: Tier
  trigger: AiCostNote['trigger']
  when: string
  typicalInTokens: number
  typicalOutTokens: number
  /** Provider requests one use makes. */
  callsPerUse: number
}

export const PLANNED_COST_NOTES: readonly PlannedCostNote[] = [
  {
    id: 'agent.v9:try',
    prompt: 'agent.v9',
    feature: 'agent',
    existing: true,
    phase: 'P5',
    tier: 'strong',
    trigger: 'on request',
    when: 'A Try chat turn (a what-if, after the launch line): reasoning low, never read into memory.',
    typicalInTokens: 7_000,
    typicalOutTokens: 700,
    callsPerUse: 1
  },
  {
    id: 'agent.v9:version',
    prompt: 'agent.v9',
    feature: 'agent',
    existing: true,
    phase: 'P5',
    tier: 'strong',
    trigger: 'on request',
    when: 'A what-if written out as a scene Version (P5), never read into memory.',
    typicalInTokens: 7_000,
    typicalOutTokens: 1_500,
    callsPerUse: 1
  }
]

/**
 * The story-memory rows that have shipped (F-16.9, P1 slice 5; F-16.17, P2a slice 2: the reader
 * and verify rows; F-16.22, F-16.23, P2b slice 2: their v2 rows, which the tasks read now, the v1
 * rows kept for the ledger's older readings; F-16.20, F-16.21, P2a slice 5: `synopsis.v2`, `notesSuggest.v4` and
 * `planLinks.v2`; F-16.25, P3 slice 2: `agent.v9`'s open, lookup, need and widened calls; P3 slice 3: `cite.v1`; P3 slice 4: `navigator.v1`; F-16.27, P4 slice 2: `judge.v1` and its stronger check `judge.v1:pro`): their features' notes are in `AI_COST_NOTES` now (the registry's per-feature
 * table shows them), and these rows keep the design's sizes so the planned tasks that run them
 * ("File a 20,000-word upload, once", "Index the book once") and the switch-over's rebuild price
 * (`plannedRow` in `switchover/plan.ts`) stay priced from the same figures.
 */
export const SHIPPED_PLAN_ROWS: readonly PlannedCostNote[] = [
  {
    id: 'contextImport.v3',
    prompt: 'contextImport.v3',
    feature: 'contextImport',
    existing: true,
    phase: 'P1',
    tier: 'strong',
    trigger: 'on request',
    when: 'Filing an upload into Pinned, once, one request per chunk, reasoning off (decision 6).',
    typicalInTokens: 3_200,
    typicalOutTokens: 1_500,
    callsPerUse: 1
  },
  {
    id: 'reviewChat.v3',
    prompt: 'reviewChat.v3',
    feature: 'reviewChat',
    existing: true,
    phase: 'P1',
    tier: 'strong',
    trigger: 'on request',
    when: 'A message on the upload review that changes what is filed into Pinned; priced like reviewChat.v2.',
    typicalInTokens: 676,
    typicalOutTokens: 300,
    callsPerUse: 1
  },
  {
    id: 'reader.v1:first',
    prompt: 'reader.v1',
    feature: 'reader',
    existing: true,
    phase: 'P2a',
    tier: 'fast',
    trigger: 'background',
    when: 'A scene read whole: its first read, after >50 % of it changed, or after five partial reads; pages of 2,500 prose tokens.',
    typicalInTokens: 3_800,
    typicalOutTokens: 520,
    callsPerUse: 1
  },
  {
    id: 'reader.v1:window',
    prompt: 'reader.v1',
    feature: 'reader',
    existing: true,
    phase: 'P2a',
    tier: 'fast',
    trigger: 'background',
    when: 'A window read: the changed paragraphs ±2 when the author leaves a scene or pauses.',
    typicalInTokens: 4_000,
    typicalOutTokens: 300,
    callsPerUse: 1
  },
  {
    id: 'verify.v1',
    prompt: 'verify.v1',
    feature: 'verify',
    existing: true,
    phase: 'P2a',
    tier: 'fast',
    trigger: 'background',
    when: 'One batch per reading: the claims code could not prove, with their sentences ±1.',
    typicalInTokens: 1_300,
    typicalOutTokens: 110,
    callsPerUse: 1
  },
  {
    id: 'verify.v1:pro',
    prompt: 'verify.v1',
    feature: 'verify',
    existing: true,
    phase: 'P2a',
    tier: 'strong',
    trigger: 'background',
    when: 'Spot checks: 20 verified claims per rebuild on the strong model, with more surrounding text.',
    typicalInTokens: 700,
    typicalOutTokens: 40,
    callsPerUse: 1
  },
  {
    id: 'verify.v1:spot',
    prompt: 'verify.v1',
    feature: 'verify',
    existing: true,
    phase: 'P2a',
    tier: 'fast',
    trigger: 'background',
    when: 'Spot checks: 50 literal claims per rebuild re-checked on the fast model (sized from design Part 5’s index total).',
    typicalInTokens: 260,
    typicalOutTokens: 15,
    callsPerUse: 1
  },
  {
    id: 'reader.v1:card',
    prompt: 'reader.v1',
    feature: 'reader',
    existing: true,
    phase: 'P2a',
    tier: 'fast',
    trigger: 'background',
    when: 'An instant card that is out of date: one window read for its scene (about one card in five; the rest are local and free).',
    typicalInTokens: 4_000,
    typicalOutTokens: 300,
    callsPerUse: 1
  },
  {
    id: 'synopsis.v2',
    prompt: 'synopsis.v2',
    feature: 'synopsis',
    existing: true,
    phase: 'P2a',
    tier: 'fast',
    trigger: 'on request',
    when: 'Suggest a synopsis in story memory v2: the scene card in the summary’s place (F-16.20); priced like synopsis.v1.',
    typicalInTokens: 495,
    typicalOutTokens: 120,
    callsPerUse: 1
  },
  {
    id: 'notesSuggest.v4',
    prompt: 'notesSuggest.v4',
    feature: 'notesSuggest',
    existing: true,
    phase: 'P2a',
    tier: 'fast',
    trigger: 'on request',
    when: 'Suggest key points for the notes in story memory v2: the scene card in the summary’s place (F-16.20; P1 shipped notesSuggest.v3, decision P1-D7); priced like notesSuggest.v2.',
    typicalInTokens: 961,
    typicalOutTokens: 300,
    callsPerUse: 1
  },
  {
    id: 'planLinks.v2',
    prompt: 'planLinks.v2',
    feature: 'planLinks',
    existing: true,
    phase: 'P2a',
    tier: 'fast',
    trigger: 'background',
    when: 'Plan links applied automatically after a reading (F-16.21, decision 2): code first; this pick only for an ambiguous best two whose card line the reading moved, at most once per reading.',
    typicalInTokens: 1_500,
    typicalOutTokens: 100,
    callsPerUse: 1
  },
  {
    id: 'reader.v2:first',
    prompt: 'reader.v2',
    feature: 'reader',
    existing: true,
    phase: 'P2b',
    tier: 'fast',
    trigger: 'background',
    when: 'A scene read whole with who knows what and plot threads (F-16.22, F-16.23): the rules +220, the topics roster (≤ 400, cached) and about 40 more tokens out than reader.v1:first (plan P2b §6).',
    typicalInTokens: 4_170,
    typicalOutTokens: 560,
    callsPerUse: 1
  },
  {
    id: 'reader.v2:window',
    prompt: 'reader.v2',
    feature: 'reader',
    existing: true,
    phase: 'P2b',
    tier: 'fast',
    trigger: 'background',
    when: 'A window read with who knows what and plot threads: reader.v1:window plus the rules, the topics roster and the topic lines (≤ 150 of the tail) (plan P2b §6).',
    typicalInTokens: 4_370,
    typicalOutTokens: 320,
    callsPerUse: 1
  },
  {
    id: 'reader.v2:card',
    prompt: 'reader.v2',
    feature: 'reader',
    existing: true,
    phase: 'P2b',
    tier: 'fast',
    trigger: 'background',
    when: 'An instant card that is out of date: one reader.v2 window read for its scene (about one card in five).',
    typicalInTokens: 4_370,
    typicalOutTokens: 320,
    callsPerUse: 1
  },
  {
    id: 'verify.v2',
    prompt: 'verify.v2',
    feature: 'verify',
    existing: true,
    phase: 'P2b',
    tier: 'fast',
    trigger: 'background',
    when: 'One batch per reading page: verify.v1 plus knows items (36 tokens a verdict), thread steps, a Reveals item per new secret or thread and up to 3 same-as items each (plan P2b §6).',
    typicalInTokens: 1_500,
    typicalOutTokens: 140,
    callsPerUse: 1
  },
  {
    id: 'verify.v2:pro',
    prompt: 'verify.v2',
    feature: 'verify',
    existing: true,
    phase: 'P2b',
    tier: 'strong',
    trigger: 'background',
    when: 'Spot checks: 20 verified claims per rebuild on the strong model, knows lines among them (48 tokens out for one); priced like verify.v1:pro.',
    typicalInTokens: 700,
    typicalOutTokens: 40,
    callsPerUse: 1
  },
  {
    id: 'verify.v2:spot',
    prompt: 'verify.v2',
    feature: 'verify',
    existing: true,
    phase: 'P2b',
    tier: 'fast',
    trigger: 'background',
    when: 'Spot checks: 50 literal claims per rebuild re-checked on the fast model (knows lines are never literal); priced like verify.v1:spot.',
    typicalInTokens: 260,
    typicalOutTokens: 15,
    callsPerUse: 1
  },
  {
    id: 'agent.v9:open',
    prompt: 'agent.v9',
    feature: 'agent',
    existing: true,
    phase: 'P3',
    tier: 'strong',
    trigger: 'every chat message',
    when: 'Ms Scribe answers an open question in one call: the rules, roster and edit list (cached), the whole open scene (typically 3,000–4,000 tokens) and about 3,000 tokens of labelled evidence, reasoning off. The eval fixtures measure 1,150–1,850 on the test book’s short scenes; the design’s size stays the planning figure.',
    typicalInTokens: 6_500,
    typicalOutTokens: 350,
    callsPerUse: 1
  },
  {
    id: 'agent.v9:lookup',
    prompt: 'agent.v9',
    feature: 'agent',
    existing: true,
    phase: 'P3',
    tier: 'strong',
    trigger: 'every chat message',
    when: 'Ms Scribe answers a lookup the instant cards (F-16.24) could not: the slot’s claims, live and stale, with their paragraphs as they read now (evidence ≤ 1,200), 300 out.',
    typicalInTokens: 4_500,
    typicalOutTokens: 120,
    callsPerUse: 1
  },
  {
    id: 'agent.v9:need',
    prompt: 'agent.v9',
    feature: 'agent',
    existing: true,
    phase: 'P3',
    tier: 'strong',
    trigger: 'every chat message',
    when: 'The call that asks to widen ({"need":"chapter 9"}): an open question’s prompt with a 20-token reply (P3-D22: design Part 5 did not count it).',
    typicalInTokens: 6_500,
    typicalOutTokens: 20,
    callsPerUse: 1
  },
  {
    id: 'agent.v9:widened',
    prompt: 'agent.v9',
    feature: 'agent',
    existing: true,
    phase: 'P3',
    tier: 'strong',
    trigger: 'every chat message',
    when: 'An open question the first evidence could not answer, asked again with one chapter or range of whole scenes (≤ 8,000 tokens; about one question in five).',
    typicalInTokens: 13_000,
    typicalOutTokens: 400,
    callsPerUse: 1
  },
  {
    id: 'cite.v1',
    prompt: 'cite.v1',
    feature: 'cite',
    existing: true,
    phase: 'P3',
    tier: 'fast',
    trigger: 'every chat message',
    when: 'After each answer that cites the book, or says it found nothing with passages the search found: checks every cited sentence against its quotes, and the scope of a first, last, ever or never answer or of the absence (reasoning off). The eval fixtures measure about 300–550 tokens in on the test book (2,435 at the cap); the design’s size stays the planning figure.',
    typicalInTokens: 1_000,
    typicalOutTokens: 60,
    callsPerUse: 1
  },
  {
    id: 'navigator.v1',
    prompt: 'navigator.v1',
    feature: 'navigator',
    existing: true,
    phase: 'P3',
    tier: 'fast',
    trigger: 'every chat message',
    when: 'An open question: up to three steps choosing which passages Ms Scribe reads (reasoning off). Since P3 slice 4 it also routes a v2 message (route.v2’s actions and edit passes); an instant card asks nothing. The eval fixtures measure the cached prefix and a step on the test fixtures; the design’s size stays the planning figure.',
    typicalInTokens: 6_000,
    typicalOutTokens: 150,
    callsPerUse: 1
  },
  {
    id: 'judge.v1',
    prompt: 'judge.v1',
    feature: 'judge',
    existing: true,
    phase: 'P4',
    tier: 'fast',
    trigger: 'background',
    when: 'One call of a full batch of up to 10 contradiction pairs, as Check the book and the rebuild sweep send them; each batch goes twice, the second call with every pair’s passages swapped (reasoning off). The eval fixtures measure about 420–1,360 tokens in a call on the test book (one to nine pairs; 2,683 for ten at the cap); the design’s 1,500 in stays the planning figure, and the out figure is a ten-pair batch’s cap (20 + 26 per pair = 280; the design’s 300 cannot occur). A typical background call of 1–4 pairs is smaller (about 1,200 in and 120 out, the judge’s note).',
    typicalInTokens: 1_500,
    typicalOutTokens: 280,
    callsPerUse: 1
  },
  {
    id: 'judge.v1:pro',
    prompt: 'judge.v1',
    feature: 'judge',
    existing: true,
    phase: 'P4',
    tier: 'strong',
    trigger: 'on request',
    when: 'Check the book (F-16.30): the strong model confirms up to 20 pairs both orders called a contradiction, one pair per call with three sentences either side, 90 tokens out (reasoning off). The eval fixtures measure about 640 tokens in (976 at the cap); the design’s size stays the planning figure.',
    typicalInTokens: 600,
    typicalOutTokens: 90,
    callsPerUse: 1
  }
]

/**
 * The reader's and checker's sizes since `reader.v3` and `verify.v3` (2026-10-14, after the live
 * planted-error run): pages of 400 prose tokens, not 2,500, so a page's compact facts and its card
 * fit the 720-token cap; `verify.v3`'s batch per page is smaller with them. What the reading's
 * prices read now (`plannedRow`: the rebuild in `switchover/plan.ts`, the backlog in
 * `reading/backlog.ts`). Kept apart from `SHIPPED_PLAN_ROWS` (the design's figures, which the
 * planned tasks still sum) until those tasks move to these rows. Decided by Claude, unconfirmed:
 * the live run's next report gives the real sizes.
 */
export const READING_V3_ROWS: readonly PlannedCostNote[] = [
  {
    id: 'reader.v3:first',
    prompt: 'reader.v3',
    feature: 'reader',
    existing: true,
    phase: 'P2b',
    tier: 'fast',
    trigger: 'background',
    when: 'A page of a scene read whole: reader.v2:first’s prefix (rules +160 tokens) and a 400-token page, about 12 compact facts and the card out.',
    typicalInTokens: 2_230,
    typicalOutTokens: 600,
    callsPerUse: 1
  },
  {
    id: 'reader.v3:window',
    prompt: 'reader.v3',
    feature: 'reader',
    existing: true,
    phase: 'P2b',
    tier: 'fast',
    trigger: 'background',
    when: 'A window read (pieces of at most 400 prose tokens): reader.v2:window’s input with the v3 rules, compact facts out.',
    typicalInTokens: 4_400,
    typicalOutTokens: 380,
    callsPerUse: 1
  },
  {
    id: 'reader.v3:card',
    prompt: 'reader.v3',
    feature: 'reader',
    existing: true,
    phase: 'P2b',
    tier: 'fast',
    trigger: 'background',
    when: 'An instant card that is out of date: one reader.v3 window read for its scene (about one card in five).',
    typicalInTokens: 4_400,
    typicalOutTokens: 380,
    callsPerUse: 1
  },
  {
    id: 'verify.v3',
    prompt: 'verify.v3',
    feature: 'verify',
    existing: true,
    phase: 'P2b',
    tier: 'fast',
    trigger: 'background',
    when: 'One batch per reading page: the facts code could not prove on a 400-token page, under the v3 rules (+130 tokens).',
    typicalInTokens: 1_000,
    typicalOutTokens: 120,
    callsPerUse: 1
  },
  // reader.v4 (the second live run of 2026-10-14): rules +152 tokens, max_tokens up to 960 for a
  // page and its card (v3 clipped it to 720, so most pages were read again in halves).
  {
    id: 'reader.v4:first',
    prompt: 'reader.v4',
    feature: 'reader',
    existing: true,
    phase: 'P2b',
    tier: 'fast',
    trigger: 'background',
    when: 'A page of a scene read whole: reader.v3:first’s input with the v4 rules (+152 tokens), a 400-token page, its facts and the card out within the larger cap (no re-read in halves).',
    typicalInTokens: 2_380,
    typicalOutTokens: 650,
    callsPerUse: 1
  },
  {
    id: 'reader.v4:window',
    prompt: 'reader.v4',
    feature: 'reader',
    existing: true,
    phase: 'P2b',
    tier: 'fast',
    trigger: 'background',
    when: 'A window read (pieces of at most 400 prose tokens): reader.v3:window’s input with the v4 rules, compact facts out.',
    typicalInTokens: 4_550,
    typicalOutTokens: 400,
    callsPerUse: 1
  },
  {
    id: 'reader.v4:card',
    prompt: 'reader.v4',
    feature: 'reader',
    existing: true,
    phase: 'P2b',
    tier: 'fast',
    trigger: 'background',
    when: 'An instant card that is out of date: one reader.v4 window read for its scene (about one card in five).',
    typicalInTokens: 4_550,
    typicalOutTokens: 400,
    callsPerUse: 1
  },
  // reader.v5 and verify.v4 (the third live run of 2026-10-14, plan ReaderPrecision.md): rules
  // +177 tokens (reader) and +150 (checker); the checker's page splits into a fast batch and a
  // strong one for the open-ended slots. Decided by Claude, unconfirmed until the next live run.
  {
    id: 'reader.v5:first',
    prompt: 'reader.v5',
    feature: 'reader',
    existing: true,
    phase: 'P2b',
    tier: 'fast',
    trigger: 'background',
    when: 'A page of a scene read whole: reader.v4:first’s input with the v5 rules (+177 tokens), a 400-token page, its facts and the card out within v4’s cap.',
    typicalInTokens: 2_560,
    typicalOutTokens: 650,
    callsPerUse: 1
  },
  {
    id: 'reader.v5:window',
    prompt: 'reader.v5',
    feature: 'reader',
    existing: true,
    phase: 'P2b',
    tier: 'fast',
    trigger: 'background',
    when: 'A window read (pieces of at most 400 prose tokens): reader.v4:window’s input with the v5 rules, compact facts out.',
    typicalInTokens: 4_730,
    typicalOutTokens: 400,
    callsPerUse: 1
  },
  {
    id: 'reader.v5:card',
    prompt: 'reader.v5',
    feature: 'reader',
    existing: true,
    phase: 'P2b',
    tier: 'fast',
    trigger: 'background',
    when: 'An instant card that is out of date: one reader.v5 window read for its scene (about one card in five).',
    typicalInTokens: 4_730,
    typicalOutTokens: 400,
    callsPerUse: 1
  },
  {
    id: 'verify.v4',
    prompt: 'verify.v4',
    feature: 'verify',
    existing: true,
    phase: 'P2b',
    tier: 'fast',
    trigger: 'background',
    when: 'The fast batch per reading page: the closed slots’ facts code could not prove, knows lines, steps, the card and on-page checks, under the v4 rules (+150 tokens).',
    typicalInTokens: 900,
    typicalOutTokens: 50,
    callsPerUse: 1
  },
  {
    id: 'verify.v4:strong',
    prompt: 'verify.v4',
    feature: 'verify',
    existing: true,
    phase: 'P2b',
    tier: 'strong',
    trigger: 'background',
    when: 'Retired with reader.v6 (plan ReaderNarrow.md, 2026-10-14): with reader.v5, the strong batch per reading page, the facts of the open-ended slots (history, traits, relation, kinship, role; about half of what the reader proposed), on DeepSeek V4 Pro.',
    typicalInTokens: 950,
    typicalOutTokens: 75,
    callsPerUse: 1
  },
  // reader.v6 (the author's decision of 2026-10-14, plan ReaderNarrow.md): concrete facts only,
  // rules 211 tokens fewer than v5's, and shorter replies (about a third of v5's facts were in the
  // slots no longer read). Every checker batch on the fast tier (`verify.v4`). Decided by Claude,
  // unconfirmed until the next live run.
  {
    id: 'reader.v6:first',
    prompt: 'reader.v6',
    feature: 'reader',
    existing: true,
    phase: 'P2b',
    tier: 'fast',
    trigger: 'background',
    when: 'A page of a scene read whole: reader.v5:first’s input with the v6 rules (211 tokens fewer), a 400-token page, its concrete facts and the card out within v4’s cap.',
    typicalInTokens: 2_350,
    typicalOutTokens: 450,
    callsPerUse: 1
  },
  {
    id: 'reader.v6:window',
    prompt: 'reader.v6',
    feature: 'reader',
    existing: true,
    phase: 'P2b',
    tier: 'fast',
    trigger: 'background',
    when: 'A window read (pieces of at most 400 prose tokens): reader.v5:window’s input with the v6 rules, compact concrete facts out.',
    typicalInTokens: 4_520,
    typicalOutTokens: 250,
    callsPerUse: 1
  },
  {
    id: 'reader.v6:card',
    prompt: 'reader.v6',
    feature: 'reader',
    existing: true,
    phase: 'P2b',
    tier: 'fast',
    trigger: 'background',
    when: 'An instant card that is out of date: one reader.v6 window read for its scene (about one card in five).',
    typicalInTokens: 4_520,
    typicalOutTokens: 250,
    callsPerUse: 1
  },
  // reader.v7 (the author's decision of 2026-10-14, plan Suggestions.md): every fact a suggestion
  // the author accepts or dismisses; traits and history read again with reader.v5's value rules
  // (about 90 rule tokens more than v6, and a few more facts out). Unsent since the author's
  // decision of 2026-10-15 (concrete-only suggestions): the app prices and reads with reader.v6.
  {
    id: 'reader.v7:first',
    prompt: 'reader.v7',
    feature: 'reader',
    existing: true,
    phase: 'P2b',
    tier: 'fast',
    trigger: 'background',
    when: 'A page of a scene read whole: reader.v6:first’s input with the v7 rules (about 90 tokens more), a 400-token page, its facts (traits and history among them) and the card out within v4’s cap.',
    typicalInTokens: 2_440,
    typicalOutTokens: 500,
    callsPerUse: 1
  },
  {
    id: 'reader.v7:window',
    prompt: 'reader.v7',
    feature: 'reader',
    existing: true,
    phase: 'P2b',
    tier: 'fast',
    trigger: 'background',
    when: 'A window read (pieces of at most 400 prose tokens): reader.v6:window’s input with the v7 rules, compact facts out.',
    typicalInTokens: 4_610,
    typicalOutTokens: 280,
    callsPerUse: 1
  },
  {
    id: 'reader.v7:card',
    prompt: 'reader.v7',
    feature: 'reader',
    existing: true,
    phase: 'P2b',
    tier: 'fast',
    trigger: 'background',
    when: 'An instant card that is out of date: one reader.v7 window read for its scene (about one card in five).',
    typicalInTokens: 4_610,
    typicalOutTokens: 280,
    callsPerUse: 1
  }
]

/** A whole task the author pays for, as the planned rows it runs (design Part 5). */
export interface PlannedTask {
  id: string
  label: string
  calls: readonly { row: string; calls: number }[]
}

/**
 * The design's tasks (Part 5), built from the planned rows. Totals add the design's 5 % for
 * retries (`PLANNED_RETRY_FACTOR`); cached input is not discounted.
 */
export const PLANNED_TASK_COSTS: readonly PlannedTask[] = [
  {
    id: 'index',
    label: 'Index the book once (= Rebuild memory; 90 scenes)',
    calls: [
      { row: 'reader.v2:first', calls: 90 },
      { row: 'verify.v2', calls: 90 },
      { row: 'judge.v1', calls: 12 },
      { row: 'verify.v2:spot', calls: 50 },
      { row: 'verify.v2:pro', calls: 20 }
    ]
  },
  {
    id: 'session',
    label: 'A 2-hour writing session (3 card refreshes, about one needing a read)',
    calls: [
      { row: 'reader.v2:window', calls: 12 },
      { row: 'reader.v2:card', calls: 1 },
      { row: 'verify.v2', calls: 12 },
      { row: 'judge.v1', calls: 4 },
      { row: 'planLinks.v2', calls: 2 }
    ]
  },
  {
    id: 'lookup',
    label: 'A lookup through Ms Scribe',
    calls: [
      { row: 'agent.v9:lookup', calls: 1 },
      { row: 'cite.v1', calls: 1 }
    ]
  },
  {
    id: 'openQuestion',
    label: 'An open question',
    calls: [
      { row: 'navigator.v1', calls: 2 },
      { row: 'agent.v9:open', calls: 1 },
      { row: 'cite.v1', calls: 1 }
    ]
  },
  {
    id: 'openQuestionWidened',
    label: 'An open question, widened (about one in five)',
    calls: [
      { row: 'navigator.v1', calls: 3 },
      { row: 'agent.v9:need', calls: 1 },
      { row: 'agent.v9:widened', calls: 1 },
      { row: 'cite.v1', calls: 1 }
    ]
  },
  {
    id: 'checkBook',
    label: 'Check the book',
    calls: [
      { row: 'judge.v1', calls: 20 },
      { row: 'judge.v1:pro', calls: 20 }
    ]
  },
  {
    id: 'upload',
    label: 'File a 20,000-word upload, once',
    calls: [{ row: 'contextImport.v3', calls: 14 }]
  },
  {
    id: 'whatIf',
    label: 'A what-if (P5): 5 Try turns and 1 Version',
    calls: [
      { row: 'navigator.v1', calls: 2 * 5 },
      { row: 'agent.v9:try', calls: 5 },
      { row: 'agent.v9:version', calls: 1 }
    ]
  },
  {
    id: 'heavyMonth',
    label:
      'A heavy month (20 sessions, 30 cards, 20 lookups, 50 open questions with 10 widened, 2 checks, 1 what-if)',
    calls: [
      { row: 'reader.v2:window', calls: 12 * 20 },
      { row: 'reader.v2:card', calls: 20 + 6 },
      { row: 'verify.v2', calls: 12 * 20 },
      { row: 'judge.v1', calls: 4 * 20 + 20 * 2 },
      { row: 'planLinks.v2', calls: 2 * 20 },
      { row: 'agent.v9:lookup', calls: 20 },
      { row: 'navigator.v1', calls: 2 * 40 + 3 * 10 + 2 * 5 },
      { row: 'agent.v9:open', calls: 40 },
      { row: 'agent.v9:need', calls: 10 },
      { row: 'agent.v9:widened', calls: 10 },
      { row: 'cite.v1', calls: 20 + 50 },
      { row: 'judge.v1:pro', calls: 20 * 2 },
      { row: 'agent.v9:try', calls: 5 },
      { row: 'agent.v9:version', calls: 1 }
    ]
  }
]

/** The design's allowance for retries on every planned task (Part 5 assumptions). */
export const PLANNED_RETRY_FACTOR = 1.05
