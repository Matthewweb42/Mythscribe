import { describe, expect, it } from 'vitest'
import {
  EDITOR_SETTINGS_KEY,
  EditorSettings,
  SCENE_BREAK_PRESETS,
  defaultEditorSettings
} from './editorSettings'

describe('defaultEditorSettings', () => {
  it('uses manuscript style for novel and epic', () => {
    const expected = {
      fontSize: 16,
      lineHeight: 2,
      paragraphSpacing: 0,
      paragraphIndent: 1.5,
      maxWidth: 700,
      sceneBreak: '* * *',
      typewriter: false
    }
    expect(defaultEditorSettings('novel')).toEqual(expected)
    expect(defaultEditorSettings('epic')).toEqual(expected)
  })

  it('uses web style for webnovel', () => {
    expect(defaultEditorSettings('webnovel')).toEqual({
      fontSize: 16,
      lineHeight: 1.6,
      paragraphSpacing: 1,
      paragraphIndent: 0,
      maxWidth: 700,
      sceneBreak: '~~~',
      typewriter: false
    })
  })

  it.each(['novel', 'epic', 'webnovel'] as const)('%s defaults pass the schema', (format) => {
    const defaults = defaultEditorSettings(format)
    expect(EditorSettings.parse(defaults)).toEqual(defaults)
    expect(SCENE_BREAK_PRESETS).toContain(defaults.sceneBreak)
  })
})

describe('EditorSettings schema', () => {
  const valid = defaultEditorSettings('novel')

  it('rejects an out-of-range font size', () => {
    expect(EditorSettings.safeParse({ ...valid, fontSize: 11 }).success).toBe(false)
    expect(EditorSettings.safeParse({ ...valid, fontSize: 25 }).success).toBe(false)
  })

  it('rejects an empty scene break', () => {
    expect(EditorSettings.safeParse({ ...valid, sceneBreak: '' }).success).toBe(false)
    expect(EditorSettings.safeParse({ ...valid, sceneBreak: '   ' }).success).toBe(false)
  })

  it('stores under a stable settings key', () => {
    expect(EDITOR_SETTINGS_KEY).toBe('editor')
  })

  it('reads a row stored before F-3.9 with typewriter scrolling off', () => {
    const stored = { ...defaultEditorSettings('novel') } as Record<string, unknown>
    delete stored.typewriter
    expect(EditorSettings.parse(stored)).toEqual(defaultEditorSettings('novel'))
    expect(EditorSettings.parse({ ...stored, typewriter: true }).typewriter).toBe(true)
  })
})
