import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { EDITOR_SETTINGS_KEY, defaultEditorSettings } from '@shared/editorSettings'
import type { NovelFormat } from '@shared/ipc/contract'
import { settings } from '../db/schema'
import type { TreeDb } from '../tree/treeStore'
import { createProject, projectFolderFor, type ProjectSession } from './projectStore'
import { getEditorSettings, setEditorSettings } from './settingsStore'

let tmp: string
let session: ProjectSession
let db: TreeDb

function open(format: NovelFormat): void {
  session = createProject(projectFolderFor(tmp, format), format, format)
  db = session.connection.orm
}

function setRaw(value: string): void {
  db.update(settings).set({ value }).where(eq(settings.key, EDITOR_SETTINGS_KEY)).run()
}

function rows(): { key: string; value: string }[] {
  return db.select().from(settings).where(eq(settings.key, EDITOR_SETTINGS_KEY)).all()
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
