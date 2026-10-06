import { outputBudget } from '@shared/ai'
import { SCENE_SYNOPSIS_MAX } from '@shared/sceneMeta'
import type { AiMessage } from '../providers/types'

/**
 * The synopsis suggestion prompt (F-5.20), version 1: one scene read back as the short synopsis
 * its index card and side panel show, answered as JSON `{ "synopsis": "..." }`. The author
 * accepts it with one click or ignores it; nothing is written without that accept. Prompt files
 * are versioned (F-5.12): a change to the text, the caps, or the message order is a new file
 * with its own golden test, never an edit here.
 *
 * Order (CLAUDE.md, token efficiency rule 3): the system turn is the stable rules; the user turn
 * carries the scene's stored summary and key points (F-5.6, when the background index has one),
 * the scene text, and the one-line instruction. No voice block: a synopsis is a planning note.
 */
export const SYNOPSIS_PROMPT_VERSION = 'synopsis.v1'

/** The rules; the opening sentence is the one a fake provider in tests keys on. */
export const SYNOPSIS_RULES =
  'You are the synopsis feature inside a novel-writing app. Read the scene below and write the ' +
  'synopsis an author keeps on its index card: what happens, who drives it, and how it ends, ' +
  `in two to four plain sentences in the present tense, at most ${SCENE_SYNOPSIS_MAX} ` +
  'characters. State only what the scene shows; do not judge it or give advice. Reply with ' +
  'JSON only: {"synopsis":"..."}.'

export interface BuildSynopsisPromptInput {
  /** The scene as plain text, head-truncated by the caller. */
  sceneText: string
  /** The stored summary (F-5.6) and its key points, or null when the scene has none yet. */
  summary: { summary: string; keyPoints: string[] } | null
}

export interface BuiltSynopsisPrompt {
  version: typeof SYNOPSIS_PROMPT_VERSION
  messages: AiMessage[]
  maxTokens: number
}

export function buildSynopsisPrompt(input: BuildSynopsisPromptInput): BuiltSynopsisPrompt {
  const user: string[] = []
  if (input.summary) {
    const points = input.summary.keyPoints.map((point) => `- ${point}`).join('\n')
    user.push(`Stored summary:\n${input.summary.summary}${points ? `\n${points}` : ''}`)
  }
  user.push(`Scene text:\n"""\n${input.sceneText}\n"""`)
  user.push('Write the synopsis.')
  return {
    version: SYNOPSIS_PROMPT_VERSION,
    messages: [
      { role: 'system', content: SYNOPSIS_RULES },
      { role: 'user', content: user.join('\n\n') }
    ],
    maxTokens: outputBudget('synopsis')
  }
}
