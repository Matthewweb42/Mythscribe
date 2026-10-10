import type { AiFeatureId } from './ai'

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
      'The most frequent call: keep the caret window small; stable prefix for provider caching; consider a smaller/faster model; skip when the author is deleting.'
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
    when: 'Indexing: once per scene after edits settle (content-hash cached), and for every stale scene after open; a new prompt version re-reads the book only after the author confirms the cost (F-9.14 conversion dialog).',
    callsPerUse: 1,
    typicalOutTokens: 600,
    ideas:
      'The biggest background spend on a large book: batch API when latency allows; skip tiny edits; cap scene text sent; one pass also yields facts, tags, the scene card, relationships, and thread events (summary.v4 added about 150 output tokens); drop empty lists from the JSON shape if the ledger shows cut-offs.'
  },
  chat: {
    trigger: 'on request',
    when: 'Plan-mode brainstorming and Author-mode drafting from the chat.',
    callsPerUse: 1,
    typicalOutTokens: 400,
    ideas: 'Trim history turns sooner; keep the voice block only where prose is written.'
  },
  authorMode: {
    trigger: 'on request',
    when: 'Author-mode placement (shares the chat prompt; no prompt of its own).',
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
    when: "Editor's notes on one scene.",
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
    ideas: 'Answer length tracks the selection: set max_tokens from the selection size.'
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
    when: 'What should come next? Three directions for the scene.',
    callsPerUse: 1,
    typicalOutTokens: 200,
    ideas: 'Cheap already; cache per caret context.'
  },
  route: {
    trigger: 'every chat message',
    when: 'Classifies an Auto/Ask message to pick the feature (skipped for exact action names).',
    callsPerUse: 1,
    typicalOutTokens: 40,
    ideas: 'Local keyword match first; merge into the agent step to save a round trip.'
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
    when: 'Suggest key points for a scene’s notes.',
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
    when: 'An Editor-tab pass: one request per scene piece across the chosen scenes.',
    callsPerUse: 60,
    typicalOutTokens: 1500,
    ideas:
      'The largest single job: batch API, fast tier for copy/proofread passes (already), skip unchanged scenes on re-runs.'
  },
  agent: {
    trigger: 'every chat message',
    when: 'Auto/Ask/Plan chat: research steps then an answer (up to 6 lookups; since agent.v6 a ladder: lookup ≤ 1,200 characters, scene cards ~100 tokens each, local passage search, whole scenes last); prose drafts stream separately. Since agent.v7 (F-5.25) a bulk delete is one clear edit answered without lookups (the clear itself runs locally, no AI); the bulk rules, the organise rule, and the bulk and story-bible edits add ~250 input tokens to a read request and ~470 to a write request (a cached prefix).',
    callsPerUse: 3,
    typicalOutTokens: 300,
    ideas:
      'Check the agent.v6 ladder against the ledger (fixtures: a fact question: the answer step 44 % less input than v5, the whole three-request run 25 % less); fast tier for lookup steps, strong only for the answer; answer a lookup-only question in one step.'
  },
  contextImport: {
    trigger: 'on request',
    when: 'Sorting uploaded worldbuilding files: one request per ~8,000-character piece.',
    callsPerUse: 10,
    typicalOutTokens: 1500,
    ideas: 'Fast tier for simple lists; skip unchanged files (already); batch API.'
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
    when: 'A message on the upload review screen that changes the pending plan.',
    callsPerUse: 1,
    typicalOutTokens: 300,
    ideas: 'Send a compact review summary instead of every record.'
  }
}
