import { describe, expect, it } from 'vitest'
import { BETA_READER_HONESTY, BETA_READER_RULES, buildBetaReaderPrompt } from './betaReader.v1'
import type { BuildBetaReaderPromptInput } from './betaReader.v1'
import { buildBetaReaderRegenPrompt } from './betaReaderRegen.v1'

const SCENE =
  'The ferry landing was empty when Mara reached it. She set the lantern down and waited.'
const base: BuildBetaReaderPromptInput = {
  scenes: [
    {
      title: 'Chapter 1 › Opening',
      summary: 'Mara finds the ledger her brother copied.',
      keyPoints: ['The ledger is copied.']
    }
  ],
  current: { title: 'Chapter 2 › The ferry landing', text: SCENE },
  honesty: 'direct'
}
const NOTE = 'Less about what I expect, more about where I got lost.'
const NOTE_CLAUSE = `The writer asked for a different read and said: "${NOTE}".`

describe('betaReaderRegen.v1 prompt (F-14.11, F-14.5)', () => {
  it('is betaReader.v1 with the author’s note appended to the user turn, the system turn untouched', () => {
    const built = buildBetaReaderRegenPrompt({ ...base, note: NOTE })
    const plain = buildBetaReaderPrompt(base)
    expect(built.version).toBe('betaReaderRegen.v1')
    expect(built.messages).toEqual([
      plain.messages[0],
      { role: 'user', content: `${plain.messages[1]?.content}\n\n${NOTE_CLAUSE}` }
    ])
  })

  it('leaves the cached prefix byte for byte: the rules and the honesty line are the plain read’s', () => {
    const system = buildBetaReaderRegenPrompt({ ...base, note: NOTE }).messages[0]?.content ?? ''
    expect(system).toBe(`${BETA_READER_RULES} ${BETA_READER_HONESTY[base.honesty]}`)
    expect(system).not.toContain(NOTE_CLAUSE)
  })

  it('keeps the scenes and the ask ahead of the clause, which ends the turn', () => {
    const user = buildBetaReaderRegenPrompt({ ...base, note: NOTE }).messages[1]?.content ?? ''
    const clauseAt = user.indexOf(NOTE_CLAUSE)
    expect(user.indexOf('Scenes read so far')).toBeLessThan(clauseAt)
    expect(user.indexOf('(this scene, full text):')).toBeLessThan(clauseAt)
    expect(user.indexOf('Report as the reader.')).toBeLessThan(clauseAt)
    expect(user.endsWith(NOTE_CLAUSE)).toBe(true)
  })

  it('is the base prompt under the regenerate version when the author asked again without a note', () => {
    const built = buildBetaReaderRegenPrompt({ ...base, note: null })
    expect(built.messages).toEqual(buildBetaReaderPrompt(base).messages)
    expect(built.version).toBe('betaReaderRegen.v1')
  })

  it('carries no violation clause: the reader proposes nothing that could fail the fidelity check', () => {
    const text = buildBetaReaderRegenPrompt({ ...base, note: NOTE })
      .messages.map((message) => message.content)
      .join('\n')
    expect(text).not.toContain('Your last attempt')
    expect(text).not.toContain('keeping the manuscript')
  })

  it('passes the cap through unchanged and asks for no temperature', () => {
    const built = buildBetaReaderRegenPrompt({ ...base, note: NOTE })
    expect(built.maxTokens).toBe(buildBetaReaderPrompt(base).maxTokens)
    expect('temperature' in built).toBe(false)
  })
})
