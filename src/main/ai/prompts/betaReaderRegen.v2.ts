import type { AiMessage } from '../providers/types'
import { buildBetaReaderPromptV2, type BuildBetaReaderPromptV2Input } from './betaReader.v2'

/**
 * The beta-reader regenerate prompt (F-14.11, F-14.5), version 2 (F-16.20, story memory v2 only;
 * decision P2a-D14): `betaReader.v2` with the author's note appended to the user turn when they
 * asked for a different read, as `betaReaderRegen.v1` does for version 1. The rules and the
 * honesty line, the stable prefix, are byte-identical to the plain read. A change to the clause
 * or to the base prompt is a new file with its own golden test.
 */
export const BETA_READER_REGEN_PROMPT_V2_VERSION = 'betaReaderRegen.v2'

export interface BuildBetaReaderRegenPromptV2Input extends BuildBetaReaderPromptV2Input {
  /** The author's note from Ask again…, normalized; null when they gave none. */
  note: string | null
}

export interface BuiltBetaReaderRegenPromptV2 {
  version: typeof BETA_READER_REGEN_PROMPT_V2_VERSION
  messages: AiMessage[]
  maxTokens: number
}

export function buildBetaReaderRegenPromptV2(
  input: BuildBetaReaderRegenPromptV2Input
): BuiltBetaReaderRegenPromptV2 {
  const base = buildBetaReaderPromptV2(input)
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
  return { version: BETA_READER_REGEN_PROMPT_V2_VERSION, messages, maxTokens: base.maxTokens }
}
