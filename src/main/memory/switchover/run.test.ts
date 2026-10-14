import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { isKeptBackupName } from '@shared/backups'
import {
  SWITCHOVER_NOTHING_CHANGED,
  SWITCHOVER_RECORD_KEY,
  type SwitchoverConsent,
  type SwitchoverOutcome,
  type SwitchoverStep
} from '@shared/memory/switchover'
import type { TiptapNodeT } from '@shared/tiptap'
import { AppStateStore } from '../../appState/appStateStore'
import { BackupService } from '../../backups/backupService'
import { rollbackSnapshot } from '../../db/snapshot'
import { saveDocument } from '../../document/documentStore'
import { ProjectManager } from '../../project/manager'
import { getStoryMemory, setStoryMemory } from '../../project/settingsStore'
import { WorkingCopy } from '../../project/workingCopy'
import type { Schedule } from '../../schedule'
import { buildFixtureV1, type FixtureV1 } from './fixtureV1'
import { inlineTagReplacements, planSwitchover } from './plan'
import { getSwitchoverRecord } from './record'
import {
  causeOf,
  projectDigest,
  runConvert,
  SwitchoverRun,
  switchoverSafety,
  type SafetyMemo,
  type SwitchoverRunDeps
} from './run'
import { createTrialCopy, switchoverTrialOf } from './trial'

/**
 * The in-place run (F-16.31 part A, plan `Switchover.md` §1.5): the v1 fixture in a temporary
 * "My Drive" folder, opened through a ProjectManager that sees Google Drive, so the project works
 * on a local working copy and is copied back to Drive, as the author's is.
 */

let tmp: string
let drive: string
let folder: string
let fixture: FixtureV1
let manager: ProjectManager
let backups: BackupService
let calls: string[]
/** What the run asked of v1's background writers (`hold`, `release`). */
let holds: string[]
let clock: number

const CONTEXT = { source: 'ownKey' as const, fastModel: 'm', strongModel: 'm', pricing: null }
const noSchedule: Schedule = () => () => undefined
const inDrive = (target: string): boolean =>
  path.resolve(target).startsWith(`${path.resolve(drive)}${path.sep}`)

beforeEach(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mythscribe-switchover-run-'))
  drive = path.join(tmp, 'My Drive')
  fs.mkdirSync(drive)
  folder = path.join(drive, 'Harbour Book.mythscribe')
  fixture = await buildFixtureV1(folder)
  fixture.session.close()
  clock = new Date(2026, 9, 14, 9, 0, 0).getTime()
  manager = new ProjectManager({
    workingRoot: () => path.join(tmp, 'working'),
    detectCloud: (target) => (inDrive(target) ? 'googleDrive' : null)
  })
  backups = new BackupService({
    appState: new AppStateStore(path.join(tmp, 'userData', 'app-state.json')),
    projects: manager,
    defaultFolder: path.join(tmp, 'backups'),
    onChange: () => undefined,
    schedule: noSchedule,
    now: () => new Date((clock += 1000))
  })
  manager.onBeforeClose((session) => backups.projectClosing(session))
  manager.onChange((info) => (info ? backups.projectOpened() : backups.projectClosed()))
  manager.open(folder)
  calls = []
  holds = []
  const realSync = WorkingCopy.prototype.syncNow
  vi.spyOn(WorkingCopy.prototype, 'syncNow').mockImplementation(function (
    this: WorkingCopy,
    sqlite: Database.Database
  ) {
    calls.push('flush')
    realSync.call(this, sqlite)
  })
})

afterEach(() => {
  vi.restoreAllMocks()
  manager.close()
  backups.dispose()
  fs.rmSync(tmp, { recursive: true, force: true })
})

function deps(overrides: Partial<SwitchoverRunDeps> = {}): SwitchoverRunDeps {
  return {
    session: () => manager.require(),
    backupNow: (options) => {
      calls.push('backup')
      return backups.backupNow(options).file
    },
    current: () => manager.current(),
    close: () => manager.close(),
    now: () => new Date((clock += 60_000)),
    hold: () => {
      holds.push('hold')
      return Promise.resolve()
    },
    release: () => void holds.push('release'),
    ...overrides
  }
}

