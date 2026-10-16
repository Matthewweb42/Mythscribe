import { describe, expect, it } from 'vitest'
import type { AssistantMode } from '@shared/aiSettings'
import { SCRIBE_RETRY_MAX_TOKENS, SCRIBE_STEP_MAX_TOKENS, scribeAccess } from '@shared/scribe2'
import {
  SCRIBE_FINAL_TURN,
  SCRIBE_RETRY_TURN,
  SCRIBE_SENTINEL,
  type BuildScribePromptInput
} from './scribe.v1'
import { SCRIBE_V3_MODE_RULES, SCRIBE_V3_RULES, buildScribePromptV3 } from './scribe.v3'
import {
  SCRIBE_V4_PROMPT_VERSION,
  SCRIBE_V4_RULES,
  SCRIBE_V4_TEMPLATE_RULE,
  buildScribePromptV4
} from './scribe.v4'

const base: BuildScribePromptInput = {
  mode: 'write',
  access: { notes: true, prose: true },
  context: {
    notes:
      '## p1 Mara (note, in Characters)\nEyes: grey. Fears the sea.\n\nFolder templates:\nCharacters → template: Role, Appearance, Wants, Fears',
    map: 'n2 Blades of Alandor › Tash | synopsis: Tash climbs.\nn3 Blades of Alandor › Rynna | notes: Rook lies.',
    book: '### n2 Blades of Alandor › Tash\nTash climbed the ridge.\n\n### n3 Blades of Alandor › Rynna\nRook waited.',
    bookMode: 'whole',
    moment:
      'The author is in n3 Blades of Alandor › Rynna.\nIts notes: Rook lies.\nIts text is in the book above (n3).'
  },
  history: [
    { role: 'user', content: 'Who is Rook?' },
    { role: 'assistant', content: 'A smuggler (p2).' }
  ],
  message: 'Make Rook a page in Characters.',
  steps: [],
  final: false
}

const asked = (mode: AssistantMode): BuildScribePromptInput => ({
  ...base,
  mode,
  access: scribeAccess(mode, base.message)
})

const systemOf = (input: BuildScribePromptInput): string =>
  buildScribePromptV4(input).messages[0]?.content ?? ''

describe('scribe.v4 (templates known before she writes)', () => {
  it('is v3’s request with one rule line more, at the end of the rules', () => {
    const built = buildScribePromptV4(asked('write'))
    expect(built.version).toBe(SCRIBE_V4_PROMPT_VERSION)
    expect(built.maxTokens).toBe(SCRIBE_STEP_MAX_TOKENS)
    const system = built.messages[0]?.content ?? ''
    expect(system.startsWith(SCRIBE_SENTINEL)).toBe(true)
    expect(SCRIBE_V4_RULES).toBe(`${SCRIBE_V3_RULES}\n${SCRIBE_V4_TEMPLATE_RULE}`)
    expect(system.startsWith(`${SCRIBE_V4_RULES}\n\n# Notes\n`)).toBe(true)
    const v3 = buildScribePromptV3(asked('write'))
    const v3System = v3.messages[0]?.content ?? ''
    expect(system.slice(SCRIBE_V4_RULES.length)).toBe(v3System.slice(SCRIBE_V3_RULES.length))
    expect(built.messages.slice(1)).toEqual(v3.messages.slice(1))
    expect(SCRIBE_V4_TEMPLATE_RULE).toContain('Folder templates')
    expect(SCRIBE_V4_TEMPLATE_RULE).toContain('leave a heading empty rather than invent')
    expect(built).toMatchSnapshot()
  })

  it('keeps the cached prefix the same in every mode and the mode line last', () => {
    const prefix = (mode: AssistantMode): string => {
      const system = systemOf(asked(mode))
      return system.slice(0, system.indexOf('# Now'))
    }
    expect(prefix('vibe')).toBe(prefix('write'))
    expect(prefix('brainstorm')).toBe(prefix('write'))
    for (const mode of ['brainstorm', 'write', 'vibe'] as const) {
      expect(systemOf(asked(mode)).endsWith(SCRIBE_V3_MODE_RULES[mode])).toBe(true)
    }
  })

  it('ends with the final or the retry turn', () => {
    const steps = [
      { call: '{"tool":"open_note","args":{"id":"p1"}}', result: 'Result of open_note:\np1 …' }
    ]
    expect(buildScribePromptV4({ ...base, steps, final: true }).messages.at(-1)?.content).toBe(
      SCRIBE_FINAL_TURN
    )
    const retry = buildScribePromptV4({ ...base, steps, final: true, retry: true })
    expect(retry.messages.at(-1)?.content).toBe(SCRIBE_RETRY_TURN)
    expect(retry.maxTokens).toBe(SCRIBE_RETRY_MAX_TOKENS)
  })
})
