import { describe, expect, it } from 'vitest'
import { AiSettings, AssistantMode, defaultAiSettings, migrateAssistantMode } from './aiSettings'
import { scribeAccess, wantsSave } from './scribe2'

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

  it('lets Brainstorm write notes only when the author asks it to save, and never prose', () => {
    expect(scribeAccess('brainstorm', 'What if Rook lied?')).toEqual({ notes: false, prose: false })
    expect(scribeAccess('brainstorm', 'Good, save that.')).toEqual({ notes: true, prose: false })
    expect(scribeAccess('write', 'Anything')).toEqual({ notes: true, prose: true })
    expect(scribeAccess('vibe', 'Anything')).toEqual({ notes: true, prose: true })
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
