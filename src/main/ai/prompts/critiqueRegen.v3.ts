import type { AiMessage } from '../providers/types'
import { buildCritiquePromptV3, type BuildCritiquePromptV3Input } from './critique.v3'

/**
 * The editor's-notes regenerate prompt (F-14.8), version 3: `critique.v3` (the scene brief and
 * the story bible, F-14.3 and F-14.9) with the author's note appended to the system turn when
 * they asked for different notes (F-14.5). There is no violation clause: the fidelity check
 * (F-14.7) scores each fix on its own, and a failing fix is shown flagged rather than sent
 * back, since a retry would redo the whole critique. Everything else is version 3's, so the
 * provider's cached prefix still applies up to the clause. A change to the clause or the base
 * prompt is a new file with its own golden test, never an edit here.
 */
export const CRITIQUE_REGEN_PROMPT_V3_VERSION = 'critiqueRegen.v3'

export interface BuildCritiqueRegenPromptV3Input extends BuildCritiquePromptV3Input {
  /**
   * The author's note from Ask again…, already normalized (`normalizeProposalNote`), or null
   * when they asked again without saying why: then the prompt is the base one under this
   * version, so the ledger still shows the request as a regenerate.
   */
  note: string | null
}

export interface BuiltCritiqueRegenPromptV3 {
  version: typeof CRITIQUE_REGEN_PROMPT_V3_VERSION
  messages: AiMessage[]
  maxTokens: number
}

export function buildCritiqueRegenPromptV3(
  input: BuildCritiqueRegenPromptV3Input
): BuiltCritiqueRegenPromptV3 {
  const base = buildCritiquePromptV3(input)
  const note = input.note
  const messages =
    note === null
      ? base.messages
      : base.messages.map((message) =>
          message.role === 'system'
            ? {
                ...message,
                content: `${message.content}\n\nThe writer asked for different notes and said: "${note}".`
              }
            : message
        )
  return {
    version: CRITIQUE_REGEN_PROMPT_V3_VERSION,
    messages,
    maxTokens: base.maxTokens
  }
}
