import { inputBudget, type AiFeatureId, type Tier } from '@shared/ai'
import { BETA_READER_PROMPT_VERSION } from './betaReader.v1'
import { BETA_READER_REGEN_PROMPT_VERSION } from './betaReaderRegen.v1'
import { BRIEF_PROMPT_VERSION } from './brief.v1'
import { CHAT_PROMPT_VERSION } from './chat.v1'
import { CHAT_PROMPT_V2_VERSION } from './chat.v2'
import { CHAT_PROMPT_V3_VERSION } from './chat.v3'
import { CHAT_PROMPT_V4_VERSION } from './chat.v4'
import { CHAT_REGEN_PROMPT_VERSION } from './chatRegen.v1'
import { CHAT_REGEN_PROMPT_V2_VERSION } from './chatRegen.v2'
import { CHAT_REGEN_PROMPT_V3_VERSION } from './chatRegen.v3'
import { CHAT_REGEN_PROMPT_V4_VERSION } from './chatRegen.v4'
import { CONTINUITY_PROMPT_VERSION } from './continuity.v1'
import { CRITIQUE_PROMPT_VERSION } from './critique.v1'
import { CRITIQUE_PROMPT_V2_VERSION } from './critique.v2'
import { CRITIQUE_PROMPT_V3_VERSION } from './critique.v3'
import { CRITIQUE_REGEN_PROMPT_VERSION } from './critiqueRegen.v1'
import { CRITIQUE_REGEN_PROMPT_V2_VERSION } from './critiqueRegen.v2'
import { CRITIQUE_REGEN_PROMPT_V3_VERSION } from './critiqueRegen.v3'
import { GHOST_PROMPT_VERSION } from './ghostText.v1'
import { GHOST_PROMPT_V2_VERSION } from './ghostText.v2'
import { GHOST_PROMPT_V3_VERSION } from './ghostText.v3'
import { GHOST_PROMPT_V4_VERSION } from './ghostText.v4'
import { GHOST_REGEN_PROMPT_VERSION } from './ghostTextRegen.v1'
import { GHOST_REGEN_PROMPT_V2_VERSION } from './ghostTextRegen.v2'
import { GHOST_REGEN_PROMPT_V3_VERSION } from './ghostTextRegen.v3'
import { GHOST_REGEN_PROMPT_V4_VERSION } from './ghostTextRegen.v4'
import { IMPORT_STRUCTURE_PROMPT_VERSION } from './importStructure.v1'
import { PROOFREAD_PROMPT_VERSION } from './proofread.v1'
import { QUERY_PROMPT_VERSION } from './query.v1'
import { QUERY_PROMPT_V2_VERSION } from './query.v2'
import { QUERY_PROMPT_V3_VERSION } from './query.v3'
import { REWRITE_PROMPT_VERSION } from './rewrite.v1'
import { REWRITE_PROMPT_V2_VERSION } from './rewrite.v2'
import { REWRITE_PROMPT_V3_VERSION } from './rewrite.v3'
import { REWRITE_PROMPT_V4_VERSION } from './rewrite.v4'
import { REWRITE_REGEN_PROMPT_VERSION } from './rewriteRegen.v1'
import { REWRITE_REGEN_PROMPT_V2_VERSION } from './rewriteRegen.v2'
import { REWRITE_REGEN_PROMPT_V3_VERSION } from './rewriteRegen.v3'
import { REWRITE_REGEN_PROMPT_V4_VERSION } from './rewriteRegen.v4'
import { SUMMARY_PROMPT_VERSION } from './summary.v1'
import { SUMMARY_PROMPT_V2_VERSION } from './summary.v2'
import { SUMMARY_PROMPT_V3_VERSION } from './summary.v3'
import { SUMMARY_PROMPT_V4_VERSION } from './summary.v4'
import { SUMMARY_PROMPT_V5_VERSION } from './summary.v5'
import { TAGS_PROMPT_VERSION } from './tags.v1'
import { VOICE_NOTES_PROMPT_VERSION } from './voiceNotes.v1'
import { TAGS_REGEN_PROMPT_VERSION } from './tagsRegen.v1'
import { WHAT_NEXT_PROMPT_VERSION } from './whatNext.v1'
import { WHAT_NEXT_PROMPT_V2_VERSION } from './whatNext.v2'
import { CHAT_PROMPT_V5_VERSION } from './chat.v5'
import { CHAT_REGEN_PROMPT_V5_VERSION } from './chatRegen.v5'
import { QUERY_PROMPT_V4_VERSION } from './query.v4'
import { ROUTE_PROMPT_VERSION } from './route.v1'
import { SYNOPSIS_PROMPT_VERSION } from './synopsis.v1'
import { NOTES_SUGGEST_PROMPT_VERSION } from './notesSuggest.v1'
import { AGENT_PROMPT_VERSION } from './agent.v1'
import { AGENT_PROMPT_V2_VERSION } from './agent.v2'
import { EDIT_PASS_PROMPT_VERSION } from './editPass.v1'
import { EDIT_PASS_PROMPT_V2_VERSION } from './editPass.v2'
import { CONTEXT_IMPORT_PROMPT_VERSION } from './contextImport.v1'
import { REVIEW_CHAT_PROMPT_VERSION } from './reviewChat.v1'
import { AGENT_PROMPT_V3_VERSION } from './agent.v3'
import { CONTINUITY_PROMPT_V2_VERSION } from './continuity.v2'
import { WHAT_NEXT_PROMPT_V3_VERSION } from './whatNext.v3'
import { NOTES_SUGGEST_PROMPT_V2_VERSION } from './notesSuggest.v2'
import { PLAN_LINKS_PROMPT_VERSION } from './planLinks.v1'
import { CONTEXT_IMPORT_PROMPT_V2_VERSION } from './contextImport.v2'
import { REVIEW_CHAT_PROMPT_V2_VERSION } from './reviewChat.v2'
import { ORGANISE_PROMPT_VERSION } from './organise.v1'
import { ORGANISE_PROMPT_V2_VERSION } from './organise.v2'
import { AGENT_PROMPT_V4_VERSION } from './agent.v4'
import { AGENT_PROMPT_V5_VERSION } from './agent.v5'
import { AGENT_PROMPT_V6_VERSION } from './agent.v6'
import { AGENT_PROMPT_V7_VERSION } from './agent.v7'
import { AGENT_PROMPT_V8_VERSION } from './agent.v8'
import { TODO_PROMPT_VERSION } from './todo.v1'
import { TODO_SUGGEST_PROMPT_VERSION } from './todoSuggest.v1'
import { SHEET_REFILE_PROMPT_VERSION } from './sheetRefile.v1'
import { SHEET_WRITE_UP_PROMPT_VERSION } from './sheetWriteUp.v1'
import { GHOST_PROMPT_V5_VERSION } from './ghostText.v5'
import { GHOST_REGEN_PROMPT_V5_VERSION } from './ghostTextRegen.v5'
import { REWRITE_PROMPT_V5_VERSION } from './rewrite.v5'
import { REWRITE_REGEN_PROMPT_V5_VERSION } from './rewriteRegen.v5'
import { CHAT_PROMPT_V6_VERSION } from './chat.v6'
import { CHAT_REGEN_PROMPT_V6_VERSION } from './chatRegen.v6'
import { CRITIQUE_PROMPT_V4_VERSION } from './critique.v4'
import { CRITIQUE_REGEN_PROMPT_V4_VERSION } from './critiqueRegen.v4'
import { EDIT_PASS_PROMPT_V3_VERSION } from './editPass.v3'
import { WHAT_NEXT_PROMPT_V4_VERSION } from './whatNext.v4'
import { NOTES_SUGGEST_PROMPT_V3_VERSION } from './notesSuggest.v3'
import { CONTEXT_IMPORT_PROMPT_V3_VERSION } from './contextImport.v3'
import { REVIEW_CHAT_PROMPT_V3_VERSION } from './reviewChat.v3'
import { ROUTE_PROMPT_V2_VERSION } from './route.v2'
import { IMPORT_STRUCTURE_PROMPT_V2_VERSION } from './importStructure.v2'
import { READER_PROMPT_VERSION } from './reader.v1'
import { VERIFY_PROMPT_VERSION } from './verify.v1'
import { BETA_READER_PROMPT_V2_VERSION } from './betaReader.v2'
import { BETA_READER_REGEN_PROMPT_V2_VERSION } from './betaReaderRegen.v2'
import { SYNOPSIS_PROMPT_V2_VERSION } from './synopsis.v2'
import { NOTES_SUGGEST_PROMPT_V4_VERSION } from './notesSuggest.v4'
import { PLAN_LINKS_PROMPT_V2_VERSION } from './planLinks.v2'
import { READER_V2_PROMPT_VERSION } from './reader.v2'
import { VERIFY_V2_PROMPT_VERSION } from './verify.v2'
import { AGENT_PROMPT_V9_VERSION } from './agent.v9'
import { CITE_PROMPT_VERSION } from './cite.v1'
import { NAVIGATOR_PROMPT_VERSION } from './navigator.v1'
import { JUDGE_PROMPT_VERSION } from './judge.v1'
import { READER_V3_PROMPT_VERSION } from './reader.v3'
import { READER_V4_PROMPT_VERSION } from './reader.v4'
import { VERIFY_V3_PROMPT_VERSION } from './verify.v3'
import { READER_V5_PROMPT_VERSION } from './reader.v5'
import { VERIFY_V4_PROMPT_VERSION } from './verify.v4'
import { READER_V6_PROMPT_VERSION } from './reader.v6'
import { READER_V7_PROMPT_VERSION } from './reader.v7'
import { SCRIBE_PROMPT_VERSION } from './scribe.v1'
import { SCRIBE_V2_PROMPT_VERSION } from './scribe.v2'
import { EDIT_FLOW_PROMPT_VERSION } from './editFlow.v1'
import { EDIT_NOTES_PROMPT_VERSION } from './editNotes.v1'

