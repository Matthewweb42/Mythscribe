import { describe, expect, it } from 'vitest'
import { AiSettings, AssistantMode, defaultAiSettings, migrateAssistantMode } from './aiSettings'
import {
  SCRIBE_MAX_WRITES,
  SCRIBE_VIBE_PROSE_MAX,
  scribeAccess,
  scribeProseMax,
  wantsSave
} from './scribe2'

describe('chat modes Brainstorm, Write, Vibe (notes redesign phase 1)', () => {
  it('reads a stored Plan as Brainstorm, Ask and Auto as Write, and keeps the new modes', () => {
    expect(AssistantMode.parse('plan')).toBe('brainstorm')
    expect(AssistantMode.parse('ask')).toBe('write')
    expect(AssistantMode.parse('auto')).toBe('write')
    for (const mode of ['brainstorm', 'write', 'vibe'] as const) {
      expect(AssistantMode.parse(mode)).toBe(mode)
    }
    expect(AssistantMode.safeParse('loud').success).toBe(false)
    expect(migrateAssistantMode(3)).toBe(3)
    // A stored settings row migrates in code: no database migration.
    const { chatMode: _dropped, ...row } = defaultAiSettings()
    expect(AiSettings.parse({ ...row, dial: 1, chatMode: 'plan' }).chatMode).toBe('brainstorm')
    expect(AiSettings.parse({ ...row, dial: 1, chatMode: 'auto' }).chatMode).toBe('write')
    expect(AiSettings.parse({ ...row, dial: 1, auto: true }).chatMode).toBe('write')
    expect(defaultAiSettings().chatMode).toBe('write')
  })

  it('lets Brainstorm write notes only when the author asks it to save, and never prose or structure', () => {
    expect(scribeAccess('brainstorm', 'What if Rook lied?')).toEqual({
      notes: false,
      prose: false,
      structure: false
    })
    expect(scribeAccess('brainstorm', 'Good, save that.')).toEqual({
      notes: true,
      prose: false,
      structure: false
    })
    const all = { notes: true, prose: true, structure: true }
    expect(scribeAccess('write', 'Anything')).toEqual(all)
    expect(scribeAccess('vibe', 'Anything')).toEqual(all)
  })

  it('hears "save that" and its cousins, and not a plain question', () => {
    for (const yes of [
      'save that',
      'Save this to my notes',
      'keep it in the timeline please',
      "put that in Mara's page",
      'add that to the timeline',
      'write this down',
      'note that down',
      'update my notes'
    ]) {
      expect(wantsSave(yes), yes).toBe(true)
    }
    for (const no of [
      'What should I write next?',
      'Is this line in character?',
      'Add more tension to this scene',
      'Where did Rook put the key?'
    ]) {
      expect(wantsSave(no), no).toBe(false)
    }
  })
})

describe('prose suggestions per message (scribe.v3, 2026-10-15)', () => {
  it('caps Vibe at three and leaves Write and Brainstorm at the write cap', () => {
    expect(SCRIBE_VIBE_PROSE_MAX).toBe(3)
    expect(scribeProseMax('vibe')).toBe(3)
    expect(scribeProseMax('write')).toBe(SCRIBE_MAX_WRITES)
    expect(scribeProseMax('brainstorm')).toBe(SCRIBE_MAX_WRITES)
  })
})
