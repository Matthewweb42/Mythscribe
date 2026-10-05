import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { BackupState } from '@shared/backups'
import type { TiptapNodeT } from '@shared/tiptap'
import { AppStateStore } from '../appState/appStateStore'
import { saveDocument } from '../document/documentStore'
import { AppError } from '../ipc/errors'
import { ProjectManager } from '../project/manager'
import { projectFolderFor, type ProjectSession } from '../project/projectStore'
import type { Schedule } from '../schedule'
import { listNodes } from '../tree/treeStore'
import { BackupService } from './backupService'

interface Timer {
  run: () => void
  ms: number
  cancelled: boolean
}

let tmp: string
let manager: ProjectManager
let appState: AppStateStore
let service: BackupService
let timers: Timer[]
let pushed: BackupState[]
let clock: number

const schedule: Schedule = (run, ms) => {
  const timer: Timer = { run, ms, cancelled: false }
  timers.push(timer)
  return () => {
    timer.cancelled = true
  }
}

/** The one live timer, or undefined. */
const live = (): Timer | undefined => timers.filter((t) => !t.cancelled).at(-1)

function tick(): void {
  const timer = live()
  if (timer === undefined) throw new Error('no timer armed')
  timer.cancelled = true
  timer.run()
}

const para = (text: string): TiptapNodeT => ({
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text }] }]
})

function write(session: ProjectSession, text: string): void {
  const doc = listNodes(session.connection.orm).find((r) => r.kind === 'document')
  if (!doc) throw new Error('no document')
  saveDocument(session.connection.orm, doc.id, para(text))
}

const count = (): number => service.state().backups.length

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mythscribe-backupsvc-'))
  manager = new ProjectManager()
  appState = new AppStateStore(path.join(tmp, 'userData', 'app-state.json'))
  timers = []
  pushed = []
  // A second per backup, so every file gets its own name.
  clock = new Date(2026, 9, 4, 12, 0, 0).getTime()
  service = new BackupService({
    appState,
    projects: manager,
    defaultFolder: path.join(tmp, 'backups'),
    onChange: (state) => pushed.push(state),
    schedule,
    now: () => new Date((clock += 1000))
  })
  manager.onBeforeClose((session) => service.projectClosing(session))
  manager.onChange((info) => (info ? service.projectOpened() : service.projectClosed()))
})
afterEach(() => {
  service.dispose()
  manager.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('BackupService (F-8.4)', () => {
  it('arms the schedule on open and backs up on a tick only when the project changed', () => {
    manager.create(projectFolderFor(tmp, 'Ridge'), 'Ridge', 'novel')
    expect(live()?.ms).toBe(30 * 60_000)
    // No backup yet: the first tick makes one even though nothing was typed.
    tick()
    expect(count()).toBe(1)
    tick()
    expect(count()).toBe(1)
    write(manager.require(), 'The ridge was empty.')
    tick()
    expect(count()).toBe(2)
    expect(live()).toBeDefined()
    expect(service.state().lastBackupAt).toBe(service.state().backups[0]?.createdAt)
  })

  it('does nothing while switched off, and re-arms when the interval changes', () => {
    manager.create(projectFolderFor(tmp, 'Ridge'), 'Ridge', 'novel')
    service.setSettings({ intervalMinutes: 60 })
    expect(live()?.ms).toBe(60 * 60_000)
    service.setSettings({ enabled: false })
    expect(live()).toBeUndefined()
    write(manager.require(), 'Changed.')
    manager.close()
    expect(fs.existsSync(path.join(tmp, 'backups'))).toBe(false)
  })

  it('backs up on close when changed or never backed up, and not otherwise', () => {
    const folder = projectFolderFor(tmp, 'Ridge')
    manager.create(folder, 'Ridge', 'novel')
    manager.close()
    expect(fs.readdirSync(path.join(tmp, 'backups'))).toHaveLength(1)
    const dir = path.join(tmp, 'backups', fs.readdirSync(path.join(tmp, 'backups'))[0] ?? '')
    expect(fs.readdirSync(dir)).toHaveLength(1)

    manager.open(folder)
    manager.close()
    expect(fs.readdirSync(dir)).toHaveLength(1)

    manager.open(folder)
    write(manager.require(), 'Something new.')
    manager.close()
    expect(fs.readdirSync(dir)).toHaveLength(2)

    service.setSettings({ onClose: false })
    manager.open(folder)
    write(manager.require(), 'More.')
    manager.close()
    expect(fs.readdirSync(dir)).toHaveLength(2)
  })

  it('records a failure, pushes it, and clears it after the next success', () => {
    manager.create(projectFolderFor(tmp, 'Ridge'), 'Ridge', 'novel')
    const blocked = path.join(tmp, 'a-file')
    fs.writeFileSync(blocked, 'not a folder')
    service.setFolder(blocked)
    tick()
    expect(service.state().lastError).not.toBeNull()
    expect(pushed.at(-1)?.lastError).toBe(service.state().lastError)
    expect(live()).toBeDefined()

    service.setSettings({ folder: null })
    expect(service.state().folder).toBe(path.join(tmp, 'backups'))
    tick()
    expect(service.state().lastError).toBeNull()
    expect(count()).toBe(1)
  })

  it('a failed close backup still closes the project', () => {
    manager.create(projectFolderFor(tmp, 'Ridge'), 'Ridge', 'novel')
    const blocked = path.join(tmp, 'a-file')
    fs.writeFileSync(blocked, 'not a folder')
    service.setFolder(blocked)
    manager.close()
    expect(manager.current()).toBeNull()
    expect(service.state().lastError).not.toBeNull()
  })

  it('"Back up now" always backs up, applies retention, and throws with no project', () => {
    expect(() => service.backupNow()).toThrow(AppError)
    manager.create(projectFolderFor(tmp, 'Ridge'), 'Ridge', 'novel')
    service.setSettings({ keep: 5 })
    for (let i = 0; i < 7; i++) service.backupNow()
    const names = service.state().backups.map((b) => b.name)
    expect(names).toHaveLength(5)
    expect(names[0]).toBe('Ridge 2026-10-04 120007.zip')
  })

  it('restores only a listed backup, into a new folder beside the original', () => {
    const folder = projectFolderFor(tmp, 'Ridge')
    manager.create(folder, 'Ridge', 'novel')
    const { backups } = service.backupNow()
    const file = backups[0]?.file ?? ''
    expect(service.listedBackup(file).file).toBe(file)
    expect(() => service.listedBackup(path.join(tmp, 'elsewhere.zip'))).toThrow(AppError)

    const first = service.extractToNewProject(file, tmp)
    expect(path.basename(first)).toMatch(/^Ridge \(restored 2026-10-04 \d{4}\)\.mythscribe$/)
    const second = service.extractToNewProject(file, tmp)
    expect(second).toBe(first.replace(/\)\.mythscribe$/, ') 2.mythscribe'))
    expect(fs.existsSync(path.join(second, 'project.db'))).toBe(true)
  })

  it('stops the timer and pushes nothing after dispose', () => {
    manager.create(projectFolderFor(tmp, 'Ridge'), 'Ridge', 'novel')
    const before = pushed.length
    service.dispose()
    expect(live()).toBeUndefined()
    service.setSettings({ keep: 20 })
    expect(pushed).toHaveLength(before)
  })
})
