import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type Database from 'better-sqlite3'
import { CLOUD_PROVIDER_LABEL } from '@shared/cloudSync'
import type { ProjectInfo } from '@shared/ipc/contract'
import {
  SWITCHOVER_NOTHING_CHANGED,
  type SwitchoverConvertInput,
  type SwitchoverFailure,
  type SwitchoverOutcome,
  type SwitchoverSafetyOutcome,
  type SwitchoverStep
} from '@shared/memory/switchover'
import { AppError } from '../../ipc/errors'
import type { ProjectSession } from '../../project/projectStore'
import { getStoryMemory } from '../../project/settingsStore'
import { totalChanges } from '../../project/workingCopy'
import {
  ALREADY_SWITCHED,
  convertSwitchover,
  prepareSwitchover,
  type PreparedSwitchover
} from './convert'
import { saveSafetyCopy, switchoverTrialOf, trialWrittenIn } from './trial'

/**
 * The switch-over's run on the open project (F-16.31 part A, plan `Switchover.md` §1.2): the
 * safety step before the dry run (the Google Drive working copy flushed, a kept backup, a dated
 * copy beside the project, so in Drive for a Drive project), then the conversion with its own
 * checks. Every step that fails answers a `SwitchoverFailure` naming it, with the project still
 * v1 and untouched; nothing here throws for those steps. A test copy (`switchoverTrial`) skips the
 * safety step: its original is never written, so it is the copy's safety (decision SW-D4), unless
 * the author has written in the copy since it was made (`trialWrittenIn`), when it gets a kept
 * backup (no dated copy). `handlers.ts` only registers the channels; `SwitchoverRun` holds the
 * safety memo between them.
 */

/** What the run needs of main. */
export interface SwitchoverRunDeps {
  /** The open project (`manager.require()`): its folder, connection, working copy and info. */
  session: () => ProjectSession
  /** A kept backup of the open project (`BackupService.backupNow({ kept: true })`): its zip. */
  backupNow: (options: { kept: true }) => string
  /** The open project's info (`manager.current()`), to see it has not changed under an await. */
  current: () => ProjectInfo | null
  /** Closes the open project (`manager.close()`): Google Drive gets the converted database. */
  close: () => void
  now: () => Date
  /**
   * Holds v1's background writers (summaries, To do, voice, plan links, sheet sync) from the
   * safety step until Convert or the dialog closes, so nothing they write moves the project
   * between the copies and the conversion (Switch-over slice 3 review); answers once the runs in
   * flight have ended. The mention scan is not held: it writes only what `projectDigest` ignores.
   */
  hold: () => Promise<void>
  /** Lets the held writers go (`hold`); what waited runs. */
  release: () => void
  /** The longest the safety step waits for a run in flight (`hold`); default 30 s. */
  holdWaitMs?: number
}

/** How long the safety step waits for a background run in flight before it goes on anyway. */
export const SWITCHOVER_HOLD_WAIT_MS = 30_000

/**
 * What the safety step made of one open session, at one state of it: reused only while it is that
 * session (`session`, so a reopen of the same folder never matches), nothing has been written
 * through its connection since (`changes`, SQLite's `total_changes()`, which only grows) or what
 * was written touched only the derived indexes (`digest`, Switch-over slice 3), and the files are
 * still there. Otherwise flush, backup and dated copy run again (review of Switch-over slice 1). `datedCopy` is null while the dated copy has failed (a retry then reuses the backup and
 * makes only the dated copy) and on a test copy, which gets none.
 */
export interface SafetyMemo {
  session: ProjectSession
  backup: string
  datedCopy: string | null
  changes: number
  /** `projectDigest` when the backup was made: what a write since must have changed to count. */
  digest: string
}

/**
 * What only the app writes, rebuilt from the author's own data whenever it is stale: the search
 * indexes and their full-text shadow tables, the tag mention scans and the mentions they found, the
 * background job queue and the AI request cache. A write to these alone (a mention scan landing a second after a save) is
 * not a change the safety copies must follow (Switch-over slice 3: it made a second dated copy in
 * Google Drive); everything else is the project.
 */
const DERIVED_TABLES: ReadonlySet<string> = new Set([
  'index_job',
  'mention_scan',
  'tag_mention',
  'ai_cache'
])
const DERIVED_PREFIXES: readonly string[] = ['passage_fts', 'memory_passage_fts']

