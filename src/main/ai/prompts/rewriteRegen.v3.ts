import type { AiMessage } from '../providers/types'
import { REGEN_CLAUSE_PREFIX } from './ghostTextRegen.v1'
import { buildRewritePromptV3, type BuildRewritePromptV3Input } from './rewrite.v3'

/**
 * The rewrite regenerate prompt (F-14.10), version 3: `rewrite.v3` (the story bible and the
 * scene steer included, F-14.9 and F-14.13) with up to two clauses appended to the system turn
 * — the author's note when they asked for a different rewrite (F-14.5), and what the fidelity
 * check found wrong with the last attempt (F-14.7). At least one of the two is present; when
 * both are, the author's note comes first, because it is the instruction and the violation is
 * only a correction. Everything else (the clauses, the voice block, the bible, the scene line,
 * the steer, the context, the passage, the cap) is version 2's, so the provider's cached prefix
 * still applies up to the clauses. A change to a clause or the base prompt is a new file with
 * its own golden test, never an edit here.
 */
export const REWRITE_REGEN_PROMPT_V3_VERSION = 'rewriteRegen.v3'

export interface BuildRewriteRegenPromptV3Input extends BuildRewritePromptV3Input {
  /** The author's note from Regenerate…, or null when the fidelity check drove the retry. */
  note: string | null
  /** The first violation's message, as the fidelity check phrases it, or null. */
  violation: string | null
}

export interface BuiltRewriteRegenPromptV3 {
  version: typeof REWRITE_REGEN_PROMPT_V3_VERSION
  messages: AiMessage[]
  maxTokens: number
}

export function buildRewriteRegenPromptV3(
  input: BuildRewriteRegenPromptV3Input
): BuiltRewriteRegenPromptV3 {
  const base = buildRewritePromptV3(input)
  const clauses: string[] = []
  if (input.note !== null) {
    clauses.push(`The writer asked for a different rewrite and said: "${input.note}".`)
  }
  if (input.violation !== null) {
    clauses.push(
      `${REGEN_CLAUSE_PREFIX} ${input.violation}. ` +
        "Rewrite it again, keeping the manuscript's voice."
    )
  }
  const clause = clauses.join(' ')
  const messages = base.messages.map((message) =>
    message.role === 'system' ? { ...message, content: `${message.content}\n\n${clause}` } : message
  )
  return {
    version: REWRITE_REGEN_PROMPT_V3_VERSION,
    messages,
    maxTokens: base.maxTokens
  }
}
