import { describe, expect, it } from 'vitest'
import type { AssistantMode } from '@shared/aiSettings'
import {
  SCRIBE_RETRY_MAX_TOKENS,
  SCRIBE_STEP_MAX_TOKENS,
  scribeAccess,
  type ScribeAccess
} from '@shared/scribe2'
import {
  SCRIBE_FINAL_TURN,
  SCRIBE_NOTE_RULES,
  SCRIBE_PROSE_RULES,
  SCRIBE_RETRY_TURN,
  SCRIBE_SENTINEL,
  type BuildScribePromptInput
} from './scribe.v1'
import { SCRIBE_V2_RULES, buildScribePromptV2 } from './scribe.v2'
import {
  SCRIBE_V3_MODE_RULES,
  SCRIBE_V3_PROMPT_VERSION,
  SCRIBE_V3_RULES,
  buildScribePromptV3,
  scribeModeLineV3
} from './scribe.v3'

const base: BuildScribePromptInput = {
  mode: 'write',
  access: { notes: true, prose: true },
  context: {
    notes: '## p1 Mara (note)\nEyes: grey. Fears the sea.',
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
  message: 'What can I do to make this scene better?',
  steps: [],
  final: false
}

const asked = (mode: AssistantMode, message = base.message): BuildScribePromptInput => ({
  ...base,
  mode,
  access: scribeAccess(mode, message),
  message
})

const systemOf = (input: BuildScribePromptInput): string =>
  buildScribePromptV3(input).messages[0]?.content ?? ''

/** Everything of the system message before `# Now`: the part the provider caches. */
const prefixOf = (input: BuildScribePromptInput): string => {
  const system = systemOf(input)
  return system.slice(0, system.indexOf('# Now'))
}

describe('scribe.v3 (Vibe proposes bolder changes; the mode in the moment)', () => {
  it('builds the request in cache order, the mode line last in the moment', () => {
    const built = buildScribePromptV3(asked('vibe'))
    expect(built.version).toBe(SCRIBE_V3_PROMPT_VERSION)
    expect(built.maxTokens).toBe(SCRIBE_STEP_MAX_TOKENS)
    expect(built.messages.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'user'])
    const system = built.messages[0]?.content ?? ''
    // The e2e fake's sentinel stays first.
    expect(system.startsWith(SCRIBE_SENTINEL)).toBe(true)
    const at = (text: string): number => system.indexOf(text)
    expect(at('# Notes')).toBeGreaterThan(at('propose_prose_edit {'))
    expect(at('# Book map')).toBeGreaterThan(at('# Notes'))
    expect(at('# The book')).toBeGreaterThan(at('# Book map'))
    expect(at('# Now')).toBeGreaterThan(at('# The book'))
    expect(
      system.endsWith(`Its text is in the book above (n3).\n${SCRIBE_V3_MODE_RULES.vibe}`)
    ).toBe(true)
    // Beyond the rules and the mode line, the request is v2's.
    const v2 = buildScribePromptV2(asked('vibe'))
    const v2System = v2.messages[0]?.content ?? ''
    expect(system.slice(at('# Notes'), at('# Now'))).toBe(
      v2System.slice(v2System.indexOf('# Notes'), v2System.indexOf('# Now'))
    )
    expect(built.messages.slice(1)).toEqual(v2.messages.slice(1))
    expect(built).toMatchSnapshot()
  })

  it('keeps the cached prefix the same in every mode, saving included', () => {
    const write = prefixOf(asked('write'))
    expect(write.startsWith(`${SCRIBE_V3_RULES}\n\n# Notes\n`)).toBe(true)
    expect(prefixOf(asked('vibe'))).toBe(write)
    expect(prefixOf(asked('brainstorm'))).toBe(write)
    expect(prefixOf(asked('brainstorm', 'Good, save that in her page.'))).toBe(write)
    expect(SCRIBE_V3_RULES).toBe(
      [SCRIBE_V2_RULES, SCRIBE_NOTE_RULES, SCRIBE_PROSE_RULES].join('\n')
    )
  })

  it('says each mode in the moment: Vibe proposes unasked and big, Write when asked, Brainstorm nothing', () => {
    const line = (mode: AssistantMode, access: ScribeAccess): string =>
      scribeModeLineV3(mode, access)
    const vibe = line('vibe', { notes: true, prose: true })
    expect(vibe).toContain('propose the change yourself with propose_prose_edit, unasked')
    expect(vibe).toContain('rewrite a whole paragraph, cut, reorder a beat')
    expect(vibe).toContain('At most 3 changes, each with its reason in one line')
    expect(vibe).toContain('She accepts or rejects each')
    const write = line('write', { notes: true, prose: true })
    expect(write).toContain('use propose_prose_edit only when she asks for a change')
    expect(write).not.toContain('unasked')
    expect(line('brainstorm', { notes: false, prose: false })).toContain('you change nothing')
    expect(line('brainstorm', { notes: true, prose: false })).toBe(SCRIBE_V3_MODE_RULES.save)
    for (const mode of ['brainstorm', 'write', 'vibe'] as const) {
      expect(systemOf(asked(mode))).toContain(`\n${SCRIBE_V3_MODE_RULES[mode]}`)
    }
  })

  it('ends with the final or the retry turn', () => {
    const steps = [
      { call: '{"tool":"open_scene","args":{"id":"n3"}}', result: 'Result of open_scene:\nn3 …' }
    ]
    expect(buildScribePromptV3({ ...base, steps, final: true }).messages.at(-1)?.content).toBe(
      SCRIBE_FINAL_TURN
    )
    const retry = buildScribePromptV3({ ...base, steps, final: true, retry: true })
    expect(retry.messages.at(-1)?.content).toBe(SCRIBE_RETRY_TURN)
    expect(retry.maxTokens).toBe(SCRIBE_RETRY_MAX_TOKENS)
  })
})