/**
 * The catalogue of shipped prompt versions (F-5.12): one entry per `<feature>.v<N>.ts` file in
 * this folder, keyed by the version string the file exports and the ledger records. The eval
 * harness (`src/main/ai/eval/`) requires every entry to have at least one case, and the token
 * report is grouped in this order, so adding a prompt file without a catalogue entry, or an
 * entry without cases, fails `npm run test`.
 *
 * Shipped versions are immutable: their text is pinned by their golden tests and their token
 * footprint by the committed token report, so a ledger row's version always names the exact
 * messages that were sent. A superseded version stays catalogued (a ledger row from before the
 * change still names it); the features send the newest one.
 */
export const PROMPT_VERSIONS = [
  GHOST_PROMPT_VERSION,
  GHOST_REGEN_PROMPT_VERSION,
  GHOST_PROMPT_V2_VERSION,
  GHOST_REGEN_PROMPT_V2_VERSION,
  GHOST_PROMPT_V3_VERSION,
  GHOST_REGEN_PROMPT_V3_VERSION,
  GHOST_PROMPT_V4_VERSION,
  GHOST_REGEN_PROMPT_V4_VERSION,
  TAGS_PROMPT_VERSION,
  TAGS_REGEN_PROMPT_VERSION,
  CHAT_PROMPT_VERSION,
  CHAT_REGEN_PROMPT_VERSION,
  CHAT_PROMPT_V2_VERSION,
  CHAT_REGEN_PROMPT_V2_VERSION,
  CHAT_PROMPT_V3_VERSION,
  CHAT_REGEN_PROMPT_V3_VERSION,
  CHAT_PROMPT_V4_VERSION,
  CHAT_REGEN_PROMPT_V4_VERSION,
  REWRITE_PROMPT_VERSION,
  REWRITE_REGEN_PROMPT_VERSION,
  REWRITE_PROMPT_V2_VERSION,
  REWRITE_REGEN_PROMPT_V2_VERSION,
  REWRITE_PROMPT_V3_VERSION,
  REWRITE_REGEN_PROMPT_V3_VERSION,
  CRITIQUE_PROMPT_VERSION,
  CRITIQUE_REGEN_PROMPT_VERSION,
  CRITIQUE_PROMPT_V2_VERSION,
  CRITIQUE_REGEN_PROMPT_V2_VERSION,
  CRITIQUE_PROMPT_V3_VERSION,
  CRITIQUE_REGEN_PROMPT_V3_VERSION,
  BETA_READER_PROMPT_VERSION,
  BETA_READER_REGEN_PROMPT_VERSION,
  BRIEF_PROMPT_VERSION,
  SUMMARY_PROMPT_VERSION,
  SUMMARY_PROMPT_V2_VERSION,
  SUMMARY_PROMPT_V3_VERSION,
  SUMMARY_PROMPT_V4_VERSION,
  QUERY_PROMPT_VERSION,
  QUERY_PROMPT_V2_VERSION,
  QUERY_PROMPT_V3_VERSION,
  IMPORT_STRUCTURE_PROMPT_VERSION,
  CONTINUITY_PROMPT_VERSION,
  PROOFREAD_PROMPT_VERSION,
  WHAT_NEXT_PROMPT_VERSION,
  WHAT_NEXT_PROMPT_V2_VERSION,
  CHAT_PROMPT_V5_VERSION,
  CHAT_REGEN_PROMPT_V5_VERSION,
  QUERY_PROMPT_V4_VERSION,
  ROUTE_PROMPT_VERSION,
  SYNOPSIS_PROMPT_VERSION,
  NOTES_SUGGEST_PROMPT_VERSION,
  VOICE_NOTES_PROMPT_VERSION,
  EDIT_PASS_PROMPT_VERSION,
  AGENT_PROMPT_VERSION,
  AGENT_PROMPT_V2_VERSION,
  CONTEXT_IMPORT_PROMPT_VERSION,
  REVIEW_CHAT_PROMPT_VERSION,
  AGENT_PROMPT_V3_VERSION,
  CONTINUITY_PROMPT_V2_VERSION,
  WHAT_NEXT_PROMPT_V3_VERSION,
  NOTES_SUGGEST_PROMPT_V2_VERSION,
  PLAN_LINKS_PROMPT_VERSION,
  CONTEXT_IMPORT_PROMPT_V2_VERSION,
  REVIEW_CHAT_PROMPT_V2_VERSION,
  ORGANISE_PROMPT_VERSION,
  AGENT_PROMPT_V4_VERSION,
  ORGANISE_PROMPT_V2_VERSION,
  // The suggestions first, so the cost registry's row for `todo` shows the check (its last version).
  TODO_SUGGEST_PROMPT_VERSION,
  TODO_PROMPT_VERSION,
  AGENT_PROMPT_V5_VERSION,
  AGENT_PROMPT_V6_VERSION,
  AGENT_PROMPT_V7_VERSION,
  // F-5.6: the scene's mood and theme (the reading, then the prose edits that carry them).
  SUMMARY_PROMPT_V5_VERSION,
  REWRITE_PROMPT_V4_VERSION,
  REWRITE_REGEN_PROMPT_V4_VERSION,
  EDIT_PASS_PROMPT_V2_VERSION,
  AGENT_PROMPT_V8_VERSION,
  // The filing first, so the cost registry's row for `sheetSync` shows the write-up (its last version).
  SHEET_REFILE_PROMPT_VERSION,
  SHEET_WRITE_UP_PROMPT_VERSION,
  ROUTE_PROMPT_V2_VERSION,
  // F-16.14 (story memory v2 only): the Story notes block in the bible's slot; v1 keeps the old ones.
  GHOST_PROMPT_V5_VERSION,
  GHOST_REGEN_PROMPT_V5_VERSION,
  REWRITE_PROMPT_V5_VERSION,
  REWRITE_REGEN_PROMPT_V5_VERSION,
  CHAT_PROMPT_V6_VERSION,
  CHAT_REGEN_PROMPT_V6_VERSION,
  CRITIQUE_PROMPT_V4_VERSION,
  CRITIQUE_REGEN_PROMPT_V4_VERSION,
  EDIT_PASS_PROMPT_V3_VERSION,
  WHAT_NEXT_PROMPT_V4_VERSION,
  NOTES_SUGGEST_PROMPT_V3_VERSION,
  // F-16.9 (story memory v2 only): filing an upload into Pinned, and its review chat.
  CONTEXT_IMPORT_PROMPT_V3_VERSION,
  REVIEW_CHAT_PROMPT_V3_VERSION,
  // F-16.15 (story memory v2 only): the import's structure pass without the tag bank.
  IMPORT_STRUCTURE_PROMPT_V2_VERSION,
  // F-16.17 (story memory v2 only): the evidence reader and its fact checker.
  READER_PROMPT_VERSION,
  VERIFY_PROMPT_VERSION,
  BETA_READER_PROMPT_V2_VERSION,
  BETA_READER_REGEN_PROMPT_V2_VERSION,
  SYNOPSIS_PROMPT_V2_VERSION,
  NOTES_SUGGEST_PROMPT_V4_VERSION,
  PLAN_LINKS_PROMPT_V2_VERSION,
  // F-16.22, F-16.23 (story memory v2 only): who knows what and plot threads; v1 stays for its rows.
  READER_V2_PROMPT_VERSION,
  VERIFY_V2_PROMPT_VERSION,
  // F-16.25, F-16.26 (story memory v2 only): Ms Scribe's one answer call; v1 keeps agent.v8.
  AGENT_PROMPT_V9_VERSION,
  // F-16.25 (story memory v2 only): Ms Scribe's quote check.
  CITE_PROMPT_VERSION,
  // F-16.25 (story memory v2 only): Ms Scribe's navigator; v1 keeps route.v2.
  NAVIGATOR_PROMPT_VERSION,
  // F-16.27 (story memory v2 only): the contradiction judge (and Check the book's stronger check).
  JUDGE_PROMPT_VERSION,
  // F-16.17 (story memory v2 only, after the live planted-error run of 2026-10-14): compact facts,
  // the slot list, the subject in the quote; smaller pages. v2 stays for its rows.
  READER_V3_PROMPT_VERSION,
  VERIFY_V3_PROMPT_VERSION,
  // F-16.17 (second live run of 2026-10-14): the slot list first, the value rules, a 1,000 cap.
  READER_V4_PROMPT_VERSION,
  // F-16.17 (third live run of 2026-10-14, plan ReaderPrecision.md): the field "src" for "voice",
  // the open-ended slots' value rules; the checker's open-ended rules, sent on the strong tier.
  READER_V5_PROMPT_VERSION,
  VERIFY_V4_PROMPT_VERSION,
  // F-16.17 (the author's decision of 2026-10-14, plan ReaderNarrow.md): concrete facts only.
  READER_V6_PROMPT_VERSION,
  // F-16.17 (the author's decision of 2026-10-14, plan Suggestions.md): every fact a suggestion,
  // traits and history read again.
  READER_V7_PROMPT_VERSION,
  // Notes redesign phase 1 (story memory v1): Ms Scribe with the notes and the book in view.
  SCRIBE_PROMPT_VERSION,
  SCRIBE_V2_PROMPT_VERSION,
  // Notes redesign phase 2: the edit flow's stages and checks, and its Update notes.
  EDIT_FLOW_PROMPT_VERSION,
  EDIT_NOTES_PROMPT_VERSION
] as const
export type PromptVersion = (typeof PROMPT_VERSIONS)[number]

