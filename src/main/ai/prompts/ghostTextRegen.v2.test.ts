import { describe, expect, it } from 'vitest'
import { estimateTokens, GHOST_AFTER_CHARS, GHOST_BEFORE_CHARS, inputBudget } from '@shared/ai'
import { builtinParams } from '@shared/presets'
import { GHOST_NOTES_CHAR_CAP } from './ghostText.v1'
import { buildGhostTextPromptV2, type BuildGhostTextPromptV2Input } from './ghostText.v2'
import { REGEN_CLAUSE_PREFIX } from './ghostTextRegen.v1'
import { buildGhostTextRegenPromptV2 } from './ghostTextRegen.v2'

const BEFORE =
  'The storm broke at dusk over the dark forest. Mara pulled her cloak tight and counted the ' +
  'lightning gaps, each one shorter than the last.'
const BRIEF = 'Scene brief:\n- Goal: Mara wants to reach the ferry before the crossing closes.'
const general = builtinParams('general')
const minimal: BuildGhostTextPromptV2Input = {
  before: BEFORE,
  after: '',
  notes: null,
  meta: null,
  brief: null,
  voice: null,
  preset: general
}
const VIOLATION = 'switches to present tense'
const CLAUSE =
  `${REGEN_CLAUSE_PREFIX} ${VIOLATION}. ` +
  "Write a different continuation that keeps the manuscript's voice."

const promptText = (messages: { content: string }[]): string =>
  messages.map((m) => m.content).join('\n')

describe('ghostTextRegen.v2 prompt (F-14.7, F-14.3)', () => {
  it('is ghostText.v2 with the violation clause appended to the system turn, the user turn untouched', () => {
    const base = buildGhostTextPromptV2({ ...minimal, brief: BRIEF })
    const built = buildGhostTextRegenPromptV2({ ...minimal, brief: BRIEF, violation: VIOLATION })
    expect(built.version).toBe('ghostTextRegen.v2')
    expect(built.messages).toEqual([
      { role: 'system', content: `${base.messages[0]?.content} ${CLAUSE}` },
      base.messages[1]
    ])
    expect(built.messages[1]?.content).toContain(BRIEF)
    expect(built.messages[0]?.content.endsWith(CLAUSE)).toBe(true)
  })

  it('keeps the voice block and the preset ahead of the clause, so the cached prefix still applies', () => {
    const voice = "Match the author's voice:\n- Narration is in past tense."
    const built = buildGhostTextRegenPromptV2({ ...minimal, voice, violation: VIOLATION })
    const system = built.messages[0]?.content ?? ''
    expect(system.indexOf(voice)).toBeGreaterThan(0)
    expect(system.indexOf(voice)).toBeLessThan(system.indexOf(general.styleInstruction))
    expect(system.indexOf(general.styleInstruction)).toBeLessThan(system.indexOf(CLAUSE))
  })

  it('passes the caps and the temperature through unchanged', () => {
    const action = builtinParams('action')
    const base = buildGhostTextPromptV2({ ...minimal, preset: action })
    const built = buildGhostTextRegenPromptV2({ ...minimal, preset: action, violation: VIOLATION })
    expect(built.maxTokens).toBe(base.maxTokens)
    expect(built.temperature).toBe(base.temperature)
  })

  it('stays under the ghost-text input budget for a maxed-out window, notes, metadata, and brief', () => {
    const built = buildGhostTextRegenPromptV2({
      before: 'b'.repeat(GHOST_BEFORE_CHARS),
      after: 'a'.repeat(GHOST_AFTER_CHARS),
      notes: 'n'.repeat(GHOST_NOTES_CHAR_CAP + 100),
      meta: { location: 'L'.repeat(200), pov: 'P'.repeat(200), timeline: 'T'.repeat(500) },
      brief:
        'Scene brief:\n' + ['g', 'c', 't', 'b', 'a', 'p', 'n'].map((c) => c.repeat(210)).join('\n'),
      voice: null,
      preset: general,
      violation: 'runs to a much longer sentence than the manuscript'
    })
    const estimate = estimateTokens(promptText(built.messages))
    expect(estimate).toBeLessThan(inputBudget('ghostText'))
    // The golden estimate: the base prompt at its caps plus the clause.
    expect(estimate).toBe(1_114)
  })
})
