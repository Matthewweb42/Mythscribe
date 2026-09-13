import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AI_SETTINGS_KEY, defaultAiSettings } from '@shared/aiSettings'
import { EDITOR_SETTINGS_KEY, defaultEditorSettings } from '@shared/editorSettings'
import type { NovelFormat } from '@shared/ipc/contract'
import { WRITING_PRESETS_KEY, builtinParams, defaultWritingPresets } from '@shared/presets'
import { settings } from '../db/schema'
import type { TreeDb } from '../tree/treeStore'
import { createProject, projectFolderFor, type ProjectSession } from './projectStore'
import {
  getAiSettings,
  getEditorSettings,
  getWritingPresets,
  setAiSettings,
  setEditorSettings,
  setWritingPresets
} from './settingsStore'

let tmp: string
let session: ProjectSession
let db: TreeDb

function open(format: NovelFormat): void {
  session = createProject(projectFolderFor(tmp, format), format, format)
  db = session.connection.orm
}

function setRaw(value: string, key: string = EDITOR_SETTINGS_KEY): void {
  db.insert(settings)
    .values({ key, value })
    .onConflictDoUpdate({ target: settings.key, set: { value } })
    .run()
}

function rows(key: string = EDITOR_SETTINGS_KEY): { key: string; value: string }[] {
  return db.select().from(settings).where(eq(settings.key, key)).all()
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mythscribe-settings-'))
})
afterEach(() => {
  session.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('getEditorSettings', () => {
  it('reads the defaults that seedSettings wrote for each format', () => {
    open('webnovel')
    expect(getEditorSettings(db, 'webnovel')).toEqual(defaultEditorSettings('webnovel'))
    expect(getEditorSettings(db, 'webnovel').sceneBreak).toBe('~~~')
    session.close()
    open('novel')
    expect(getEditorSettings(db, 'novel')).toEqual(defaultEditorSettings('novel'))
    expect(getEditorSettings(db, 'novel').paragraphIndent).toBe(1.5)
  })

  it('falls back to the format defaults when the row is missing', () => {
    open('epic')
    db.delete(settings).where(eq(settings.key, EDITOR_SETTINGS_KEY)).run()
    expect(getEditorSettings(db, 'epic')).toEqual(defaultEditorSettings('epic'))
    expect(getEditorSettings(db, 'webnovel')).toEqual(defaultEditorSettings('webnovel'))
  })

  it('falls back when the stored value is not JSON', () => {
    open('novel')
    setRaw('{not json')
    expect(getEditorSettings(db, 'novel')).toEqual(defaultEditorSettings('novel'))
  })

  it('falls back when the stored JSON no longer fits the schema', () => {
    open('webnovel')
    setRaw(JSON.stringify({ fontSize: 99, sceneBreak: '' }))
    expect(getEditorSettings(db, 'webnovel')).toEqual(defaultEditorSettings('webnovel'))
  })
})

describe('setEditorSettings', () => {
  it('round-trips a full value', () => {
    open('novel')
    const next = { ...defaultEditorSettings('novel'), fontSize: 20, sceneBreak: '###' }
    expect(setEditorSettings(db, next)).toEqual(next)
    expect(getEditorSettings(db, 'novel')).toEqual(next)
  })

  it('overwrites the single row instead of adding another', () => {
    open('novel')
    setEditorSettings(db, { ...defaultEditorSettings('novel'), maxWidth: 800 })
    setEditorSettings(db, { ...defaultEditorSettings('novel'), maxWidth: 900 })
    expect(rows()).toHaveLength(1)
    expect(getEditorSettings(db, 'novel').maxWidth).toBe(900)
  })

  it('writes the row again after it was deleted', () => {
    open('novel')
    db.delete(settings).where(eq(settings.key, EDITOR_SETTINGS_KEY)).run()
    setEditorSettings(db, { ...defaultEditorSettings('novel'), lineHeight: 1.2 })
    expect(rows()).toHaveLength(1)
    expect(getEditorSettings(db, 'novel').lineHeight).toBe(1.2)
  })

  it('refuses an out-of-range value', () => {
    open('novel')
    expect(() =>
      setEditorSettings(db, { ...defaultEditorSettings('novel'), fontSize: 40 })
    ).toThrow()
    expect(getEditorSettings(db, 'novel')).toEqual(defaultEditorSettings('novel'))
  })
})

describe('getAiSettings / setAiSettings (F-14.4)', () => {
  it('answers the defaults (dial Off, every toggle on) for a new project, which seeds no row', () => {
    open('novel')
    expect(rows(AI_SETTINGS_KEY)).toHaveLength(0)
    expect(getAiSettings(db)).toEqual(defaultAiSettings())
  })

  it('round-trips a value and overwrites the single row', () => {
    open('epic')
    const next = {
      ...defaultAiSettings(),
      dial: 2 as const,
      features: { ...defaultAiSettings().features, ghostText: false }
    }
    expect(setAiSettings(db, next)).toEqual(next)
    expect(getAiSettings(db)).toEqual(next)
    setAiSettings(db, { ...next, dial: 3 })
    expect(rows(AI_SETTINGS_KEY)).toHaveLength(1)
    expect(getAiSettings(db).dial).toBe(3)
  })

  it('falls back when the stored value is not JSON', () => {
    open('novel')
    setRaw('{not json', AI_SETTINGS_KEY)
    expect(getAiSettings(db)).toEqual(defaultAiSettings())
  })

  it('falls back when the stored JSON no longer fits the schema, so a bad row never turns AI on', () => {
    open('novel')
    setRaw(JSON.stringify({ dial: 9, features: defaultAiSettings().features }), AI_SETTINGS_KEY)
    expect(getAiSettings(db)).toEqual(defaultAiSettings())
    setRaw(JSON.stringify({ dial: 3, features: { ghostText: true } }), AI_SETTINGS_KEY)
    expect(getAiSettings(db)).toEqual(defaultAiSettings())
  })
})

describe('getWritingPresets / setWritingPresets (F-5.2)', () => {
  it('answers the defaults (General active, Custom a copy of General) for a new project, which seeds no row', () => {
    open('novel')
    expect(rows(WRITING_PRESETS_KEY)).toHaveLength(0)
    expect(getWritingPresets(db)).toEqual(defaultWritingPresets())
  })

  it('round-trips a value and overwrites the single row', () => {
    open('epic')
    const next = {
      active: 'custom' as const,
      custom: { ...builtinParams('action'), styleInstruction: 'Be terse.', temperature: 1.2 }
    }
    expect(setWritingPresets(db, next)).toEqual(next)
    expect(getWritingPresets(db)).toEqual(next)
    setWritingPresets(db, { ...next, active: 'suspense' })
    expect(rows(WRITING_PRESETS_KEY)).toHaveLength(1)
    expect(getWritingPresets(db).active).toBe('suspense')
  })

  it('refuses an out-of-range value and keeps the stored one', () => {
    open('novel')
    const defaults = defaultWritingPresets()
    expect(() =>
      setWritingPresets(db, { ...defaults, custom: { ...defaults.custom, temperature: 4 } })
    ).toThrow()
    expect(getWritingPresets(db)).toEqual(defaults)
  })

  it('falls back when the stored value is not JSON', () => {
    open('novel')
    setRaw('{not json', WRITING_PRESETS_KEY)
    expect(getWritingPresets(db)).toEqual(defaultWritingPresets())
  })

  it('falls back when the stored JSON no longer fits the schema', () => {
    open('novel')
    setRaw(
      JSON.stringify({ active: 'horror', custom: builtinParams('general') }),
      WRITING_PRESETS_KEY
    )
    expect(getWritingPresets(db)).toEqual(defaultWritingPresets())
    setRaw(
      JSON.stringify({
        active: 'custom',
        custom: { ...builtinParams('general'), maxSuggestionTokens: 500 }
      }),
      WRITING_PRESETS_KEY
    )
    expect(getWritingPresets(db)).toEqual(defaultWritingPresets())
  })
})