const db = (): ReturnType<ProjectManager['require']>['connection']['orm'] =>
  manager.require().connection.orm
const sqlite = (): Database.Database => manager.require().connection.sqlite
const projectId = (): string => manager.require().info.id

function consent(): SwitchoverConsent {
  return {
    replacements: inlineTagReplacements(db()).map((row) => ({
      key: row.key,
      text: row.replacement
    })),
    merges: []
  }
}

/** A memo the safety step answered whole: its dated copy made. */
type Safe = SafetyMemo & { datedCopy: string }

/** The safety step as the dialog runs it, answering the memo (it must succeed). */
function safety(memo: SafetyMemo | null = null, given: SwitchoverRunDeps = deps()): Safe {
  const { outcome, memo: next } = switchoverSafety(given, memo)
  if (!outcome.ok || next?.datedCopy == null) {
    throw new Error(`safety failed: ${JSON.stringify(outcome)}`)
  }
  expect(outcome).toEqual({ ok: true, backup: next.backup, datedCopy: next.datedCopy })
  return { ...next, datedCopy: next.datedCopy }
}

/** What is in the "My Drive" folder besides the project itself. */
const driveCopies = (): string[] =>
  fs.readdirSync(drive).filter((name) => name !== 'Harbour Book.mythscribe')

const keptBackups = (): string[] => {
  const dir = backups.dirForProject(manager.current() ?? { id: '', name: '' })
  return fs.existsSync(dir) ? fs.readdirSync(dir).filter(isKeptBackupName) : []
}

/** A database file read from its bytes (a rollback-journal copy), so nothing on disk is touched. */
function readDb(file: string): Database.Database {
  const bytes = fs.readFileSync(file)
  bytes[18] = 1
  bytes[19] = 1
  return new Database(bytes)
}

function settingOf(file: string, key: string): unknown {
  const handle = readDb(file)
  try {
    const row = handle
      .prepare<[string], { value: string }>('SELECT value FROM settings WHERE key = ?')
      .get(key)
    return row === undefined ? undefined : JSON.parse(row.value)
  } finally {
    handle.close()
  }
}

function sceneOf(file: string, index: number): string {
  const handle = readDb(file)
  try {
    return (
      handle
        .prepare<[string], { content: string }>('SELECT content FROM node WHERE id = ?')
        .get(fixture.scenes[index] ?? '')?.content ?? ''
    )
  } finally {
    handle.close()
  }
}

const sceneOneOf = (file: string): string => sceneOf(file, 0)

const para = (text: string): TiptapNodeT => ({
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text }] }]
})

function expectFailure(outcome: SwitchoverOutcome, step: SwitchoverStep): string {
  expect(outcome.ok).toBe(false)
  if (outcome.ok) throw new Error('expected a failure')
  expect(outcome.step).toBe(step)
  expect(outcome.message.endsWith(SWITCHOVER_NOTHING_CHANGED)).toBe(true)
  expect(outcome.nextStep.length).toBeGreaterThan(0)
  return `${outcome.message} | ${outcome.nextStep}`
}

