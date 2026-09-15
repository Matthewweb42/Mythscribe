import { estimateTokens, outputBudget } from '@shared/ai'
import type { SceneMeta } from '@shared/sceneMeta'
import type { AiMessage } from '../providers/types'

/**
 * The rewrite-in-my-voice prompt (F-14.10), version 1: one selected passage rewritten in the
 * author's voice, shown to the author as a diff. Prompt files are versioned (F-5.12): a change
 * to the text, the caps, or the message order is a new file (`rewrite.v2.ts`) with its own
 * golden test, never an edit here, so every ledger row's `promptVersion` stays true.
 *
 * Order (CLAUDE.md, token efficiency rule 3): the system turn is the stable prefix — the rules,
 * then the voice profile block (F-14.1), then the scene's metadata line, all of which hold
 * still while the author rewrites one passage after another in the same scene. The user turn
 * carries what changes: the manuscript text each side of the selection (so the rewrite keeps
 * its seams), the passage itself, and the one-line instruction. No preset (the rewrite is
 * about the author's voice, not the preset's style) and no temperature (the provider's default).
 */
export const REWRITE_PROMPT_VERSION = 'rewrite.v1'

/**
 * The rules. The opening sentence is load-bearing beyond the model: the e2e's fake OpenAI
 * recognises a rewrite request by it, so it must not change within this version.
 */
export const REWRITE_RULES =
  'You are the rewrite feature inside a novel-writing app. Rewrite the passage the author ' +
  "selected so it reads as the author's own voice, as described below. Keep its meaning, its " +
  'events, the names and facts it states, its point of view, its tense, and roughly its ' +
  'length. Remove generic or machine-sounding phrasing. Reply with the rewritten passage ' +
  'only, with the same paragraph breaks: no preamble, no notes, and no quotation marks around ' +
  'the answer.'

/** A rewrite may run half again as long as the passage, plus a little slack for a longer close. */
const LENGTH_FACTOR = 1.5
const LENGTH_SLACK_TOKENS = 40

export interface BuildRewritePromptInput {
  /** The selected passage as plain text, `REWRITE_TEXT_MIN`–`REWRITE_TEXT_MAX` characters. */
  text: string
  /** Up to `REWRITE_CONTEXT_CHARS` of manuscript text immediately before the selection; '' at the start. */
  before: string
  /** Up to `REWRITE_CONTEXT_CHARS` of manuscript text immediately after the selection; '' at the end. */
  after: string
  /** The scene's metadata when any field is set, else null. */
  meta: SceneMeta | null
  /**
   * The voice profile block (F-14.1, `voiceBlock`), or null when the project has neither rules
   * nor exemplars yet (then the fidelity check is skipped too).
   */
  voice: string | null
}

export interface BuiltRewritePrompt {
  version: typeof REWRITE_PROMPT_VERSION
  messages: AiMessage[]
  maxTokens: number
}

export function buildRewritePrompt(input: BuildRewritePromptInput): BuiltRewritePrompt {
  const rules = [REWRITE_RULES]
  if (input.voice) rules.push(input.voice)
  const meta = input.meta
  const scene = meta
    ? `\n\nScene: location ${meta.location || '—'}, POV ${meta.pov || '—'}, ` +
      `timeline ${meta.timeline || '—'}.`
    : ''

  const parts: string[] = []
  if (input.before) parts.push(`Text before:\n"""\n${input.before}\n"""`)
  if (input.after) parts.push(`Text after:\n"""\n${input.after}\n"""`)
  parts.push(`Passage to rewrite:\n"""\n${input.text}\n"""`)
  parts.push('Rewrite the passage.')

  return {
    version: REWRITE_PROMPT_VERSION,
    messages: [
      { role: 'system', content: `${rules.join(' ')}${scene}` },
      { role: 'user', content: parts.join('\n\n') }
    ],
    maxTokens: Math.min(
      Math.ceil(estimateTokens(input.text) * LENGTH_FACTOR) + LENGTH_SLACK_TOKENS,
      outputBudget('rewrite')
    )
  }
}