export interface PromptEntry {
  /** The feature whose budgets the version is measured against. */
  feature: AiFeatureId
  /** The tier the feature requests it on (CLAUDE.md, token rule 1). */
  tier: Tier
  /** Whether the model answers in prose or in JSON (`json: true` on the request). */
  output: 'text' | 'json'
  /** The feature ID that introduced the version, for the report. */
  since: string
}

export const PROMPT_CATALOGUE: Record<PromptVersion, PromptEntry> = {
  [GHOST_PROMPT_VERSION]: { feature: 'ghostText', tier: 'fast', output: 'text', since: 'F-5.3' },
  [GHOST_REGEN_PROMPT_VERSION]: {
    feature: 'ghostText',
    tier: 'fast',
    output: 'text',
    since: 'F-14.7'
  },
  [GHOST_PROMPT_V2_VERSION]: {
    feature: 'ghostText',
    tier: 'fast',
    output: 'text',
    since: 'F-14.3'
  },
  [GHOST_REGEN_PROMPT_V2_VERSION]: {
    feature: 'ghostText',
    tier: 'fast',
    output: 'text',
    since: 'F-14.3'
  },
  [GHOST_PROMPT_V3_VERSION]: {
    feature: 'ghostText',
    tier: 'fast',
    output: 'text',
    since: 'F-14.9'
  },
  [GHOST_REGEN_PROMPT_V3_VERSION]: {
    feature: 'ghostText',
    tier: 'fast',
    output: 'text',
    since: 'F-14.9'
  },
  [GHOST_PROMPT_V4_VERSION]: {
    feature: 'ghostText',
    tier: 'fast',
    output: 'text',
    since: 'F-14.13'
  },
  [GHOST_REGEN_PROMPT_V4_VERSION]: {
    feature: 'ghostText',
    tier: 'fast',
    output: 'text',
    since: 'F-14.13'
  },
  [TAGS_PROMPT_VERSION]: { feature: 'tags', tier: 'fast', output: 'json', since: 'F-4.7' },
  [TAGS_REGEN_PROMPT_VERSION]: { feature: 'tags', tier: 'fast', output: 'json', since: 'F-14.5' },
  [CHAT_PROMPT_VERSION]: { feature: 'chat', tier: 'fast', output: 'text', since: 'F-5.4' },
  [CHAT_REGEN_PROMPT_VERSION]: { feature: 'chat', tier: 'fast', output: 'text', since: 'F-5.4' },
  [CHAT_PROMPT_V2_VERSION]: { feature: 'chat', tier: 'fast', output: 'text', since: 'F-14.3' },
  [CHAT_REGEN_PROMPT_V2_VERSION]: {
    feature: 'chat',
    tier: 'fast',
    output: 'text',
    since: 'F-14.3'
  },
  [CHAT_PROMPT_V3_VERSION]: { feature: 'chat', tier: 'fast', output: 'text', since: 'F-14.9' },
  [CHAT_REGEN_PROMPT_V3_VERSION]: {
    feature: 'chat',
    tier: 'fast',
    output: 'text',
    since: 'F-14.9'
  },
  [CHAT_PROMPT_V4_VERSION]: {
    feature: 'chat',
    tier: 'fast',
    output: 'text',
    since: 'F-14.13'
  },
  [CHAT_REGEN_PROMPT_V4_VERSION]: {
    feature: 'chat',
    tier: 'fast',
    output: 'text',
    since: 'F-14.13'
  },
  [REWRITE_PROMPT_VERSION]: {
    feature: 'rewrite',
    tier: 'strong',
    output: 'text',
    since: 'F-14.10'
  },
  [REWRITE_REGEN_PROMPT_VERSION]: {
    feature: 'rewrite',
    tier: 'strong',
    output: 'text',
    since: 'F-14.10'
  },
  [REWRITE_PROMPT_V2_VERSION]: {
    feature: 'rewrite',
    tier: 'strong',
    output: 'text',
    since: 'F-14.9'
  },
  [REWRITE_REGEN_PROMPT_V2_VERSION]: {
    feature: 'rewrite',
    tier: 'strong',
    output: 'text',
    since: 'F-14.9'
  },
  [REWRITE_PROMPT_V3_VERSION]: {
    feature: 'rewrite',
    tier: 'strong',
    output: 'text',
    since: 'F-14.13'
  },
  [REWRITE_REGEN_PROMPT_V3_VERSION]: {
    feature: 'rewrite',
    tier: 'strong',
    output: 'text',
    since: 'F-14.13'
  },
  [CRITIQUE_PROMPT_VERSION]: {
    feature: 'critique',
    tier: 'strong',
    output: 'json',
    since: 'F-14.8'
  },
  [CRITIQUE_REGEN_PROMPT_VERSION]: {
    feature: 'critique',
    tier: 'strong',
    output: 'json',
    since: 'F-14.8'
  },
  [CRITIQUE_PROMPT_V2_VERSION]: {
    feature: 'critique',
    tier: 'strong',
    output: 'json',
    since: 'F-14.3'
  },
  [CRITIQUE_REGEN_PROMPT_V2_VERSION]: {
    feature: 'critique',
    tier: 'strong',
    output: 'json',
    since: 'F-14.3'
  },
  [CRITIQUE_PROMPT_V3_VERSION]: {
    feature: 'critique',
    tier: 'strong',
    output: 'json',
    since: 'F-14.9'
  },
  [CRITIQUE_REGEN_PROMPT_V3_VERSION]: {
    feature: 'critique',
    tier: 'strong',
    output: 'json',
    since: 'F-14.9'
  },
  [BETA_READER_PROMPT_VERSION]: {
    feature: 'betaReader',
    tier: 'strong',
    output: 'json',
    since: 'F-14.11'
  },
  [BETA_READER_REGEN_PROMPT_VERSION]: {
    feature: 'betaReader',
    tier: 'strong',
    output: 'json',
    since: 'F-14.11'
  },
  [BRIEF_PROMPT_VERSION]: { feature: 'brief', tier: 'fast', output: 'json', since: 'F-14.3' },
  [SUMMARY_PROMPT_VERSION]: { feature: 'summary', tier: 'fast', output: 'json', since: 'F-5.6' },
  [SUMMARY_PROMPT_V2_VERSION]: {
    feature: 'summary',
    tier: 'fast',
    output: 'json',
    since: 'F-5.16'
  },
  [SUMMARY_PROMPT_V3_VERSION]: {
    feature: 'summary',
    tier: 'fast',
    output: 'json',
    since: 'F-4.13'
  },
  [SUMMARY_PROMPT_V4_VERSION]: {
    feature: 'summary',
    tier: 'fast',
    output: 'json',
    since: 'F-9.14'
  },
  [QUERY_PROMPT_VERSION]: { feature: 'query', tier: 'strong', output: 'json', since: 'F-5.7' },
  [QUERY_PROMPT_V2_VERSION]: { feature: 'query', tier: 'strong', output: 'json', since: 'F-5.16' },
  [QUERY_PROMPT_V3_VERSION]: { feature: 'query', tier: 'strong', output: 'json', since: 'F-5.7' },
  [IMPORT_STRUCTURE_PROMPT_VERSION]: {
    feature: 'importStructure',
    tier: 'fast',
    output: 'json',
    since: 'F-12.3'
  },
  // On demand the feature asks the strong tier; the background run sends the same prompt to
  // the fast one (CLAUDE.md, token rule 1). The catalogue names the tier the author asks on.
  [CONTINUITY_PROMPT_VERSION]: {
    feature: 'continuity',
    tier: 'strong',
    output: 'json',
    since: 'F-13.4'
  },
  [PROOFREAD_PROMPT_VERSION]: {
    feature: 'proofread',
    tier: 'fast',
    output: 'json',
    since: 'F-14.12'
  },
  [VOICE_NOTES_PROMPT_VERSION]: {
    feature: 'voiceNotes',
    tier: 'fast',
    output: 'json',
    since: 'F-14.14'
  },
  [WHAT_NEXT_PROMPT_VERSION]: {
    feature: 'whatNext',
    tier: 'fast',
    output: 'json',
    since: 'F-5.17'
  },
  [WHAT_NEXT_PROMPT_V2_VERSION]: {
    feature: 'whatNext',
    tier: 'fast',
    output: 'json',
    since: 'F-14.13'
  },
  [CHAT_PROMPT_V5_VERSION]: { feature: 'chat', tier: 'fast', output: 'text', since: 'F-5.20' },
  [CHAT_REGEN_PROMPT_V5_VERSION]: {
    feature: 'chat',
    tier: 'fast',
    output: 'text',
    since: 'F-5.20'
  },
  [QUERY_PROMPT_V4_VERSION]: { feature: 'query', tier: 'strong', output: 'json', since: 'F-5.20' },
  [ROUTE_PROMPT_VERSION]: { feature: 'route', tier: 'fast', output: 'json', since: 'F-5.19' },
  [SYNOPSIS_PROMPT_VERSION]: {
    feature: 'synopsis',
    tier: 'fast',
    output: 'json',
    since: 'F-5.20'
  },
  [NOTES_SUGGEST_PROMPT_VERSION]: {
    feature: 'notesSuggest',
    tier: 'fast',
    output: 'json',
    since: 'F-5.20'
  },
  // One version for every pass type; developmental, line, and custom passes ask the strong tier,
  // copy, proofread, and continuity the fast one (`EDIT_PASS_TIER`). The catalogue names strong.
  [EDIT_PASS_PROMPT_VERSION]: {
    feature: 'editPass',
    tier: 'strong',
    output: 'json',
    since: 'F-14.15'
  },
  [AGENT_PROMPT_VERSION]: { feature: 'agent', tier: 'strong', output: 'json', since: 'F-5.22' },
  [AGENT_PROMPT_V2_VERSION]: { feature: 'agent', tier: 'strong', output: 'json', since: 'F-5.22' },
  [CONTEXT_IMPORT_PROMPT_VERSION]: {
    feature: 'contextImport',
    tier: 'strong',
    output: 'json',
    since: 'F-9.8'
  },
  [REVIEW_CHAT_PROMPT_VERSION]: {
    feature: 'reviewChat',
    tier: 'strong',
    output: 'json',
    since: 'F-9.9'
  },
  [AGENT_PROMPT_V3_VERSION]: { feature: 'agent', tier: 'strong', output: 'json', since: 'F-5.23' },
  // The background run asks the fast tier with the same prompt, as for version 1.
  [CONTINUITY_PROMPT_V2_VERSION]: {
    feature: 'continuity',
    tier: 'strong',
    output: 'json',
    since: 'F-5.23'
  },
  [WHAT_NEXT_PROMPT_V3_VERSION]: {
    feature: 'whatNext',
    tier: 'fast',
    output: 'json',
    since: 'F-5.23'
  },
  [NOTES_SUGGEST_PROMPT_V2_VERSION]: {
    feature: 'notesSuggest',
    tier: 'fast',
    output: 'json',
    since: 'F-5.23'
  },
  [PLAN_LINKS_PROMPT_VERSION]: {
    feature: 'planLinks',
    tier: 'fast',
    output: 'json',
    since: 'F-11.1d'
  },
  [CONTEXT_IMPORT_PROMPT_V2_VERSION]: {
    feature: 'contextImport',
    tier: 'strong',
    output: 'json',
    since: 'F-9.11'
  },
  [REVIEW_CHAT_PROMPT_V2_VERSION]: {
    feature: 'reviewChat',
    tier: 'strong',
    output: 'json',
    since: 'F-9.11'
  },
  [ORGANISE_PROMPT_VERSION]: {
    feature: 'organise',
    tier: 'strong',
    output: 'json',
    since: 'F-9.10'
  },
  [AGENT_PROMPT_V4_VERSION]: { feature: 'agent', tier: 'strong', output: 'json', since: 'F-9.10' },
  [ORGANISE_PROMPT_V2_VERSION]: {
    feature: 'organise',
    tier: 'strong',
    output: 'json',
    since: 'F-9.10'
  },
  [TODO_PROMPT_VERSION]: { feature: 'todo', tier: 'fast', output: 'json', since: 'F-9.16' },
  [AGENT_PROMPT_V5_VERSION]: { feature: 'agent', tier: 'strong', output: 'json', since: 'F-9.16' },
  [TODO_SUGGEST_PROMPT_VERSION]: { feature: 'todo', tier: 'fast', output: 'json', since: 'F-9.16' },
  [AGENT_PROMPT_V6_VERSION]: { feature: 'agent', tier: 'strong', output: 'json', since: 'F-5.24' },
  [AGENT_PROMPT_V7_VERSION]: { feature: 'agent', tier: 'strong', output: 'json', since: 'F-5.25' },
  [SUMMARY_PROMPT_V5_VERSION]: { feature: 'summary', tier: 'fast', output: 'json', since: 'F-5.6' },
  [REWRITE_PROMPT_V4_VERSION]: {
    feature: 'rewrite',
    tier: 'strong',
    output: 'text',
    since: 'F-5.6'
  },
  [REWRITE_REGEN_PROMPT_V4_VERSION]: {
    feature: 'rewrite',
    tier: 'strong',
    output: 'text',
    since: 'F-5.6'
  },
  [EDIT_PASS_PROMPT_V2_VERSION]: {
    feature: 'editPass',
    tier: 'strong',
    output: 'json',
    since: 'F-5.6'
  },
  [AGENT_PROMPT_V8_VERSION]: { feature: 'agent', tier: 'strong', output: 'json', since: 'F-5.25' },
  [SHEET_REFILE_PROMPT_VERSION]: {
    feature: 'sheetSync',
    tier: 'fast',
    output: 'json',
    since: 'F-9.18'
  },
  [SHEET_WRITE_UP_PROMPT_VERSION]: {
    feature: 'sheetSync',
    tier: 'fast',
    output: 'json',
    since: 'F-9.18'
  },
  [ROUTE_PROMPT_V2_VERSION]: { feature: 'route', tier: 'fast', output: 'json', since: 'F-5.26' },
  [GHOST_PROMPT_V5_VERSION]: {
    feature: 'ghostText',
    tier: 'fast',
    output: 'text',
    since: 'F-16.14'
  },
  [GHOST_REGEN_PROMPT_V5_VERSION]: {
    feature: 'ghostText',
    tier: 'fast',
    output: 'text',
    since: 'F-16.14'
  },
  [REWRITE_PROMPT_V5_VERSION]: {
    feature: 'rewrite',
    tier: 'strong',
    output: 'text',
    since: 'F-16.14'
  },
  [REWRITE_REGEN_PROMPT_V5_VERSION]: {
    feature: 'rewrite',
    tier: 'strong',
    output: 'text',
    since: 'F-16.14'
  },
  [CHAT_PROMPT_V6_VERSION]: { feature: 'chat', tier: 'fast', output: 'text', since: 'F-16.14' },
  [CHAT_REGEN_PROMPT_V6_VERSION]: {
    feature: 'chat',
    tier: 'fast',
    output: 'text',
    since: 'F-16.14'
  },
  [CRITIQUE_PROMPT_V4_VERSION]: {
    feature: 'critique',
    tier: 'strong',
    output: 'json',
    since: 'F-16.14'
  },
  [CRITIQUE_REGEN_PROMPT_V4_VERSION]: {
    feature: 'critique',
    tier: 'strong',
    output: 'json',
    since: 'F-16.14'
  },
  [EDIT_PASS_PROMPT_V3_VERSION]: {
    feature: 'editPass',
    tier: 'strong',
    output: 'json',
    since: 'F-16.14'
  },
  [WHAT_NEXT_PROMPT_V4_VERSION]: {
    feature: 'whatNext',
    tier: 'fast',
    output: 'json',
    since: 'F-16.14'
  },
  [NOTES_SUGGEST_PROMPT_V3_VERSION]: {
    feature: 'notesSuggest',
    tier: 'fast',
    output: 'json',
    since: 'F-16.14'
  },
  [CONTEXT_IMPORT_PROMPT_V3_VERSION]: {
    feature: 'contextImport',
    tier: 'strong',
    output: 'json',
    since: 'F-16.9'
  },
  [REVIEW_CHAT_PROMPT_V3_VERSION]: {
    feature: 'reviewChat',
    tier: 'strong',
    output: 'json',
    since: 'F-16.9'
  },
  [IMPORT_STRUCTURE_PROMPT_V2_VERSION]: {
    feature: 'importStructure',
    tier: 'fast',
    output: 'json',
    since: 'F-16.15'
  },
  [READER_PROMPT_VERSION]: { feature: 'reader', tier: 'fast', output: 'json', since: 'F-16.17' },
  [VERIFY_PROMPT_VERSION]: { feature: 'verify', tier: 'fast', output: 'json', since: 'F-16.17' },
  [BETA_READER_PROMPT_V2_VERSION]: {
    feature: 'betaReader',
    tier: 'strong',
    output: 'json',
    since: 'F-16.20'
  },
  [BETA_READER_REGEN_PROMPT_V2_VERSION]: {
    feature: 'betaReader',
    tier: 'strong',
    output: 'json',
    since: 'F-16.20'
  },
  [SYNOPSIS_PROMPT_V2_VERSION]: {
    feature: 'synopsis',
    tier: 'fast',
    output: 'json',
    since: 'F-16.20'
  },
  [NOTES_SUGGEST_PROMPT_V4_VERSION]: {
    feature: 'notesSuggest',
    tier: 'fast',
    output: 'json',
    since: 'F-16.20'
  },
  [PLAN_LINKS_PROMPT_V2_VERSION]: {
    feature: 'planLinks',
    tier: 'fast',
    output: 'json',
    since: 'F-16.21'
  },
  [READER_V2_PROMPT_VERSION]: { feature: 'reader', tier: 'fast', output: 'json', since: 'F-16.22' },
  [VERIFY_V2_PROMPT_VERSION]: { feature: 'verify', tier: 'fast', output: 'json', since: 'F-16.22' },
  [AGENT_PROMPT_V9_VERSION]: { feature: 'agent', tier: 'strong', output: 'json', since: 'F-16.25' },
  [CITE_PROMPT_VERSION]: { feature: 'cite', tier: 'fast', output: 'json', since: 'F-16.25' },
  [NAVIGATOR_PROMPT_VERSION]: {
    feature: 'navigator',
    tier: 'fast',
    output: 'json',
    since: 'F-16.25'
  },
  // F-16.27: the batch is fast; the stronger check of *Check the book* (F-16.30) sends the same
  // version on the strong tier, one pair at a time.
  [JUDGE_PROMPT_VERSION]: { feature: 'judge', tier: 'fast', output: 'json', since: 'F-16.27' },
  [READER_V3_PROMPT_VERSION]: { feature: 'reader', tier: 'fast', output: 'json', since: 'F-16.17' },
  [VERIFY_V3_PROMPT_VERSION]: { feature: 'verify', tier: 'fast', output: 'json', since: 'F-16.17' },
  [READER_V4_PROMPT_VERSION]: { feature: 'reader', tier: 'fast', output: 'json', since: 'F-16.17' },
  [READER_V5_PROMPT_VERSION]: { feature: 'reader', tier: 'fast', output: 'json', since: 'F-16.17' },
  // Every batch on the fast tier since plan ReaderNarrow.md (2026-10-14): the strong batch of
  // the open-ended slots (reader.v5's reading) is retired with them.
  [VERIFY_V4_PROMPT_VERSION]: { feature: 'verify', tier: 'fast', output: 'json', since: 'F-16.17' },
  [READER_V6_PROMPT_VERSION]: { feature: 'reader', tier: 'fast', output: 'json', since: 'F-16.17' },
  [READER_V7_PROMPT_VERSION]: { feature: 'reader', tier: 'fast', output: 'json', since: 'F-16.17' },
  [SCRIBE_PROMPT_VERSION]: { feature: 'scribe', tier: 'strong', output: 'json', since: 'Notes P1' },
  // Sources with the exact words she relied on, refs written as chapters (2026-10-15).
  [SCRIBE_V2_PROMPT_VERSION]: {
    feature: 'scribe',
    tier: 'strong',
    output: 'json',
    since: 'Notes P1'
  },
  // Quick sends both on fast (its catalogue tier); Deep on strong (its cases say so).
  [EDIT_FLOW_PROMPT_VERSION]: {
    feature: 'editFlow',
    tier: 'fast',
    output: 'json',
    since: 'Notes P2'
  },
  [EDIT_NOTES_PROMPT_VERSION]: {
    feature: 'editFlow',
    tier: 'fast',
    output: 'json',
    since: 'Notes P2'
  }
}

/**
 * F-16.25 (P3-D10): a prompt version whose input cap is its own rather than its feature's, so a
 * new version may carry more (Ms Scribe's `agent.v9` sends the whole open scene, 24,000) while the
 * feature's older versions and every v1 request keep the cap they had.
 */
export const PROMPT_INPUT_BUDGETS: Partial<Record<PromptVersion, number>> = {
  [AGENT_PROMPT_V9_VERSION]: 24_000
}

/** The input cap a request built from `version` is checked against: its own, else its feature's. */
export function promptInputBudget(
  feature: AiFeatureId,
  version: PromptVersion,
  budgets: Partial<Record<PromptVersion, number>> = PROMPT_INPUT_BUDGETS
): number {
  return budgets[version] ?? inputBudget(feature)
}

/** Whether a string (a ledger row's, a proposal's) names a catalogued prompt version. */
export function isPromptVersion(value: string): value is PromptVersion {
  return (PROMPT_VERSIONS as readonly string[]).includes(value)
}