const isDerived = (table: string): boolean =>
  DERIVED_TABLES.has(table) || DERIVED_PREFIXES.some((prefix) => table.startsWith(prefix))

/**
 * A SHA-256 over every table of the project but the derived ones, row by row in stored order: two
 * equal digests mean the author's data, settings and history read the same. Synchronous; one pass
 * over the database, run only when SQLite's change count has moved.
 */
export function projectDigest(sqlite: Database.Database): string {
  const hash = createHash('sha256')
  const tables = sqlite
    .prepare<[], { name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
    )
    .all()
  for (const { name } of tables) {
    if (isDerived(name)) continue
    hash.update(name).update('\u0000')
    const rows = sqlite
      .prepare(`SELECT * FROM "${name.replace(/"/g, '""')}"`)
      .raw()
      .iterate()
    for (const row of rows) hash.update(JSON.stringify(row)).update('\u0001')
  }
  return hash.digest('hex')
}

/** The cause an error carries, without the "Could not …: " its thrower led with, unpunctuated. */
export function causeOf(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err)
  const lead = /^Could not [^:]*: /.exec(message)
  return (lead === null ? message : message.slice(lead[0].length)).trim().replace(/\.+$/, '')
}

function failure(step: SwitchoverStep, what: string, nextStep: string): SwitchoverFailure {
  return { ok: false, step, message: `${what} ${SWITCHOVER_NOTHING_CHANGED}`, nextStep }
}

const AGAIN = 'Open the project again and start from Help › Switch to the new story memory….'

/** The flush (step `flush`); null when it worked or the project is not in a synced folder. */
function flush(session: ProjectSession): SwitchoverFailure | null {
  const copy = session.workingCopy
  if (copy === null) return null
  try {
    copy.syncNow(session.connection.sqlite)
    return null
  } catch (err) {
    const label = CLOUD_PROVIDER_LABEL[copy.provider]
    return failure(
      'flush',
      `Could not copy the project to ${label} first: ${causeOf(err)}.`,
      `Check that ${label} is running and signed in, then try again.`
    )
  }
}

/** The kept backup (step `backup`): its zip, or the failure. */
function keptBackup(deps: SwitchoverRunDeps): { file: string } | SwitchoverFailure {
  try {
    return { file: deps.backupNow({ kept: true }) }
  } catch (err) {
    return failure(
      'backup',
      `Could not make the backup: ${causeOf(err)}.`,
      'Choose another backup folder in Settings › Backups, then try again.'
    )
  }
}

/**
 * A memo that is still this session's state: nothing written since but the derived indexes
 * (`projectDigest`), the backup still there. Answered with the change count as it is now.
 */
function stillCurrent(session: ProjectSession, memo: SafetyMemo | null): SafetyMemo | null {
  if (memo?.session !== session || !fs.existsSync(memo.backup)) return null
  const sqlite = session.connection.sqlite
  const changes = totalChanges(sqlite)
  if (changes === memo.changes) return memo
  return projectDigest(sqlite) === memo.digest ? { ...memo, changes } : null
}

type Secured =
  | { ok: true; memo: SafetyMemo }
  | { ok: false; failure: SwitchoverFailure; memo: SafetyMemo | null }

/**
 * The kept backup of the project as it reads now (steps `flush`, `backup`): the memo's when it is
 * still current, else the working copy flushed and a new kept backup. Synchronous, so nothing can
 * write between it and what follows. On a failure, the memo still worth keeping.
 */
function secureBackup(
  deps: SwitchoverRunDeps,
  session: ProjectSession,
  memo: SafetyMemo | null
): Secured {
  const current = stillCurrent(session, memo)
  if (current !== null) return { ok: true, memo: current }
  const flushed = flush(session)
  if (flushed !== null) return { ok: false, failure: flushed, memo: null }
  const backup = keptBackup(deps)
  if ('ok' in backup) return { ok: false, failure: backup, memo: null }
  const sqlite = session.connection.sqlite
  const changes = totalChanges(sqlite)
  const digest = projectDigest(sqlite)
  return { ok: true, memo: { session, backup: backup.file, datedCopy: null, changes, digest } }
}

/**
 * The dated copy beside the project (step `datedCopy`) for a memo `secureBackup` has just answered:
 * its own when it has one still there, else a new one. A failure keeps the memo with its backup, so
 * *Try again* makes only the dated copy.
 */
