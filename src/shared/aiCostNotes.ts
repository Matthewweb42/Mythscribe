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
    when: 'Beta reader reaction to a scene, reading earlier summaries.',
    callsPerUse: 1,
    typicalOutTokens: 700,
    ideas: 'Strong tier: try fast tier with a tighter rubric and compare quality.'
  },
  importStructure: {
    trigger: 'on request',
    when: 'Detect chapters/scenes in an imported manuscript, one request per ~2,500 words.',
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
    when: 'Classifies an Auto/Ask message to pick the feature (skipped for exact action names). Since route.v2 (F-5.26) it also picks an edit pass (its type or "ask", and the selection, scene, or chapter): ~200 more input tokens in the cached system turn, ~15 more output tokens on an edit request.',
    callsPerUse: 1,
    typicalOutTokens: 40,
    ideas:
      'Local keyword match first; merge into the agent step to save a round trip. A quick pick on an edit request (F-5.26) costs no routing: it starts the pass directly.'
  },
  synopsis: {
    trigger: 'on request',
    when: 'Suggest a synopsis for a scene.',
    callsPerUse: 1,
    typicalOutTokens: 120,
    ideas: 'Derive from the stored summary without re-sending the scene.'
  },
  notesSuggest: {
    trigger: 'on request',
    when: 'Suggest key points for a scene’s notes. Story memory v2 (F-16.14) sends notesSuggest.v3: the Story notes block in the bible’s slot; about 60 tokens less than v2 (fixtures: 903 vs 961 typical, 4,774 vs 4,798 worst).',
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
    when: 'Auto/Ask/Plan chat: research steps then an answer (up to 6 lookups; since agent.v6 a ladder: lookup ≤ 1,200 characters, scene cards ~100 tokens each, local passage search, whole scenes last); prose drafts stream separately. Since agent.v7 (F-5.25) a bulk delete is one clear edit answered without lookups (the clear itself runs locally, no AI); the bulk rules, the organise rule, and the bulk and story-bible edits add ~250 input tokens to a read request and ~470 to a write request (a cached prefix). Since agent.v8 (F-5.25 fixes 5, 7, 8) the write edit list gains status, To do settle, notes clearing, undo, summaries, and open: ~110 more input tokens on a write request, none on a read request; the todo tool prints a short ref per item (~2 tokens each). The actions themselves run locally (summaries queue the existing summary jobs).',
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
    when: 'About 20 s after a summary run (and from Find links): links planned scenes and template beats to the written scene that fulfils them.',
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
    id: 'reader.v1:first',
    prompt: 'reader.v1',
    feature: 'reader',
    existing: false,
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
    existing: false,
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
    existing: false,
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
    existing: false,
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
    existing: false,
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
    existing: false,
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
    when: 'Suggest a synopsis, re-pointed from the summary to the scene card; priced like synopsis.v1.',
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
    when: 'Suggest key points for the notes, re-pointed to the scene card (P1 shipped notesSuggest.v3, the Story notes heading; decision P1-D7); priced like notesSuggest.v2.',
    typicalInTokens: 961,
    typicalOutTokens: 300,
    callsPerUse: 1
  },
  {
    id: 'reader.v2:first',
    prompt: 'reader.v2',
    feature: 'reader',
    existing: false,
    phase: 'P2b',
    tier: 'fast',
    trigger: 'background',
    when: 'reader.v1:first with knows and thread claims added; replaces it from P2b; priced like it until measured.',
    typicalInTokens: 3_800,
    typicalOutTokens: 520,
    callsPerUse: 1
  },
  {
    id: 'reader.v2:window',
    prompt: 'reader.v2',
    feature: 'reader',
    existing: false,
    phase: 'P2b',
    tier: 'fast',
    trigger: 'background',
    when: 'reader.v1:window with knows and thread claims added; replaces it from P2b; priced like it until measured.',
    typicalInTokens: 4_000,
    typicalOutTokens: 300,
    callsPerUse: 1
  },
  {
    id: 'verify.v2',
    prompt: 'verify.v2',
    feature: 'verify',
    existing: false,
    phase: 'P2b',
    tier: 'fast',
    trigger: 'background',
    when: 'verify.v1 with knows and thread claims; replaces it from P2b; priced like it until measured.',
    typicalInTokens: 1_300,
    typicalOutTokens: 110,
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
    when: 'Plan links applied automatically after a scene settles (decision 2).',
    typicalInTokens: 1_500,
    typicalOutTokens: 100,
    callsPerUse: 1
  },
  {
    id: 'navigator.v1',
    prompt: 'navigator.v1',
    feature: 'navigator',
    existing: false,
    phase: 'P3',
    tier: 'fast',
    trigger: 'every chat message',
    when: 'An open question: up to two steps choosing which passages Ms Scribe reads.',
    typicalInTokens: 6_000,
    typicalOutTokens: 150,
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
    when: 'Ms Scribe answers an open question from the passages the navigator found.',
    typicalInTokens: 6_500,
    typicalOutTokens: 350,
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
    when: 'An open question the first passages could not answer, widened to more passages (about one question in five).',
    typicalInTokens: 13_000,
    typicalOutTokens: 400,
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
    when: 'Ms Scribe answers a lookup that the instant answers (F-16.24) could not.',
    typicalInTokens: 4_500,
    typicalOutTokens: 120,
    callsPerUse: 1
  },
  {
    id: 'cite.v1',
    prompt: 'cite.v1',
    feature: 'cite',
    existing: false,
    phase: 'P3',
    tier: 'fast',
    trigger: 'every chat message',
    when: 'After each answer: checks every citation against its passage.',
    typicalInTokens: 1_000,
    typicalOutTokens: 60,
    callsPerUse: 1
  },
  {
    id: 'judge.v1',
    prompt: 'judge.v1',
    feature: 'judge',
    existing: false,
    phase: 'P4',
    tier: 'fast',
    trigger: 'background',
    when: 'Up to 10 contradiction pairs per call, each judged twice with the quotes swapped.',
    typicalInTokens: 1_500,
    typicalOutTokens: 300,
    callsPerUse: 1
  },
  {
    id: 'judge.v1:pro',
    prompt: 'judge.v1',
    feature: 'judge',
    existing: false,
    phase: 'P4',
    tier: 'strong',
    trigger: 'on request',
    when: 'Check the book: the strong model confirms up to 20 pairs called a contradiction both ways.',
    typicalInTokens: 600,
    typicalOutTokens: 90,
    callsPerUse: 1
  },
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
 * The story-memory rows that have shipped (F-16.9, P1 slice 5): their features' notes are in
 * `AI_COST_NOTES` now (the registry's per-feature table shows them), and these rows keep the
 * design's sizes so the planned tasks that run them ("File a 20,000-word upload, once") stay
 * priced from the same figures.
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
      { row: 'reader.v1:first', calls: 90 },
      { row: 'verify.v1', calls: 90 },
      { row: 'judge.v1', calls: 12 },
      { row: 'verify.v1:spot', calls: 50 },
      { row: 'verify.v1:pro', calls: 20 }
    ]
  },
  {
    id: 'session',
    label: 'A 2-hour writing session (3 card refreshes, about one needing a read)',
    calls: [
      { row: 'reader.v1:window', calls: 12 },
      { row: 'reader.v1:card', calls: 1 },
      { row: 'verify.v1', calls: 12 },
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
      { row: 'reader.v1:window', calls: 12 * 20 },
      { row: 'reader.v1:card', calls: 20 + 6 },
      { row: 'verify.v1', calls: 12 * 20 },
      { row: 'judge.v1', calls: 4 * 20 + 20 * 2 },
      { row: 'planLinks.v2', calls: 2 * 20 },
      { row: 'agent.v9:lookup', calls: 20 },
      { row: 'navigator.v1', calls: 2 * 40 + 3 * 10 + 2 * 5 },
      { row: 'agent.v9:open', calls: 40 },
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
