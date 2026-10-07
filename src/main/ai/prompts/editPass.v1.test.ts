import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { estimateTokens, outputBudget } from '@shared/ai'
import { EDIT_PASS_TYPES } from '@shared/editPass'
import {
  buildEditPassPrompt,
  EDIT_PASS_PROMPT_VERSION,
  EDIT_PASS_SENTINEL,
  EDIT_PASS_TASKS,
  type BuildEditPassPromptInput
} from './editPass.v1'

const TEXT =
  'The ferry landing was empty when Mara reached it. She walked very slowly to the end of the pier.'

const base: BuildEditPassPromptInput = {
  type: 'line',
  text: TEXT,
  title: 'The Crossing',
  part: { index: 0, count: 1 },
  voice: null,
  keepWords: [],
  references: [],
  instruction: null
}

describe('editPass.v1 prompt (F-14.15)', () => {
  it('pins every pass type’s messages (a change here is a new version)', () => {
    const all = Object.fromEntries(
      EDIT_PASS_TYPES.map((type) => [
        type,
        buildEditPassPrompt({
          ...base,
          type,
          voice: type === 'line' ? "Match the author's voice: short sentences." : null,
          keepWords: type === 'copy' || type === 'proofread' ? ['Mara', 'Tomas'] : [],
          references: type === 'continuity' ? ['[1] Mara (character), sheet, Eyes: grey'] : [],
          instruction: type === 'custom' ? 'Cut every adverb.' : null
        }).messages
      ])
    )
    expect(all).toMatchSnapshot()
  })

  it('opens with the sentinel and orders rules, task, voice, keep list; then references, instruction, text', () => {
    const built = buildEditPassPrompt({
      ...base,
      type: 'copy',
      voice: 'VOICE',
      keepWords: ['Mara'],
      references: ['[1] ref'],
      instruction: 'Prefer British spelling.',
      part: { index: 1, count: 3 }
    })
    expect(built.version).toBe(EDIT_PASS_PROMPT_VERSION)
    const [system, user] = built.messages
    expect(system?.role).toBe('system')
    expect(system?.content.startsWith(EDIT_PASS_SENTINEL)).toBe(true)
    expect(system?.content).toContain(`${EDIT_PASS_TASKS.copy} VOICE\n\nKeep as written: Mara.`)
    expect(user?.content).toBe(
      'References:\n[1] ref\n\n' +
        `The author's instruction:\n"""\nPrefer British spelling.\n"""\n\n` +
        `Scene: The Crossing (part 2 of 3)\nText:\n"""\n${TEXT}\n"""\n\nEdit the text.`
    )
    expect('temperature' in built).toBe(false)
  })

  it('asks a developmental pass for notes, never changes', () => {
    const built = buildEditPassPrompt({ ...base, type: 'developmental' })
    expect(built.messages[0]?.content).toContain('{"notes":[')
    expect(built.messages[0]?.content).not.toContain('{"changes":[')
    expect(built.messages[1]?.content.endsWith('Write your notes.')).toBe(true)
  })

  it('asks for the feature output budget and costs what the golden estimates say', () => {
    const built = buildEditPassPrompt(base)
    expect(built.maxTokens).toBe(outputBudget('editPass'))
    // The golden estimates: a change here means the prompt changed and needs a new version.
    expect(estimateTokens(built.messages[0]?.content ?? '')).toBe(215)
    expect(estimateTokens(built.messages.map((m) => m.content).join('\n'))).toBe(252)
  })

  it("pins the e2e fake server's EDIT_PASS_SENTINEL to this version's opening (the e2e tsconfig cannot import from src/main)", () => {
    const spec = readFileSync(join(__dirname, '../../../../e2e/smoke.spec.ts'), 'utf8')
    const match = /const EDIT_PASS_SENTINEL = '([^']+)'/.exec(spec)
    if (!match) throw new Error('e2e/smoke.spec.ts no longer declares EDIT_PASS_SENTINEL')
    expect(match[1]).toBe(EDIT_PASS_SENTINEL)
  })
})
