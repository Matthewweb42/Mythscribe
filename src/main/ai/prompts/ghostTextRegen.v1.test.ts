import { describe, expect, it } from 'vitest'
import { estimateTokens, GHOST_AFTER_CHARS, GHOST_BEFORE_CHARS, inputBudget } from '@shared/ai'
import { builtinParams } from '@shared/presets'
import { buildGhostTextPrompt, GHOST_NOTES_CHAR_CAP } from './ghostText.v1'
import { buildGhostTextRegenPrompt, REGEN_CLAUSE_PREFIX } from './ghostTextRegen.v1'

const BEFORE =
  'The storm broke at dusk over the dark forest. Mara pulled her cloak tight and counted the ' +
  'lightning gaps, each one shorter than the last.'
const general = builtinParams('general')
const minimal = { before: BEFORE, after: '', notes: null, meta: null, voice: null, preset: general }
const VIOLATION = 'switches to present tense'
const CLAUSE =
  `${REGEN_CLAUSE_PREFIX} ${VIOLATION}. ` +
  "Write a different continuation that keeps the manuscript's voice."

const promptText = (messages: { content: string }[]): string =>
  messages.map((m) => m.content).join('\n')

describe('ghostTextRegen.v1 prompt (F-14.7)', () => {
  it('is ghostText.v1 with the violation clause appended to the system turn, the user turn untouched', () => {
    const base = buildGhostTextPrompt(minimal)
    const built = buildGhostTextRegenPrompt({ ...minimal, violation: VIOLATION })
    expect(built.version).toBe('ghostTextRegen.v1')
    expect(built.messages).toEqual([
      { role: 'system', content: `${base.messages[0]?.content} ${CLAUSE}` },
      base.messages[1]
    ])
    expect(built.messages[0]?.content.endsWith(CLAUSE)).toBe(true)
    expect(REGEN_CLAUSE_PREFIX).toBe('Your last attempt')
  })

  it('keeps the voice block and the preset ahead of the clause, so the cached prefix still applies', () => {
    const voice = "Match the author's voice:\n- Narration is in past tense."
    const built = buildGhostTextRegenPrompt({ ...minimal, voice, violation: VIOLATION })
    const system = built.messages[0]?.content ?? ''
    expect(system.indexOf(voice)).toBeGreaterThan(0)
    expect(system.indexOf(voice)).toBeLessThan(system.indexOf(general.styleInstruction))
    expect(system.indexOf(general.styleInstruction)).toBeLessThan(system.indexOf(CLAUSE))
  })

  it('passes the caps and the temperature through unchanged', () => {
    const action = builtinParams('action')
    const base = buildGhostTextPrompt({ ...minimal, preset: action })
    const built = buildGhostTextRegenPrompt({ ...minimal, preset: action, violation: VIOLATION })
    expect(built.maxTokens).toBe(base.maxTokens)
    expect(built.temperature).toBe(base.temperature)
  })

  it('stays under the ghost-text input budget for a maxed-out window, notes, and metadata', () => {
    const built = buildGhostTextRegenPrompt({
      before: 'b'.repeat(GHOST_BEFORE_CHARS),
      after: 'a'.repeat(GHOST_AFTER_CHARS),
      notes: 'n'.repeat(GHOST_NOTES_CHAR_CAP + 100),
      meta: { location: 'L'.repeat(200), pov: 'P'.repeat(200), timeline: 'T'.repeat(500) },
      voice: null,
      preset: general,
      violation: 'runs to a much longer sentence than the manuscript'
    })
    const estimate = estimateTokens(promptText(built.messages))
    expect(estimate).toBeLessThan(inputBudget('ghostText'))
    // The golden estimate: the base prompt's 707 plus the clause.
    expect(estimate).toBe(741)
  })
})