describe('the switch-over of the project itself (F-16.31 part A)', () => {
  it('flushes Drive, keeps a backup and a dated copy in Drive, converts, records it and closes', async () => {
    expect(manager.require().workingCopy?.provider).toBe('googleDrive')
    const memo = safety()
    expect(calls).toEqual(['flush', 'backup'])
    // The dated copy: a v1 project beside the Drive folder, the inline tags still there.
    expect(path.dirname(memo.datedCopy)).toBe(drive)
    expect(path.basename(memo.datedCopy)).toMatch(
      /^Harbour Book \(before story memory \d{4}-\d\d-\d\d \d{4}\)\.mythscribe$/
    )
    expect(settingOf(path.join(memo.datedCopy, 'project.db'), 'storyMemory')).toBeUndefined()
    expect(sceneOneOf(path.join(memo.datedCopy, 'project.db'))).toContain('inlineTag')
    // The kept backup, in the project's backups folder, and listed as kept.
    expect(fs.existsSync(memo.backup)).toBe(true)
    expect(keptBackups()).toEqual([path.basename(memo.backup)])
    expect(backups.state().backups.find((entry) => entry.file === memo.backup)?.kept).toBe(true)
    // A second safety call answers what the first made.
    expect(switchoverSafety(deps(), memo).outcome).toEqual({
      ok: true,
      backup: memo.backup,
      datedCopy: memo.datedCopy
    })
    expect(driveCopies()).toEqual([path.basename(memo.datedCopy)])

    // The dry run and the consent read only: nothing to back up again at Convert.
    planSwitchover(db(), CONTEXT)
    const given = consent()
    calls = []
    const { outcome } = await runConvert(deps(), { consent: given, projectId: projectId() }, memo)
    expect(outcome).toMatchObject({
      ok: true,
      folder,
      trial: false,
      backup: memo.backup,
      datedCopy: memo.datedCopy
    })
    // No second backup; the one copy back is the close's.
    expect(calls).toEqual(['flush'])
    expect(manager.current()).toBeNull()
    // Google Drive holds the converted database.
    const driveDb = path.join(folder, 'project.db')
    expect(settingOf(driveDb, 'storyMemory')).toMatchObject({ version: 'v2' })
    expect(settingOf(driveDb, SWITCHOVER_RECORD_KEY)).toMatchObject({
      trial: false,
      backup: memo.backup,
      datedCopy: memo.datedCopy,
      rebuild: 'waiting',
      rebuildStartedAt: null
    })
    expect(sceneOneOf(driveDb)).not.toContain('inlineTag')
    expect(sceneOneOf(driveDb)).toContain('with Tomas at dusk')
    // It opens again on v2, with the record.
    expect(manager.open(folder).storyMemory).toBe('v2')
    expect(getSwitchoverRecord(db())?.rebuild).toBe('waiting')
  })

  it('backs up and copies again at Convert when the project changed after the safety step', async () => {
    const memo = safety()
    saveDocument(db(), fixture.scenes[1] ?? '', para('Ilse counted the bells twice.'))
    calls = []
    const { outcome } = await runConvert(
      deps(),
      { consent: consent(), projectId: projectId() },
      memo
    )
    expect(calls).toEqual(['flush', 'backup', 'flush'])
    if (!outcome.ok) throw new Error(outcome.message)
    expect(outcome.backup).not.toBe(memo.backup)
    // The dated copy named as the way back holds the later edit too.
    expect(outcome.datedCopy).not.toBe(memo.datedCopy)
    expect(sceneOf(path.join(outcome.datedCopy ?? '', 'project.db'), 1)).toContain(
      'Ilse counted the bells twice.'
    )
    expect(sceneOf(path.join(memo.datedCopy, 'project.db'), 1)).not.toContain('twice')
    expect(driveCopies().sort()).toEqual(
      [path.basename(memo.datedCopy), path.basename(outcome.datedCopy ?? '')].sort()
    )
    manager.open(folder)
    expect(keptBackups().sort()).toEqual(
      [path.basename(memo.backup), path.basename(outcome.backup ?? '')].sort()
    )
    expect(getSwitchoverRecord(db())).toMatchObject({
      backup: outcome.backup,
      datedCopy: outcome.datedCopy
    })
  })

  it('makes nothing again at Convert when only the derived indexes were written since (slice 3)', async () => {
    const memo = safety()
    const before = projectDigest(sqlite())
    // A mention scan and a search-index row landing a second after the last save: the app's own
    // indexes, rebuilt from the text, so the copies made a moment ago still hold the project.
    const scene = fixture.scenes[0] ?? ''
    sqlite()
      .prepare(
        'INSERT OR REPLACE INTO mention_scan (node_id, content_hash, scanned_at) VALUES (?, ?, ?)'
      )
      .run(scene, 'hash-after', '2026-10-14T10:00:00.000Z')
    sqlite()
      .prepare('INSERT INTO passage_fts (node_id, para, text) VALUES (?, ?, ?)')
      .run(scene, 0, 'a search index row')
    expect(projectDigest(sqlite())).toBe(before)
    calls = []
    expect(safety(memo)).toMatchObject({ backup: memo.backup, datedCopy: memo.datedCopy })
    expect(calls).toEqual([])
    const { outcome } = await runConvert(
      deps(),
      { consent: consent(), projectId: projectId() },
      memo
    )
    if (!outcome.ok) throw new Error(outcome.message)
    // No second backup or dated copy; the one copy back is the close's.
    expect(calls).toEqual(['flush'])
    expect(outcome).toMatchObject({ backup: memo.backup, datedCopy: memo.datedCopy })
    expect(driveCopies()).toEqual([path.basename(memo.datedCopy)])
  })

  it('counts a write to anything but the derived indexes as a change (slice 3)', () => {
    const before = projectDigest(sqlite())
    sqlite()
      .prepare('INSERT INTO settings (key, value) VALUES (?, ?)')
      .run('slice3-probe', JSON.stringify(true))
    expect(projectDigest(sqlite())).not.toBe(before)
  })

  it('makes everything again when the safety step runs after the project changed', () => {
    const first = safety()
    // The author left the flow, wrote on, and started it again in the same session.
    saveDocument(db(), fixture.scenes[1] ?? '', para('Ilse rang the bell at noon.'))
    calls = []
    const second = safety(first)
    expect(calls).toEqual(['flush', 'backup'])
    expect(second.backup).not.toBe(first.backup)
    expect(second.datedCopy).not.toBe(first.datedCopy)
    expect(sceneOf(path.join(second.datedCopy, 'project.db'), 1)).toContain('rang the bell')
    // Nothing written since: the same copies, nothing made.
    calls = []
    expect(safety(second)).toEqual(second)
    expect(calls).toEqual([])
  })

  it('a write that lands while the originals are read is backed up and copied before the conversion', async () => {
    const memo = safety()
    calls = []
    const late = deps({
      current: () => {
        // An autosave or a v1 job's result arriving during `prepareSwitchover`'s await.
        saveDocument(db(), fixture.scenes[1] ?? '', para('A late autosave.'))
        return manager.current()
      }
    })
    const { outcome } = await runConvert(late, { consent: consent(), projectId: projectId() }, memo)
    if (!outcome.ok) throw new Error(outcome.message)
    expect(calls).toEqual(['flush', 'backup', 'flush'])
    expect(outcome.backup).not.toBe(memo.backup)
    expect(sceneOf(path.join(outcome.datedCopy ?? '', 'project.db'), 1)).toContain(
      'A late autosave.'
    )
  })

  it('forgets the memo when the project is opened again, even the same folder', async () => {
    const memo = safety()
    manager.close()
    manager.open(folder)
    await expect(
      runConvert(deps(), { consent: consent(), projectId: projectId() }, memo)
    ).rejects.toThrow('Make the backup and the dated copy first.')
    calls = []
    const again = safety(memo)
    expect(calls).toEqual(['flush', 'backup'])
    expect(again.datedCopy).not.toBe(memo.datedCopy)
  })

  it('a conversion that fails and is tried again makes no second backup or dated copy', async () => {
    const memo = safety()
    sqlite().exec(`CREATE TEMP TRIGGER plant AFTER INSERT ON record
      BEGIN SELECT RAISE(ABORT, 'planted'); END`)
    let kept: SafetyMemo | null
    try {
      const failed = await runConvert(deps(), { consent: consent(), projectId: projectId() }, memo)
      expect(failed.outcome).toMatchObject({ ok: false, step: 'convert' })
      kept = failed.memo
    } finally {
      sqlite().exec('DROP TRIGGER IF EXISTS temp.plant')
    }
    expect(kept).toMatchObject({ backup: memo.backup, datedCopy: memo.datedCopy })
    calls = []
    const { outcome } = await runConvert(
      deps(),
      { consent: consent(), projectId: projectId() },
      kept
    )
    expect(outcome).toMatchObject({ ok: true, backup: memo.backup, datedCopy: memo.datedCopy })
    // Only the close's copy back to Drive.
    expect(calls).toEqual(['flush'])
    expect(driveCopies()).toEqual([path.basename(memo.datedCopy)])
    manager.open(folder)
    expect(keptBackups()).toEqual([path.basename(memo.backup)])
  })

  it('a dated copy that fails twice, then works, leaves one kept backup', () => {
    const copy = vi.spyOn(fs, 'copyFileSync')
    copy
      .mockImplementationOnce(() => {
        throw new Error('ENOSPC: no space left on device')
      })
      .mockImplementationOnce(() => {
        throw new Error('ENOSPC: no space left on device')
      })
    const first = switchoverSafety(deps(), null)
    expect(first.outcome).toMatchObject({ ok: false, step: 'datedCopy' })
    expect(first.memo).toMatchObject({ datedCopy: null })
    calls = []
    const second = switchoverSafety(deps(), first.memo)
    expect(second.outcome).toMatchObject({ ok: false, step: 'datedCopy' })
    // The retry made only the dated copy: no flush, no second backup.
    expect(calls).toEqual([])
    const third = safety(second.memo)
    expect(calls).toEqual([])
    expect(third.backup).toBe(first.memo?.backup)
    expect(keptBackups()).toHaveLength(1)
    expect(driveCopies()).toEqual([path.basename(third.datedCopy)])
  })

  it('keeps no memo from a conversion that was running when the project changed', async () => {
    let run: SwitchoverRun | null = null
    let clearing = false
    run = new SwitchoverRun(
      deps({
        current: () => {
          // `manager.onChange` while the originals were read: the run is cleared.
          if (clearing) run?.clear()
          return manager.current()
        }
      })
    )
    expect(await run.safety()).toMatchObject({ ok: true })
    sqlite().exec(`CREATE TEMP TRIGGER plant AFTER INSERT ON record
      BEGIN SELECT RAISE(ABORT, 'planted'); END`)
    clearing = true
    try {
      expect(await run.convert({ consent: consent(), projectId: projectId() })).toMatchObject({
        ok: false,
        step: 'convert'
      })
    } finally {
      sqlite().exec('DROP TRIGGER IF EXISTS temp.plant')
    }
    clearing = false
    // The memo the conversion answered was dropped: the next safety step makes everything again.
    calls = []
    expect(await run.safety()).toMatchObject({ ok: true })
    expect(calls).toEqual(['flush', 'backup'])
  })

  describe('v1’s background writers are held from the safety step (slice 3 review)', () => {
    /** A v1 job's write (the To do sync's) that lands when its run in flight ends. */
    const todoWrite = (): void => {
      const n = holds.length + calls.length
      sqlite()
        .prepare(
          `INSERT INTO todo_item (id, key, kind, rule, source, subject, why, target, created_at, updated_at)
           VALUES (?, ?, 'gap', 'emptyRecord', 'local', 'Mara', 'Her sheet is empty.', 'Mara', ?, ?)`
        )
        .run(`todo-${n}`, `key-${n}`, '2026-10-14T10:00:00Z', '2026-10-14T10:00:00Z')
    }

    it('makes the copies after the run in flight has written, and nothing again at Convert', async () => {
      let finish = (): void => undefined
      const run = new SwitchoverRun(
        deps({
          hold: () => {
            holds.push('hold')
            // The To do sync is mid-run when the safety step comes: it writes, then ends.
            return new Promise<void>((resolve) => {
              finish = () => {
                todoWrite()
                resolve()
              }
            })
          }
        })
      )
      const pending = run.safety()
      await Promise.resolve()
      expect(calls).toEqual([])
      finish()
      const safety = await pending
      if (!safety.ok) throw new Error(safety.message)
      expect(holds).toEqual(['hold'])
      // Held: nothing else writes until Convert, which makes no second backup or dated copy.
      calls = []
      const outcome = await run.convert({ consent: consent(), projectId: projectId() })
      expect(outcome).toMatchObject({
        ok: true,
        backup: safety.backup,
        datedCopy: safety.datedCopy
      })
      expect(calls).toEqual(['flush'])
      expect(driveCopies()).toEqual([path.basename(safety.datedCopy)])
      // The copies hold the write that landed before them.
      const copy = readDb(path.join(safety.datedCopy, 'project.db'))
      try {
        expect(copy.prepare('SELECT count(*) AS n FROM todo_item').get()).toEqual({ n: 1 })
      } finally {
        copy.close()
      }
    })

    it('a write after the copies (one the hold does not cover) still makes Convert copy again', async () => {
      const run = new SwitchoverRun(deps())
      const safety = await run.safety()
      if (!safety.ok) throw new Error(safety.message)
      todoWrite()
      calls = []
      const outcome = await run.convert({ consent: consent(), projectId: projectId() })
      expect(outcome).toMatchObject({ ok: true })
      expect(calls).toEqual(['flush', 'backup', 'flush'])
      if (outcome.ok) expect(outcome.backup).not.toBe(safety.backup)
    })

    it('lets go when the dialog closes, the project changes, or the step is refused', async () => {
      const run = new SwitchoverRun(deps())
      expect(await run.safety()).toMatchObject({ ok: true })
      run.leave()
      run.leave()
      expect(holds).toEqual(['hold', 'release'])
      expect(await run.safety()).toMatchObject({ ok: true })
      run.clear()
      expect(holds).toEqual(['hold', 'release', 'hold', 'release'])
      // A project already switched: refused, and nothing stays held.
      holds = []
      setStoryMemory(db(), 'v2', new Date())
      await expect(run.safety()).rejects.toThrow(/already uses the new story memory/)
      expect(holds).toEqual(['hold', 'release'])
    })

    it('goes on after the longest wait when a run in flight does not end', async () => {
      const run = new SwitchoverRun(
        deps({
          holdWaitMs: 5,
          hold: () => {
            holds.push('hold')
            return new Promise<void>(() => undefined)
          }
        })
      )
      expect(await run.safety()).toMatchObject({ ok: true })
    })

    it('answers the project step when the project changed while it waited', async () => {
      const run = new SwitchoverRun(
        deps({
          hold: () => {
            manager.close()
            manager.open(folder)
            run.clear()
            return Promise.resolve()
          }
        })
      )
      const outcome = await run.safety()
      expect(outcome).toMatchObject({ ok: false, step: 'project' })
      expect(keptBackups()).toEqual([])
    })
  })

  describe('a step that fails changes nothing and says what to do next', () => {
    const safetyFails = (
      plant: () => void
    ): { text: string; step: SwitchoverStep; bytes: Buffer; memo: SafetyMemo | null } => {
      const bytes = rollbackSnapshot(sqlite())
      plant()
      const { outcome, memo } = switchoverSafety(deps(), null)
      if (outcome.ok) throw new Error('expected a failure')
      return { text: expectFailure(outcome, outcome.step), step: outcome.step, bytes, memo }
    }

    const unchanged = (bytes: Buffer): void => {
      expect(getStoryMemory(db()).version).toBe('v1')
      expect(getSwitchoverRecord(db())).toBeNull()
      expect(rollbackSnapshot(sqlite()).equals(bytes)).toBe(true)
      expect(sceneOneOf(path.join(folder, 'project.db'))).toContain('inlineTag')
    }

    it('flush: Google Drive cannot be written, and nothing else is made', () => {
      vi.mocked(WorkingCopy.prototype.syncNow).mockImplementationOnce(() => {
        calls.push('flush')
        throw new Error('Could not copy the project to Google Drive: EACCES: permission denied')
      })
      const { text, step, bytes, memo } = safetyFails(() => undefined)
      expect(step).toBe('flush')
      expect(memo).toBeNull()
      expect(text).toBe(
        `Could not copy the project to Google Drive first: EACCES: permission denied. ${SWITCHOVER_NOTHING_CHANGED} | Check that Google Drive is running and signed in, then try again.`
      )
      expect(calls).toEqual(['flush'])
      expect(keptBackups()).toEqual([])
      expect(driveCopies()).toEqual([])
      unchanged(bytes)
    })

    it('backup: the backup folder cannot be made, and no dated copy follows', () => {
      const blocked = path.join(tmp, 'a-file')
      fs.writeFileSync(blocked, 'not a folder')
      const { text, step, bytes, memo } = safetyFails(() =>
        backups.setFolder(path.join(blocked, 'b'))
      )
      expect(step).toBe('backup')
      expect(memo).toBeNull()
      expect(text).toMatch(/^Could not make the backup: .+\. Nothing was changed/)
      expect(text).toContain(
        '| Choose another backup folder in Settings › Backups, then try again.'
      )
      expect(calls).toEqual(['flush', 'backup'])
      expect(driveCopies()).toEqual([])
      unchanged(bytes)
    })

    it('dated copy: Drive is full half-way through, and the half-made copy is removed', () => {
      const { text, step, bytes, memo } = safetyFails(() => {
        vi.spyOn(fs, 'copyFileSync').mockImplementationOnce(() => {
          throw new Error('ENOSPC: no space left on device')
        })
      })
      expect(step).toBe('datedCopy')
      // The backup is remembered, so *Try again* makes only the dated copy.
      expect(memo).toMatchObject({ datedCopy: null })
      const [kept] = keptBackups()
      expect(memo?.backup.endsWith(kept ?? '?')).toBe(true)
      expect(text).toContain(
        'Could not save the dated copy beside the project: ENOSPC: no space left on device. The backup made a moment ago is kept: '
      )
      expect(text).toContain(`${kept ?? '?'}.`)
      expect(text).toContain(`| Check there is room in ${drive}, then try again.`)
      expect(driveCopies()).toEqual([])
      unchanged(bytes)
    })

    const convertFails = async (
      run: (memo: Safe) => Promise<SwitchoverOutcome>
    ): Promise<{ text: string; step: SwitchoverStep }> => {
      const memo = safety()
      const bytes = rollbackSnapshot(sqlite())
      const outcome = await run(memo)
      if (outcome.ok) throw new Error('expected a failure')
      const text = expectFailure(outcome, outcome.step)
      expect(manager.current()).not.toBeNull()
      unchanged(bytes)
      // Only the dated copy the safety step made: no second one.
      expect(driveCopies()).toEqual([path.basename(memo.datedCopy)])
      return { text, step: outcome.step }
    }

    it('project: Convert names another project', async () => {
      const { text, step } = await convertFails(
        async (memo) =>
          (await runConvert(deps(), { consent: consent(), projectId: 'another' }, memo)).outcome
      )
      expect(step).toBe('project')
      expect(text).toContain('The open project changed during the switch-over.')
    })

    it('project: the open project changed while the originals were read', async () => {
      let handed: SafetyMemo | null | undefined
      const { step } = await convertFails(async (memo) => {
        const moved = deps({
          current: () => {
            const info = manager.current()
            return info === null ? null : { ...info }
          }
        })
        const ran = await runConvert(moved, { consent: consent(), projectId: projectId() }, memo)
        handed = ran.memo
        return ran.outcome
      })
      expect(step).toBe('project')
      // The memo belonged to the session that left: it is never handed back.
      expect(handed).toBeNull()
    })

    it('convert: a fault in the transaction undoes it all', async () => {
      const { text, step } = await convertFails(async (memo) => {
        sqlite().exec(`CREATE TEMP TRIGGER plant AFTER INSERT ON record
          BEGIN SELECT RAISE(ABORT, 'disk image is malformed (planted)'); END`)
        try {
          return (await runConvert(deps(), { consent: consent(), projectId: projectId() }, memo))
            .outcome
        } finally {
          sqlite().exec('DROP TRIGGER IF EXISTS temp.plant')
        }
      })
      expect(step).toBe('convert')
      expect(text).toMatch(
        /^The conversion stopped and undid everything: disk image is malformed \(planted\)\. Nothing was changed/
      )
      expect(text).toMatch(/\| Try again\. If it stops again, your backup is .+before story memory/)
    })

    it('convert: the conversion’s own check refuses a lost paragraph', async () => {
      const scene = fixture.scenes[0] ?? ''
      const { text, step } = await convertFails(async (memo) => {
        sqlite().exec(`CREATE TEMP TRIGGER plant AFTER UPDATE OF content ON node
          WHEN NEW.id = '${scene}'
          BEGIN UPDATE node SET content = '{"type":"doc","content":[]}' WHERE id = NEW.id; END`)
        try {
          return (await runConvert(deps(), { consent: consent(), projectId: projectId() }, memo))
            .outcome
        } finally {
          sqlite().exec('DROP TRIGGER IF EXISTS temp.plant')
        }
      })
      expect(step).toBe('convert')
      expect(text).toContain('its own check found that “Scene 1” would not read as it did')
    })

    it('refuses a project already switched, and a conversion with no safety step', async () => {
      await expect(
        runConvert(deps(), { consent: consent(), projectId: projectId() }, null)
      ).rejects.toThrow('Make the backup and the dated copy first.')
      const memo = safety()
      const { outcome } = await runConvert(
        deps(),
        { consent: consent(), projectId: projectId() },
        memo
      )
      expect(outcome.ok).toBe(true)
      manager.open(folder)
      const again = await runConvert(deps(), { consent: consent(), projectId: projectId() }, null)
      expect(again.outcome).toMatchObject({ ok: false, step: 'project' })
      expect(() => switchoverSafety(deps(), null)).toThrow(/already uses the new story memory/)
    })
  })

  it('names the cause without the thrower’s lead', () => {
    expect(causeOf(new Error('Could not copy the project to Google Drive: EPERM.'))).toBe('EPERM')
    expect(causeOf(new Error('The project folder is gone from /x.'))).toBe(
      'The project folder is gone from /x'
    )
    expect(causeOf('plain')).toBe('plain')
  })
})