function secureDatedCopy(
  deps: SwitchoverRunDeps,
  session: ProjectSession,
  memo: SafetyMemo
):
  | { ok: true; memo: SafetyMemo; datedCopy: string }
  | { ok: false; failure: SwitchoverFailure; memo: SafetyMemo } {
  if (memo.datedCopy !== null && fs.existsSync(memo.datedCopy)) {
    return { ok: true, memo, datedCopy: memo.datedCopy }
  }
  try {
    const datedCopy = saveSafetyCopy(
      { folder: session.folder, sqlite: session.connection.sqlite },
      deps.now()
    )
    return { ok: true, memo: { ...memo, datedCopy }, datedCopy }
  } catch (err) {
    return {
      ok: false,
      failure: failure(
        'datedCopy',
        `Could not save the dated copy beside the project: ${causeOf(err)}. The backup made a moment ago is kept: ${memo.backup}.`,
        `Check there is room in ${path.dirname(session.folder)}, then try again.`
      ),
      memo: { ...memo, datedCopy: null }
    }
  }
}

/**
 * The safety step on the project itself, before the dry run (decision SW-D2): flush, kept backup,
 * dated copy, in that order; a failure stops there. VALIDATION on a test copy (it needs none) or
 * a project already on v2. A second call answers what the first made while nothing has been
 * written since (the author pressed Back to the intro and on again); after any write, or in
 * another session, it makes everything again, so the copies are always the project as it is now.
 * Answers the outcome and the memo to keep.
 */
export function switchoverSafety(
  deps: SwitchoverRunDeps,
  memo: SafetyMemo | null
): { outcome: SwitchoverSafetyOutcome; memo: SafetyMemo | null } {
  const session = deps.session()
  const db = session.connection.orm
  if (getStoryMemory(db).version === 'v2') throw new AppError('VALIDATION', ALREADY_SWITCHED)
  if (switchoverTrialOf(db) !== null) {
    throw new AppError(
      'VALIDATION',
      'A test copy needs no backup of its own: the project it was made from is not changed.'
    )
  }
  const backedUp = secureBackup(deps, session, memo)
  if (!backedUp.ok) return { outcome: backedUp.failure, memo: backedUp.memo }
  const copied = secureDatedCopy(deps, session, backedUp.memo)
  if (!copied.ok) return { outcome: copied.failure, memo: copied.memo }
  return {
    outcome: { ok: true, backup: copied.memo.backup, datedCopy: copied.datedCopy },
    memo: copied.memo
  }
}

/**
 * The conversion (`switchover:convert`): the open project must be the one the dialog was for and
 * still v1 (step `project`); the originals are read; the project is checked again after that
 * await; then, with nothing async left before the transaction, the safety copies are made current
 * (on the project itself: anything written since the safety step is flushed, backed up and copied
 * beside the project again, so both copies are the project exactly as it was before the
 * conversion; a test copy the author has written in gets a kept backup); then the conversion in
 * one transaction, which checks itself (step `convert`); then the project closes so the renderer
 * reopens it on v2. VALIDATION only when the safety step never ran for this session, which the
 * dialog never allows.
 */
