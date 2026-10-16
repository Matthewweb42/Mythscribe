import { describe, expect, it } from 'vitest'
import { EDIT_FLOW_MAX_TOKENS } from '@shared/editFlow'
import {
  buildEditFlowPrompt,
  EDIT_FLOW_PROMPT_VERSION,
  EDIT_FLOW_SENTINEL,
  type BuildEditFlowPromptInput
} from './editFlow.v1'
import { buildEditNotesPrompt, EDIT_NOTES_PROMPT_VERSION } from './editNotes.v1'

const base: BuildEditFlowPromptInput = {
  family: 'copy',
  checks: [],
  styleGuide: null,
  notes: '## p1 Mara (note)\nEyes: grey.',
  map: 'n3 Chapter 1 › Mara | synopsis: Mara climbs the ridge.',
  reference: null,
  slice: { index: 0, count: 1, label: 'Chapter 1 › Mara' },
  items: [
    {
      ref: 'n3',
      title: 'Chapter 1 › Mara',
      text: 'Mara climbed the ridge alone.\n\nShe teh sea below.',
      part: { index: 0, count: 1 }
    }
  ]
}

describe('editFlow.v1 prompt (notes redesign phase 2)', () => {
  it('pins every family’s messages', () => {
    for (const family of ['developmental', 'line', 'copy', 'proof', 'checks'] as const) {
      const built = buildEditFlowPrompt({
        ...base,
        family,
        checks: family === 'checks' ? ['continuity', 'plotHoles', 'voice', 'lineSpelling'] : []
      })
      expect(built.version).toBe(EDIT_FLOW_PROMPT_VERSION)
      expect(built.maxTokens).toBe(EDIT_FLOW_MAX_TOKENS)
      expect(built.messages).toMatchSnapshot(family)
    }
  })

  it('shares one system turn across families and with Update notes, so a run’s prefix caches', () => {
    const copy = buildEditFlowPrompt(base).messages[0]?.content
    const line = buildEditFlowPrompt({ ...base, family: 'line' }).messages[0]?.content
    const notes = buildEditNotesPrompt(base)
    expect(notes.version).toBe(EDIT_NOTES_PROMPT_VERSION)
    expect(copy?.startsWith(EDIT_FLOW_SENTINEL)).toBe(true)
    expect(line).toBe(copy)
    expect(notes.messages[0]?.content).toBe(copy)
    expect(copy).toContain('# Notes\n## p1 Mara (note)')
    expect(copy).toContain('# Book map\nn3 Chapter 1')
    // The text and the task stay out of the prefix.
    expect(copy).not.toContain('She teh sea below.')
    expect(notes.messages[1]?.content).toMatchSnapshot('notes user turn')
  })

  it('Deep on a scene or a chapter carries the rest of the book in the shared prefix', () => {
    const system =
      buildEditFlowPrompt({ ...base, reference: '### n4 Chapter 1 › Rook\nRook waited.' })
        .messages[0]?.content ?? ''
    expect(system).toContain(
      '# The rest of the book, for reference (edit only the text each message gives)\n### n4 Chapter 1 › Rook\nRook waited.'
    )
    expect(system.indexOf('# Book map')).toBeLessThan(system.indexOf('# The rest of the book'))
  })

  it('copyediting follows her Style guide page when there is one', () => {
    const user = buildEditFlowPrompt({ ...base, styleGuide: { ref: 'p4', title: 'Style guide' } })
      .messages[1]?.content
    expect(user).toContain('Follow her style guide, p4 “Style guide”')
    expect(buildEditFlowPrompt(base).messages[1]?.content).toContain(
      'She has no style guide page: follow standard conventions'
    )
  })

  it('the checks family names only the checks asked for; a longer run says which part', () => {
    const user =
      buildEditFlowPrompt({
        ...base,
        family: 'checks',
        checks: ['voice'],
        slice: { index: 1, count: 3, label: 'Chapter 2' }
      }).messages[1]?.content ?? ''
    expect(user).toContain('- voice:')
    expect(user).not.toContain('- continuity:')
    expect(user).toContain('"check" is one of voice.')
    expect(user).toContain('# Text: Chapter 2 (part 2 of 3)\n### n3 Chapter 1 › Mara\n')
  })
})
