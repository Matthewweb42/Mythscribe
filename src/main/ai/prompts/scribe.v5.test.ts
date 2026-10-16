import { describe, expect, it } from 'vitest'
import type { AssistantMode } from '@shared/aiSettings'
import {
  SCRIBE_RETRY_MAX_TOKENS,
  SCRIBE_STEP_MAX_TOKENS,
  SCRIBE_STRUCTURE_TOOLS,
  scribeAccess
} from '@shared/scribe2'
import {
  SCRIBE_FINAL_TURN,
  SCRIBE_RETRY_TURN,
  SCRIBE_SENTINEL,
  type BuildScribePromptInput
} from './scribe.v1'
import { SCRIBE_V3_MODE_RULES } from './scribe.v3'
import { SCRIBE_V4_RULES, buildScribePromptV4 } from './scribe.v4'
import {
  SCRIBE_V5_MODE_RULES,
  SCRIBE_V5_PROMPT_VERSION,
  SCRIBE_V5_RULES,
  SCRIBE_V5_STRUCTURE_RULES,
  buildScribePromptV5
} from './scribe.v5'

const base: BuildScribePromptInput = {
  mode: 'write',
  access: { notes: true, prose: true, structure: true },
  context: {
    notes:
      '## p1 Mara (note, in Characters)\nEyes: grey. Fears the sea.\n\n## p2 Tash (note)\nClimbs.\n\nFolder templates:\nCharacters → template: Role, Appearance, Wants, Fears',
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
  message: 'Put Tash in the Characters folder.',
  steps: [],
  final: false
}

const asked = (mode: AssistantMode, message = base.message): BuildScribePromptInput => ({
  ...base,
  mode,
  message,
  access: scribeAccess(mode, message)
})

const systemOf = (input: BuildScribePromptInput): string =>
  buildScribePromptV5(input).messages[0]?.content ?? ''

describe('scribe.v5 (Ms Scribe’s structure tools)', () => {
  it('is v4’s request with the structure tools after v4’s rules and v5’s mode line', () => {
    const built = buildScribePromptV5(asked('write'))
    expect(built.version).toBe(SCRIBE_V5_PROMPT_VERSION)
    expect(built.maxTokens).toBe(SCRIBE_STEP_MAX_TOKENS)
    const system = built.messages[0]?.content ?? ''
    expect(system.startsWith(SCRIBE_SENTINEL)).toBe(true)
    expect(SCRIBE_V5_RULES).toBe(`${SCRIBE_V4_RULES}\n${SCRIBE_V5_STRUCTURE_RULES}`)
    expect(system.startsWith(`${SCRIBE_V5_RULES}\n\n# Notes\n`)).toBe(true)
    // Between the rules and the mode line, v4's request byte for byte.
    const v4 = buildScribePromptV4(asked('write'))
    const v4System = v4.messages[0]?.content ?? ''
    expect(
      system.slice(SCRIBE_V5_RULES.length, system.length - SCRIBE_V5_MODE_RULES.write.length)
    ).toBe(
      v4System.slice(SCRIBE_V4_RULES.length, v4System.length - SCRIBE_V3_MODE_RULES.write.length)
    )
    expect(built.messages.slice(1)).toEqual(v4.messages.slice(1))
    // Every structure tool is described, by its one line.
    for (const tool of SCRIBE_STRUCTURE_TOOLS)
      expect(SCRIBE_V5_STRUCTURE_RULES).toContain(`${tool} {`)
    expect(SCRIBE_V5_STRUCTURE_RULES).toContain('These never write scene text.')
    expect(built).toMatchSnapshot()
  })

  it('keeps the cached prefix the same in every mode, the mode line last, Brainstorm changing nothing', () => {
    const prefix = (mode: AssistantMode): string => {
      const system = systemOf(asked(mode))
      return system.slice(0, system.indexOf('# Now'))
    }
    expect(prefix('vibe')).toBe(prefix('write'))
    expect(prefix('brainstorm')).toBe(prefix('write'))
    for (const mode of ['brainstorm', 'write', 'vibe'] as const) {
      expect(systemOf(asked(mode)).endsWith(SCRIBE_V5_MODE_RULES[mode])).toBe(true)
    }
    expect(SCRIBE_V5_MODE_RULES.brainstorm).toContain('no note, structure or prose tools')
    expect(systemOf(asked('brainstorm', 'Save that.')).endsWith(SCRIBE_V5_MODE_RULES.save)).toBe(
      true
    )
    expect(SCRIBE_V5_MODE_RULES.save).toContain('No structure tools')
    expect(SCRIBE_V5_MODE_RULES.write.startsWith(SCRIBE_V3_MODE_RULES.write)).toBe(true)
    expect(SCRIBE_V5_MODE_RULES.vibe.startsWith(SCRIBE_V3_MODE_RULES.vibe)).toBe(true)
  })

  it('ends with the final or the retry turn', () => {
    const steps = [
      { call: '{"tool":"list_notes","args":{}}', result: 'Result of list_notes:\np1 …' }
    ]
    expect(buildScribePromptV5({ ...base, steps, final: true }).messages.at(-1)?.content).toBe(
      SCRIBE_FINAL_TURN
    )
    const retry = buildScribePromptV5({ ...base, steps, final: true, retry: true })
    expect(retry.messages.at(-1)?.content).toBe(SCRIBE_RETRY_TURN)
    expect(retry.maxTokens).toBe(SCRIBE_RETRY_MAX_TOKENS)
  })
})