export async function runConvert(
  deps: SwitchoverRunDeps,
  input: SwitchoverConvertInput,
  memo: SafetyMemo | null
): Promise<{ outcome: SwitchoverOutcome; memo: SafetyMemo | null }> {
  const session = deps.session()
  const db = session.connection.orm
  if (session.info.id !== input.projectId) {
    return {
      outcome: failure('project', 'The open project changed during the switch-over.', AGAIN),
      memo
    }
  }
  if (getStoryMemory(db).version === 'v2') {
    return {
      outcome: {
        ok: false,
        step: 'project',
        message: `${ALREADY_SWITCHED} Nothing was changed.`,
        nextStep: 'Close this window: the project already uses the new story memory.'
      },
      memo
    }
  }
  const trialMarker = switchoverTrialOf(db)
  const trial = trialMarker !== null
  if (!trial && memo?.session !== session) {
    throw new AppError('VALIDATION', 'Make the backup and the dated copy first.')
  }
  const convertFailed = (err: unknown, backup: string | null): SwitchoverFailure =>
    failure(
      'convert',
      `The conversion stopped and undid everything: ${causeOf(err)}.`,
      backup === null
        ? 'Try again. If it stops again, please send this message to support; the project this copy was made from is not changed.'
        : `Try again. If it stops again, your backup is ${backup}; please send this message to support.`
    )
  let prepared: PreparedSwitchover
  try {
    prepared = await prepareSwitchover(db, session.folder)
  } catch (err) {
    if (deps.current() !== session.info) {
      return {
        outcome: failure('project', 'The open project changed during the switch-over.', AGAIN),
        memo: null
      }
    }
    return { outcome: convertFailed(err, memo?.backup ?? null), memo }
  }
  if (deps.current() !== session.info) {
    // The memo belongs to a session that is gone: never handed back (a reopen gets a new one).
    return {
      outcome: failure('project', 'The open project changed during the switch-over.', AGAIN),
      memo: null
    }
  }
  // From here to the transaction everything is synchronous: nothing can write in between.
  let safety: SafetyMemo | null = null
  let datedCopy: string | null = null
  if (!trial || trialWrittenIn(session.connection.sqlite, trialMarker)) {
    const backedUp = secureBackup(deps, session, memo)
    if (!backedUp.ok) return { outcome: backedUp.failure, memo: backedUp.memo }
    safety = backedUp.memo
    if (!trial) {
      const copied = secureDatedCopy(deps, session, backedUp.memo)
      if (!copied.ok) return { outcome: copied.failure, memo: copied.memo }
      safety = copied.memo
      datedCopy = copied.datedCopy
    }
  }
  const backup = safety?.backup ?? null
  let counts: ReturnType<typeof convertSwitchover>
  try {
    counts = convertSwitchover(db, session.info.format, prepared, input.consent, deps.now(), {
      record: { trial, source: trialMarker?.source ?? null, backup, datedCopy }
    })
  } catch (err) {
    // Rolled back: the project reads as it did when the copies were made, though SQLite counted
    // the undone rows, so the memo takes the count as it is now and *Try again* makes no new copy.
    const after =
      safety === null ? null : { ...safety, changes: totalChanges(session.connection.sqlite) }
    return { outcome: convertFailed(err, backup), memo: after }
  }
  const folder = session.folder
  // The project reopens on v2: main closes it (a Drive project is copied back) and the renderer
  // opens the same folder again, no restart (decision SW-D12).
  deps.close()
  return { outcome: { ok: true, folder, trial, backup, datedCopy, counts }, memo: null }
}

/** Resolves after `ms`, on a timer that never holds the process open. */
function after(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    if (typeof timer === 'object' && typeof timer.unref === 'function') timer.unref()
  })
}

/**
 * The run's state between channels: the safety memo, dropped whenever the open project changes
 * (`manager.onChange` → `clear`), and the hold on v1's background writers (`deps.hold`), taken
 * by the safety step and let go when the dialog closes (`leave`), the project changes (`clear`,
 * which a successful Convert causes) or the safety step refuses. A conversion that was running
 * when `clear` came answers its outcome but leaves no memo behind.
 */
export class SwitchoverRun {
  private memo: SafetyMemo | null = null
  private generation = 0
  private held = false

  constructor(private readonly deps: SwitchoverRunDeps) {}

  /**
   * The safety step (`switchoverSafety`) once v1's background writers are held and the runs in
   * flight have ended (at most `holdWaitMs`: a run that ends later only makes Convert copy
   * again), so the copies stay the project as it is until Convert.
   */
  async safety(): Promise<SwitchoverSafetyOutcome> {
    const started = this.generation
    const info = this.deps.session().info
    this.held = true
    await Promise.race([this.deps.hold(), after(this.deps.holdWaitMs ?? SWITCHOVER_HOLD_WAIT_MS)])
    if (started !== this.generation || this.deps.current() !== info) {
      return failure('project', 'The open project changed during the switch-over.', AGAIN)
    }
    try {
      const { outcome, memo } = switchoverSafety(this.deps, this.memo)
      this.memo = memo
      return outcome
    } catch (err) {
      // Refused (a test copy, a project already switched): nothing to hold for.
      this.leave()
      throw err
    }
  }

  async convert(input: SwitchoverConvertInput): Promise<SwitchoverOutcome> {
    const started = this.generation
    const { outcome, memo } = await runConvert(this.deps, input, this.memo)
    if (started === this.generation) this.memo = memo
    return outcome
  }

  /**
   * The dialog closed (`switchover:leave`): v1's background writers go again. The memo stays,
   * so a flow started again with nothing written since reuses the copies.
   */
  leave(): void {
    if (!this.held) return
    this.held = false
    this.deps.release()
  }

  clear(): void {
    this.memo = null
    this.generation += 1
    this.leave()
  }
}
