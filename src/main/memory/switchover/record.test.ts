import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { SwitchoverRecord } from '@shared/memory/switchover'
import { createProject, projectFolderFor, type ProjectSession } from '../../project/projectStore'
import { getSwitchoverRecord, markRebuildStarted, setSwitchoverRecord } from './record'

let tmp: string
let session: ProjectSession

const SWITCHED = '2026-10-14T09:00:00.000Z'
const RECORD: SwitchoverRecord = {
  switchedAt: SWITCHED,
  trial: false,
  backup: '/backups/Book before story memory 2026-10-14 090000.zip',
  datedCopy: '/My Drive/Book (before story memory 2026-10-14 0900).mythscribe',
  rebuild: 'waiting',
  rebuildStartedAt: null
}

const db = (): ProjectSession['connection']['orm'] => session.connection.orm
const writeRaw = (value: string): void => {
  session.connection.sqlite
    .prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)')
    .run('switchover', value)
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mythscribe-switchover-record-'))
  session = createProject(projectFolderFor(tmp, 'Book'), 'Book', 'novel')
})
afterEach(() => {
  session.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('the switch-over record (F-16.31, decision SW-D7)', () => {
  it('reads none on a project never switched, and what was written otherwise', () => {
    expect(getSwitchoverRecord(db())).toBeNull()
    expect(setSwitchoverRecord(db(), RECORD)).toEqual(RECORD)
    expect(getSwitchoverRecord(db())).toEqual(RECORD)
  })

  it('reads a broken or misshapen row as none, and never writes a misshapen one', () => {
    writeRaw('{"switchedAt": 3')
    expect(getSwitchoverRecord(db())).toBeNull()
    writeRaw(JSON.stringify({ ...RECORD, rebuild: 'later' }))
    expect(getSwitchoverRecord(db())).toBeNull()
    writeRaw('null')
    expect(getSwitchoverRecord(db())).toBeNull()
    expect(() => setSwitchoverRecord(db(), { ...RECORD, rebuild: 'later' as 'waiting' })).toThrow()
    expect(getSwitchoverRecord(db())).toBeNull()
  })

  it('marks the first rebuild once, with when; a second start keeps the first', () => {
    setSwitchoverRecord(db(), RECORD)
    const first = new Date('2026-10-14T10:00:00.000Z')
    expect(markRebuildStarted(db(), first)).toEqual({
      ...RECORD,
      rebuild: 'started',
      rebuildStartedAt: first.toISOString()
    })
    expect(markRebuildStarted(db(), new Date('2026-10-15T10:00:00.000Z'))?.rebuildStartedAt).toBe(
      first.toISOString()
    )
    expect(getSwitchoverRecord(db())).toMatchObject({
      rebuild: 'started',
      rebuildStartedAt: first.toISOString()
    })
  })

  it('marks nothing and writes nothing without a record, or with a broken one', () => {
    expect(markRebuildStarted(db(), new Date())).toBeNull()
    expect(
      session.connection.sqlite
        .prepare("SELECT count(*) AS n FROM settings WHERE key = 'switchover'")
        .get()
    ).toEqual({ n: 0 })
    writeRaw('{"switchedAt": 3')
    expect(markRebuildStarted(db(), new Date())).toBeNull()
    expect(
      session.connection.sqlite.prepare("SELECT value FROM settings WHERE key = 'switchover'").get()
    ).toEqual({ value: '{"switchedAt": 3' })
  })
})
