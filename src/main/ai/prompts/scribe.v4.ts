import type { AiMessage } from '../providers/types'
import type { BuildScribePromptInput } from './scribe.v1'
import { buildScribePromptV3, SCRIBE_V3_RULES } from './scribe.v3'

export const SCRIBE_V4_PROMPT_VERSION = 'scribe.v4'

/**
 * Templates known before she writes (notes fixes, 2026-10-15, `fixes-1.md` §2): the notes block
 * now ends with the folders that have a template and their headings ("Folder templates:"), and
 * this one rule line tells her to write a new page there under them. `create_note`'s local layout
 * (note templates, phase 6) stays as the backstop.
 */
export const SCRIBE_V4_TEMPLATE_RULE =
  'A new page in a folder listed under Folder templates is written under its headings, in order; leave a heading empty rather than invent.'

/** v3's rules, then the template line: the same in every mode, so the cached prefix holds. */
export const SCRIBE_V4_RULES = `${SCRIBE_V3_RULES}\n${SCRIBE_V4_TEMPLATE_RULE}`

export interface BuiltScribePromptV4 {
  version: typeof SCRIBE_V4_PROMPT_VERSION
  messages: AiMessage[]
  maxTokens: number
}

/** v3's request (cache order, the mode line last in the moment) with v4's rules. */
export function buildScribePromptV4(input: BuildScribePromptInput): BuiltScribePromptV4 {
  const v3 = buildScribePromptV3(input)
  const [system, ...rest] = v3.messages
  const content = system?.content ?? ''
  return {
    version: SCRIBE_V4_PROMPT_VERSION,
    messages: [
      { role: 'system', content: `${SCRIBE_V4_RULES}${content.slice(SCRIBE_V3_RULES.length)}` },
      ...rest
    ],
    maxTokens: v3.maxTokens
  }
}
