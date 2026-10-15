import { describe, expect, it } from 'vitest'
import { outputBudget } from '@shared/ai'
import { SCRIBE_RETRY_MAX_TOKENS, SCRIBE_STEP_MAX_TOKENS } from '@shared/scribe2'
import {
  SCRIBE_FINAL_TURN,
  SCRIBE_PROMPT_VERSION,
  SCRIBE_RETRY_TURN,
  SCRIBE_RULES,
  SCRIBE_SENTINEL,
  buildScribePrompt,
  scribeRules,
  type BuildScribePromptInput
} from './scribe.v1'

const base: BuildScribePromptInput = {
  mode: 'write',
  access: { notes: true, prose: true },
  context: {
    notes: '## p1 Mara (note)\nEyes: grey. Fears the sea.',
    map: 'n1 Chapter 1 › The Ridge | synopsis: Mara climbs.\nn2 Chapter 1 › The Quay | notes: Rook lies.',
    book: '### n1 Chapter 1 › The Ridge\nMara climbed the ridge.\n\n### n2 Chapter 1 › The Quay\nRook waited.',
    bookMode: 'whole',
    moment:
      'The author is in n2 Chapter 1 › The Quay.\nIts notes: Rook lies.\nIts text is in the book above (n2).'
  },
  history: [
    { role: 'user', content: 'Who is Rook?' },
    { role: 'assistant', content: 'A smuggler (p2).' }
  ],
  message: 'Put that Mara fears the sea in her page.',
  steps: [],
  final: false
}

describe('scribe.v1 (notes redesign phase 1)', () => {
  it('builds the request in cache order: rules, notes, map, book, the moment; then the turns and the message', () => {
    const built = buildScribePrompt(base)
    expect(built.version).toBe(SCRIBE_PROMPT_VERSION)
    expect(built.maxTokens).toBe(SCRIBE_STEP_MAX_TOKENS)
    expect(built.messages.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'user'])
    const system = built.messages[0]?.content ?? ''
    expect(system.startsWith(SCRIBE_SENTINEL)).toBe(true)
    const at = (text: string): number => system.indexOf(text)
    expect(at('# Notes')).toBeGreaterThan(at('Read tools:'))
    expect(at('# Book map')).toBeGreaterThan(at('# Notes'))
    expect(at('# The book')).toBeGreaterThan(at('# Book map'))
    expect(at('# Now')).toBeGreaterThan(at('# The book'))
    expect(built.messages.at(-1)?.content).toBe(base.message)
    expect(built).toMatchSnapshot()
  })

  it('keeps the stable prefix byte for byte when only the moment or the message changes', () => {
    const one = buildScribePrompt(base).messages[0]?.content ?? ''
    const two =
      buildScribePrompt({
        ...base,
        message: 'Anything else?',
        context: { ...base.context, moment: 'No scene is open.' }
      }).messages[0]?.content ?? ''
    const prefix = one.slice(0, one.indexOf('# Now'))
    expect(two.startsWith(prefix)).toBe(true)
  })

  it('names the picked scenes as such when the book does not go whole', () => {
    const built = buildScribePrompt({ ...base, context: { ...base.context, bookMode: 'picked' } })
    expect(built.messages[0]?.content).toContain(
      '# Scenes picked for this message (the rest: open_scene)'
    )
  })

  it('gives each mode its tools: Brainstorm none, Brainstorm asked to save the note tools only, Write and Vibe all', () => {
    const brainstorm = scribeRules('brainstorm', { notes: false, prose: false })
    expect(brainstorm).not.toContain('edit_note')
    expect(brainstorm).not.toContain('propose_prose_edit')
    expect(brainstorm).toContain('Mode Brainstorm: think and plan with her; you change nothing.')
    const save = scribeRules('brainstorm', { notes: true, prose: false })
    expect(save).toContain('edit_note')
    expect(save).not.toContain('propose_prose_edit')
    expect(save).toContain('she asked you to save')
    const write = scribeRules('write', { notes: true, prose: true })
    expect(write).toContain('edit_note')
    expect(write).toContain('propose_prose_edit')
    expect(scribeRules('vibe', { notes: true, prose: true })).toContain('bolder')
    expect(SCRIBE_RULES).toContain('give two options')
    expect(SCRIBE_RULES).toContain('say so plainly')
  })

  it('replays each step as the call and its result, and ends with the final or the retry turn', () => {
    const steps = [
      {
        call: '{"tool":"open_note","args":{"id":"p1"}}',
        result: 'Result of open_note:\np1 Mara:\nEyes: grey.'
      }
    ]
    const final = buildScribePrompt({ ...base, steps, final: true })
    expect(final.messages.slice(-3).map((m) => m.content)).toEqual([
      steps[0]?.call,
      steps[0]?.result,
      SCRIBE_FINAL_TURN
    ])
    const retry = buildScribePrompt({ ...base, steps, final: true, retry: true })
    expect(retry.messages.at(-1)?.content).toBe(SCRIBE_RETRY_TURN)
    expect(retry.maxTokens).toBe(SCRIBE_RETRY_MAX_TOKENS)
    expect(SCRIBE_RETRY_MAX_TOKENS).toBeLessThanOrEqual(outputBudget('scribe'))
  })
})
