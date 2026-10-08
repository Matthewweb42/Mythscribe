import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { openDatabase } from '../db/connection'
import { ProjectManager } from './manager'
import { DB_FILE, createProject, projectFolderFor } from './projectStore'
import { RECOVERY_DIR, stashRecovery } from './recoveryJournal'
import { WORKING_STATE_FILE, WorkingCopy, workingDirFor } from './workingCopy'

let tmp: string
/** A stand-in for `G:\My Drive`: the path alone makes it a Google Drive folder. */
let drive: string
let workingRoot: string
let manager: ProjectManager

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mythscribe-wc-'))
  drive = path.join(tmp, 'My Drive')
  workingRoot = path.join(tmp, 'working')
  fs.mkdirSync(drive)
  manager = new ProjectManager({ workingRoot: () => workingRoot })
})

afterEach(() => {
  vi.restoreAllMocks()
  manager.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

/** Reads the cloud database from its bytes, so the check never touches the folder. */
function cloudName(folder: string): string {
  const db = new Database(fs.readFileSync(path.join(folder, DB_FILE)))
  try {
    return db.prepare<[], { name: string }>('SELECT name FROM project').get()?.name ?? ''
  } finally {
    db.close()
  }
}

function cloudIntegrity(folder: string): string {
  const db = new Database(fs.readFileSync(path.join(folder, DB_FILE)))
  try {
    return String(db.pragma('integrity_check', { simple: true }))
  } finally {
    db.close()
  }
}

function rename(to: string): void {
  manager.require().connection.sqlite.prepare('UPDATE project SET name = ?').run(to)
}

/** Another computer changed the project in the cloud folder (the sync app delivered it). */
function changeInCloud(folder: string, to: string): void {
  const db = new Database(path.join(folder, DB_FILE))
  try {
    db.prepare('UPDATE project SET name = ?').run(to)
  } finally {
    db.close()
  }
  const later = new Date(Date.now() + 60_000)
  fs.utimesSync(path.join(folder, DB_FILE), later, later)
}

function state(folder: string): { dirty: boolean; lastSyncedAt: string | null } {
  const parsed: unknown = JSON.parse(
    fs.readFileSync(path.join(workingDirFor(workingRoot, folder), WORKING_STATE_FILE), 'utf8')
  )
  return parsed as { dirty: boolean; lastSyncedAt: string | null }
}

function siblings(): string[] {
  return fs.readdirSync(drive).sort()
}

describe('working copies of projects in cloud-synced folders', () => {
  it('creates the database on this computer and copies it into the folder', () => {
    const folder = projectFolderFor(drive, 'Book')
    manager.create(folder, 'Book', 'novel')
    const session = manager.require()
    expect(session.workingCopy?.provider).toBe('googleDrive')
    expect(session.connection.sqlite.name).toBe(
      path.join(workingDirFor(workingRoot, folder), DB_FILE)
    )
    expect(cloudName(folder)).toBe('Book')
    expect(fs.existsSync(path.join(folder, `${DB_FILE}-wal`))).toBe(false)
  })

  it('leaves a project in a plain folder exactly as before', () => {
    const folder = projectFolderFor(tmp, 'Plain')
    manager.create(folder, 'Plain', 'novel')
    const session = manager.require()
    expect(session.workingCopy).toBeNull()
    expect(session.connection.sqlite.name).toBe(path.join(folder, DB_FILE))
    expect(session.localFolder).toBe(folder)
    expect(fs.existsSync(workingRoot)).toBe(false)
  })

  it('copies the project back on close and records the copies as agreeing', () => {
    const folder = projectFolderFor(drive, 'Book')
    manager.create(folder, 'Book', 'novel')
    rename('Renamed')
    expect(cloudName(folder)).toBe('Book')
    manager.close()
    expect(cloudName(folder)).toBe('Renamed')
    expect(cloudIntegrity(folder)).toBe('ok')
    expect(state(folder).dirty).toBe(false)
    expect(siblings()).toEqual(['Book.mythscribe'])
  })

  it('copies the project back when another project replaces it', () => {
    const a = projectFolderFor(drive, 'A')
    manager.create(a, 'A', 'novel')
    rename('A2')
    manager.create(projectFolderFor(drive, 'B'), 'B', 'novel')
    expect(cloudName(a)).toBe('A2')
  })

  it('copies the cloud version in on the first open on this computer', () => {
    const folder = projectFolderFor(drive, 'Book')
    createProject(folder, 'Elsewhere', 'novel').close()
    manager.open(folder)
    expect(manager.require().info.name).toBe('Elsewhere')
    expect(manager.require().connection.sqlite.name).toBe(
      path.join(workingDirFor(workingRoot, folder), DB_FILE)
    )
  })

  it('opens a clean working copy as it is when the cloud did not change', () => {
    const folder = projectFolderFor(drive, 'Book')
    manager.create(folder, 'Book', 'novel')
    manager.close()
    const copyFile = vi.spyOn(fs, 'copyFileSync')
    manager.open(folder)
    expect(copyFile).not.toHaveBeenCalled()
    expect(manager.require().info.name).toBe('Book')
  })

  it('takes the cloud version when it changed and this computer had nothing new', () => {
    const folder = projectFolderFor(drive, 'Book')
    manager.create(folder, 'Book', 'novel')
    manager.close()
    changeInCloud(folder, 'Edited elsewhere')
    manager.open(folder)
    expect(manager.require().info.name).toBe('Edited elsewhere')
    expect(siblings()).toEqual(['Book.mythscribe'])
  })

  it('treats a changed modification time with the same bytes as no change', () => {
    const folder = projectFolderFor(drive, 'Book')
    manager.create(folder, 'Book', 'novel')
    manager.close()
    const later = new Date(Date.now() + 120_000)
    fs.utimesSync(path.join(folder, DB_FILE), later, later)
    const copyFile = vi.spyOn(fs, 'copyFileSync')
    manager.open(folder)
    expect(copyFile).not.toHaveBeenCalled()
  })

  it('opens a working copy left ahead of the cloud and copies it back at once', () => {
    const folder = projectFolderFor(drive, 'Book')
    manager.create(folder, 'Book', 'novel')
    rename('Unsynced')
    const failing = vi.spyOn(WorkingCopy.prototype, 'syncNow').mockImplementation(() => {
      throw new Error('Drive is offline')
    })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    manager.close()
    expect(warn).toHaveBeenCalled()
    expect(cloudName(folder)).toBe('Book')
    expect(state(folder).dirty).toBe(true)
    failing.mockRestore()

    manager.open(folder)
    const session = manager.require()
    expect(session.info.name).toBe('Unsynced')
    expect(session.workingCopy?.hasChanges(session.connection.sqlite)).toBe(true)
    expect(siblings()).toEqual(['Book.mythscribe'])
    session.workingCopy?.syncNow(session.connection.sqlite)
    expect(cloudName(folder)).toBe('Unsynced')
  })

  it('keeps both when this computer and the cloud both changed', () => {
    const now = new Date(2026, 9, 8, 14, 5)
    vi.useFakeTimers({ now, toFake: ['Date'] })
    try {
      const folder = projectFolderFor(drive, 'Book')
      manager.create(folder, 'Book', 'novel')
      rename('Mine')
      vi.spyOn(WorkingCopy.prototype, 'syncNow').mockImplementationOnce(() => {
        throw new Error('Drive is offline')
      })
      vi.spyOn(console, 'warn').mockImplementation(() => {})
      manager.close()
      changeInCloud(folder, 'Theirs')

      manager.open(folder)
      const conflict = path.join(drive, 'Book (conflict 2026-10-08 1405).mythscribe')
      expect(manager.require().info.name).toBe('Mine')
      expect(manager.require().workingCopy?.conflictCopy).toBe(conflict)
      expect(cloudName(conflict)).toBe('Theirs')
      expect(fs.existsSync(path.join(conflict, '.mythscribe-open'))).toBe(false)
      manager.close()
      expect(cloudName(folder)).toBe('Mine')
      // The copy back replaced what was kept without keeping it a second time.
      expect(siblings()).toEqual(['Book (conflict 2026-10-08 1405).mythscribe', 'Book.mythscribe'])
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps the cloud version beside it when it changed while the project was open', () => {
    const folder = projectFolderFor(drive, 'Book')
    manager.create(folder, 'Book', 'novel')
    rename('Mine')
    changeInCloud(folder, 'Theirs')
    const session = manager.require()
    session.workingCopy?.syncNow(session.connection.sqlite)
    const kept = session.workingCopy?.conflictCopy ?? ''
    expect(kept).toMatch(/Book \(conflict .+\)\.mythscribe$/)
    expect(cloudName(kept)).toBe('Theirs')
    expect(cloudName(folder)).toBe('Mine')
  })

  it('never overwrites the cloud copy when the conflict copy cannot be kept', () => {
    const folder = projectFolderFor(drive, 'Book')
    manager.create(folder, 'Book', 'novel')
    rename('Mine')
    changeInCloud(folder, 'Theirs')
    vi.spyOn(fs, 'cpSync').mockImplementation(() => {
      throw new Error('quota exceeded')
    })
    const session = manager.require()
    expect(() => session.workingCopy?.syncNow(session.connection.sqlite)).toThrowError(
      /quota exceeded/
    )
    expect(cloudName(folder)).toBe('Theirs')
  })

  it('keeps the old cloud database when the copy back fails, and removes its temp file', () => {
    const folder = projectFolderFor(drive, 'Book')
    manager.create(folder, 'Book', 'novel')
    rename('Mine')
    const real = fs.renameSync
    vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      if (String(to) === path.join(folder, DB_FILE)) throw new Error('EBUSY: resource busy')
      real(from, to)
    })
    const session = manager.require()
    expect(() => session.workingCopy?.syncNow(session.connection.sqlite)).toThrowError(
      /Could not copy the project to Google Drive: EBUSY/
    )
    expect(cloudName(folder)).toBe('Book')
    expect(fs.readdirSync(folder).filter((f) => f.endsWith('.tmp'))).toEqual([])
    expect(session.workingCopy?.hasChanges(session.connection.sqlite)).toBe(true)
  })

  it('never lets a slower copy land over a newer one', async () => {
    const folder = projectFolderFor(drive, 'Book')
    manager.create(folder, 'Book', 'novel')
    const session = manager.require()
    const copy = session.workingCopy
    if (!copy) throw new Error('expected a working copy')
    rename('Older')
    const slow = copy.sync(session.connection.sqlite)
    rename('Newer')
    copy.syncNow(session.connection.sqlite)
    await expect(slow).resolves.toBe(false)
    expect(cloudName(folder)).toBe('Newer')
  })

  it('copies in a cloud database with a -wal an older version left behind', () => {
    const folder = projectFolderFor(drive, 'Book')
    const source = projectFolderFor(tmp, 'Source')
    createProject(source, 'Book', 'novel').close()
    const live = openDatabase(path.join(source, DB_FILE))
    live.sqlite.pragma('wal_autocheckpoint = 0')
    live.sqlite.prepare('UPDATE project SET name = ?').run('In the WAL')
    fs.mkdirSync(folder)
    fs.copyFileSync(path.join(source, DB_FILE), path.join(folder, DB_FILE))
    fs.copyFileSync(path.join(source, `${DB_FILE}-wal`), path.join(folder, `${DB_FILE}-wal`))
    live.close()

    manager.open(folder)
    expect(manager.require().info.name).toBe('In the WAL')
    manager.close()
    expect(fs.existsSync(path.join(folder, `${DB_FILE}-wal`))).toBe(false)
    expect(cloudName(folder)).toBe('In the WAL')
    expect(siblings()).toEqual(['Book.mythscribe'])
  })

  it('removes temp files a crashed copy left in the folder', () => {
    const folder = projectFolderFor(drive, 'Book')
    manager.create(folder, 'Book', 'novel')
    manager.close()
    const leftover = path.join(folder, `${DB_FILE}.sync-0f0e-1234.tmp`)
    fs.writeFileSync(leftover, 'half')
    manager.open(folder)
    expect(fs.existsSync(leftover)).toBe(false)
  })

  it('keeps the crash journal with the working copy and moves an old one over', () => {
    const folder = projectFolderFor(drive, 'Book')
    manager.create(folder, 'Book', 'novel')
    manager.close()
    stashRecovery(folder, 'document', 'n1', { type: 'doc', content: [] })
    manager.open(folder)
    const session = manager.require()
    expect(session.localFolder).toBe(workingDirFor(workingRoot, folder))
    expect(fs.existsSync(path.join(session.localFolder, RECOVERY_DIR, 'document-n1.json'))).toBe(
      true
    )
    expect(fs.existsSync(path.join(folder, RECOVERY_DIR))).toBe(false)
  })

  it('undoes a create whose first copy into the folder fails', () => {
    const folder = projectFolderFor(drive, 'Book')
    vi.spyOn(WorkingCopy.prototype, 'syncNow').mockImplementation(() => {
      throw new Error('Drive is offline')
    })
    expect(() => manager.create(folder, 'Book', 'novel')).toThrowError(/offline/)
    expect(fs.existsSync(folder)).toBe(false)
    expect(fs.existsSync(workingDirFor(workingRoot, folder))).toBe(false)
  })

  it('moves an old working copy aside, never deleting it, when a project is created there again', () => {
    const folder = projectFolderFor(drive, 'Book')
    manager.create(folder, 'Book', 'novel')
    manager.close()
    fs.rmSync(folder, { recursive: true })
    manager.create(folder, 'Book', 'novel')
    const dir = workingDirFor(workingRoot, folder)
    const aside = fs
      .readdirSync(workingRoot)
      .filter((name) => name.startsWith(`${path.basename(dir)}.orphaned-`))
    expect(aside).toHaveLength(1)
  })
})
