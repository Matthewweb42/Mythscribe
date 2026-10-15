import { describe, expect, it } from 'vitest'
import { SCRIBE_RETRY_MAX_TOKENS, SCRIBE_STEP_MAX_TOKENS } from '@shared/scribe2'
import {
  SCRIBE_FINAL_TURN,
  SCRIBE_RETRY_TURN,
  SCRIBE_SENTINEL,
  buildScribePrompt,
  type BuildScribePromptInput
} from './scribe.v1'
import {
  SCRIBE_V2_PROMPT_VERSION,
  SCRIBE_V2_RULES,
  buildScribePromptV2,
  scribeRulesV2
} from './scribe.v2'

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
  message: 'Where does Tash first see the sea?',
  steps: [],
  final: false
}

describe('scribe.v2 (sources with quotes, places by chapter)', () => {
  it('builds the request as v1 does, in cache order, with the v2 rules', () => {
    const built = buildScribePromptV2(base)
    expect(built.version).toBe(SCRIBE_V2_PROMPT_VERSION)
    expect(built.maxTokens).toBe(SCRIBE_STEP_MAX_TOKENS)
    expect(built.messages.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'user'])
    const system = built.messages[0]?.content ?? ''
    // The e2e fake's sentinel stays first.
    expect(system.startsWith(SCRIBE_SENTINEL)).toBe(true)
    const at = (text: string): number => system.indexOf(text)
    expect(at('# Notes')).toBeGreaterThan(at('Read tools:'))
    expect(at('# Book map')).toBeGreaterThan(at('# Notes'))
    expect(at('# The book')).toBeGreaterThan(at('# Book map'))
    expect(at('# Now')).toBeGreaterThan(at('# The book'))
    // Only the rules differ from v1.
    const v1 = buildScribePrompt(base)
    expect(system.slice(at('# Notes'))).toBe(
      (v1.messages[0]?.content ?? '').slice((v1.messages[0]?.content ?? '').indexOf('# Notes'))
    )
    expect(built.messages.slice(1)).toEqual(v1.messages.slice(1))
    expect(built).toMatchSnapshot()
  })

  it('asks for a quote with each source and for refs in place of scene titles', () => {
    expect(SCRIBE_V2_RULES).toContain('"sources":[{"ref":"n3","quote":"')
    expect(SCRIBE_V2_RULES).toContain('copied exactly')
    expect(SCRIBE_V2_RULES).toContain('as its chapter’s name')
    expect(SCRIBE_V2_RULES).toContain('never write a scene’s title yourself')
  })

  it('gives each mode its tools as v1 does', () => {
    const brainstorm = scribeRulesV2('brainstorm', { notes: false, prose: false })
    expect(brainstorm).not.toContain('edit_note')
    expect(brainstorm).not.toContain('propose_prose_edit')
    const save = scribeRulesV2('brainstorm', { notes: true, prose: false })
    expect(save).toContain('edit_note')
    expect(save).not.toContain('propose_prose_edit')
    const write = scribeRulesV2('write', { notes: true, prose: true })
    expect(write).toContain('edit_note')
    expect(write).toContain('propose_prose_edit')
    expect(scribeRulesV2('vibe', { notes: true, prose: true })).toContain('bolder')
  })

  it('ends with the final or the retry turn', () => {
    const steps = [
      { call: '{"tool":"list_notes","args":{}}', result: 'Result of list_notes:\np1 Mara' }
    ]
    expect(buildScribePromptV2({ ...base, steps, final: true }).messages.at(-1)?.content).toBe(
      SCRIBE_FINAL_TURN
    )
    const retry = buildScribePromptV2({ ...base, steps, final: true, retry: true })
    expect(retry.messages.at(-1)?.content).toBe(SCRIBE_RETRY_TURN)
    expect(retry.maxTokens).toBe(SCRIBE_RETRY_MAX_TOKENS)
  })
})
