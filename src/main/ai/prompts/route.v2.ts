import type { AiMessage } from '../providers/types'
import { buildRoutePrompt, type BuildRoutePromptInput } from './route.v1'

/**
 * The assistant router prompt (F-5.19), version 2 (F-5.26, requested by the author 2026-10-11):
 * route.v1 plus the `editPass` action, so "make this scene better" reaches the edit passes
 * (F-14.15) instead of a scatter of chat edits. An `editPass` answer also names the pass (`ask`
 * when the request is vague, so the chat asks which kind of edit) and what it covers (the
 * selection, the open scene, or a chapter, with the chapter's name). `rewrite` is now only an
 * explicit rewrite or rephrase of the selection; proofreading is the proofread pass, so the
 * `proofread` action leaves the list. `parseRouteAnswer` reads the answer; every unreadable
 * answer is `chat`.
 *
 * Same order and user turn as v1 (CLAUDE.md, token rule 3): the system turn is the whole stable
 * prefix; the user turn carries the last turns, the open document, the selection's opening, and
 * the message, each already cut to its cap (`@shared/assistantRoute`).
 */
export const ROUTE_PROMPT_V2_VERSION = 'route.v2'

/** The opening sentence is v1's, so a fake provider in tests keys on it for either version. */
export const ROUTE_RULES_V2 =
  "You are the router inside a novel-writing app's assistant. Read the author's message and " +
  'pick the one action that answers it. Reply with JSON only: ' +
  '{"action":"chat","instruction":""}. Actions:\n' +
  '- chat: discussion, brainstorming, advice, or anything else.\n' +
  '- query: a question about what happens or is true in the manuscript (who, what, where, when).\n' +
  "- rewrite: rewrite or rephrase the selected passage (for example in the author's voice); " +
  'only when a passage is selected and the author asks for a rewrite.\n' +
  '- editPass: improve, polish, tighten, fix, proofread, or edit the selected passage, the ' +
  'scene, or a chapter.\n' +
  "- critique: editor's notes or feedback on the writing of the scene.\n" +
  '- betaReader: how a first-time reader experiences the scene.\n' +
  '- continuity: check the scene for contradictions with the story so far.\n' +
  '- whatNext: ideas for what could happen next.\n' +
  "- synopsis: write or suggest the scene's synopsis.\n" +
  "- notes: suggest key points to keep in mind in the scene's notes.\n" +
  'Set "instruction" to the specific request restated in one short sentence for that action, ' +
  'or "" when there is none. For editPass also set "pass", "target", and "chapter": ' +
  '{"action":"editPass","instruction":"","pass":"ask","target":"scene","chapter":""}. ' +
  'pass: "ask" when the request is vague (make it better, improve, polish); "line" for prose, ' +
  'flow, wordiness, tightening; "developmental" for pacing, structure, stakes, character arcs; ' +
  '"dialogue" for dialogue; "proofread" for typos, spelling, grammar, punctuation; "copy" for ' +
  'consistency of names, tense, repetition; "continuity" for contradictions with the story; ' +
  '"custom" for any other specific change, restated in "instruction". target: "selection" when ' +
  'a passage is selected and the message does not name the scene or a chapter; "chapter" for a ' +
  'chapter, with "chapter" set to the chapter it names ("" for this chapter); otherwise "scene". ' +
  'Never answer the message itself.'

export interface BuiltRoutePromptV2 {
  version: typeof ROUTE_PROMPT_V2_VERSION
  messages: AiMessage[]
  maxTokens: number
}

/** v1's user turn under the v2 rules: only the system turn changed. */
export function buildRoutePromptV2(input: BuildRoutePromptInput): BuiltRoutePromptV2 {
  const v1 = buildRoutePrompt(input)
  return {
    version: ROUTE_PROMPT_V2_VERSION,
    messages: [{ role: 'system', content: ROUTE_RULES_V2 }, ...v1.messages.slice(1)],
    maxTokens: v1.maxTokens
  }
}
