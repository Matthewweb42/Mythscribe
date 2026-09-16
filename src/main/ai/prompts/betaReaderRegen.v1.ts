import type { AiMessage } from '../providers/types'
import { buildBetaReaderPrompt, type BuildBetaReaderPromptInput } from './betaReader.v1'

/**
 * The beta-reader regenerate prompt (F-14.11, F-14.5), version 1: `betaReader.v1` with the
 * author's note appended to the user turn when they asked for a different read. The clause
 * goes after the scenes rather than into the system turn, so the rules and the honesty line —
 * the stable prefix the provider caches — are byte-identical to the plain read. There is no
 * violation clause: the reader proposes nothing, so nothing can fail the fidelity check.
 * A change to the clause or to the base prompt is a new file with its own golden test.
 */
export const BETA_READER_REGEN_PROMPT_VERSION = 'betaReaderRegen.v1'

export interface BuildBetaReaderRegenPromptInput extends BuildBetaReaderPromptInput {
  /**
   * The author's note from Ask again…, already normalized (`normalizeProposalNote`), or null
   * when they asked again without saying why: then the prompt is the base one under this
   * version, so the ledger still shows the request as a regenerate.
   */
  note: string | null
}

export interface BuiltBetaReaderRegenPrompt {
  version: typeof BETA_READER_REGEN_PROMPT_VERSION
  messages: AiMessage[]
  maxTokens: number
}

export function buildBetaReaderRegenPrompt(
  input: BuildBetaReaderRegenPromptInput
): BuiltBetaReaderRegenPrompt {
  const base = buildBetaReaderPrompt(input)
  const note = input.note
  const messages =
    note === null
      ? base.messages
      : base.messages.map((message) =>
          message.role === 'user'
            ? {
                ...message,
                content: `${message.content}\n\nThe writer asked for a different read and said: "${note}".`
              }
            : message
        )
  return {
    version: BETA_READER_REGEN_PROMPT_VERSION,
    messages,
    maxTokens: base.maxTokens
  }
}