/** The sha256 of every file under `dir`, by relative path. */
function folderHash(dir: string): string {
  const hash = createHash('sha256')
  const walk = (at: string): void => {
    for (const entry of fs
      .readdirSync(at, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(at, entry.name)
      if (entry.isDirectory()) walk(full)
      else hash.update(`${path.relative(dir, full)}\u0000`).update(fs.readFileSync(full))
    }
  }
  walk(dir)
  return hash.digest('hex')
}

describe('a test copy (decision SW-D4)', () => {
  /** A test copy made from the original's bytes (as the handler's snapshot of its connection). */
  function trialCopy(): string {
    const source = readDb(path.join(folder, 'project.db'))
    try {
      return createTrialCopy({ folder, sqlite: source, name: 'Harbour Book' }, new Date(clock))
    } finally {
      source.close()
    }
  }

  it('runs without a safety step and leaves the original’s bytes as they were', async () => {
    manager.close()
    const before = folderHash(folder)
    const copy = trialCopy()
    manager.open(copy)
    expect(switchoverTrialOf(db())?.prose).toMatch(/^[0-9a-f]{64}$/)
    expect(() => switchoverSafety(deps(), null)).toThrow(/A test copy needs no backup/)
    calls = []
    const { outcome } = await runConvert(
      deps(),
      { consent: consent(), projectId: projectId() },
      null
    )
    expect(outcome).toMatchObject({
      ok: true,
      folder: copy,
      trial: true,
      backup: null,
      datedCopy: null
    })
    expect(calls).not.toContain('backup')
    expect(folderHash(folder)).toBe(before)
    expect(settingOf(path.join(copy, 'project.db'), SWITCHOVER_RECORD_KEY)).toMatchObject({
      trial: true,
      backup: null,
      datedCopy: null,
      rebuild: 'waiting'
    })
    expect(sceneOneOf(path.join(folder, 'project.db'))).toContain('inlineTag')
  })

  it('keeps a backup of a copy the author has written in, and no dated copy', async () => {
    manager.close()
    const before = folderHash(folder)
    const copy = trialCopy()
    manager.open(copy)
    // The author closed the dialog in the copy and wrote on: the original lacks this.
    saveDocument(db(), fixture.scenes[1] ?? '', para('Written only in the copy.'))
    expect(() => switchoverSafety(deps(), null)).toThrow(/A test copy needs no backup/)
    calls = []
    const { outcome } = await runConvert(
      deps(),
      { consent: consent(), projectId: projectId() },
      null
    )
    if (!outcome.ok) throw new Error(outcome.message)
    expect(calls).toEqual(['flush', 'backup', 'flush'])
    expect(outcome).toMatchObject({ trial: true, datedCopy: null })
    expect(outcome.backup).toMatch(/before story memory .+\.zip$/)
    expect(fs.existsSync(outcome.backup ?? '')).toBe(true)
    // No "(before story memory …)" folder beside the copy; the original is untouched.
    expect(driveCopies()).toEqual([path.basename(copy)])
    expect(folderHash(folder)).toBe(before)
    expect(settingOf(path.join(copy, 'project.db'), SWITCHOVER_RECORD_KEY)).toMatchObject({
      trial: true,
      backup: outcome.backup,
      datedCopy: null
    })
  })
})
