import { outputBudget } from '@shared/ai'
import { renderPromptCard, type PromptCard } from '@shared/memory/cardText'
import { SCENE_SYNOPSIS_MAX } from '@shared/sceneMeta'
import type { AiMessage } from '../providers/types'

/**
 * The synopsis suggestion prompt (F-5.20), version 2 (F-16.20, story memory v2 only; plan P2a
 * §5.1): version 1 with the scene's v2 card (`reader.v1`'s line, gist and the place, time and POV
 * that stand on the text, `renderPromptCard`) in the stored summary's place, and one rule naming
 * the card as the app's map: where it and the text disagree, the text wins. A v1 project keeps
 * sending version 1. Prompt files are versioned (F-5.12): a change to the text, the caps, or the
 * message order is a new file with its own golden test, never an edit here.
 *
 * Order (CLAUDE.md, token efficiency rule 3): the rules alone in the system turn; the card, the
 * scene text and the instruction in the user turn.
 */
export const SYNOPSIS_PROMPT_V2_VERSION = 'synopsis.v2'

/**
 * The rules. The opening is the e2e's sentinel for this version (`SYNOPSIS_V2_SENTINEL`, which
 * tells a v2 request from a v1 one), so it must not change within this version.
 */
export const SYNOPSIS_RULES_V2 =
  'You are the synopsis feature inside a novel-writing app. Read the scene below, with the card ' +
  'that maps it, and write the synopsis an author keeps on its index card: what happens, who ' +
  'drives it, and how it ends, in two to four plain sentences in the present tense, at most ' +
  `${SCENE_SYNOPSIS_MAX} characters. The card is the app's short reading of the scene and may ` +
  'lag behind it: where the card and the scene text disagree, follow the text. State only what ' +
  'the scene shows; do not judge it or give advice. Reply with JSON only: {"synopsis":"..."}.'

/** The opening the e2e's fake provider and assertions key on. */
export const SYNOPSIS_V2_SENTINEL =
  'You are the synopsis feature inside a novel-writing app. Read the scene below, with the card'

export interface BuildSynopsisPromptV2Input {
  /** The scene as plain text, head-truncated by the caller. */
  sceneText: string
  /** The scene's v2 card as the readers take it (`promptCard`), or null before its first reading. */
  card: PromptCard | null
}

export interface BuiltSynopsisPromptV2 {
  version: typeof SYNOPSIS_PROMPT_V2_VERSION
  messages: AiMessage[]
  maxTokens: number
}

export function buildSynopsisPromptV2(input: BuildSynopsisPromptV2Input): BuiltSynopsisPromptV2 {
  const user: string[] = []
  if (input.card !== null) user.push(renderPromptCard(input.card))
  user.push(`Scene text:\n"""\n${input.sceneText}\n"""`)
  user.push('Write the synopsis.')
  return {
    version: SYNOPSIS_PROMPT_V2_VERSION,
    messages: [
      { role: 'system', content: SYNOPSIS_RULES_V2 },
      { role: 'user', content: user.join('\n\n') }
    ],
    maxTokens: outputBudget('synopsis')
  }
}
