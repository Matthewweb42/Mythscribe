import path from 'node:path'
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
import { ALREADY_SWITCHED, convertSwitchover, prepareSwitchover } from './convert'
import { saveSafetyCopy, switchoverTrialOf } from './trial'

/**
 * The switch-over's run on the open project (F-16.31 part A, plan `Switchover.md` §1.2): the
 * safety step before the dry run (the Google Drive working copy flushed, a kept backup, a dated
 * copy beside the project, so in Drive for a Drive project), then the conversion with its own
 * checks. Every step that fails answers a `SwitchoverFailure` naming it, with the project still
 * v1 and untouched; nothing here throws for those steps. A test copy (`switchoverTrial`) skips the
 * safety step: its original is never written, so it is the copy's safety (decision SW-D4).
 * `handlers.ts` only registers the channels; `SwitchoverRun` holds the safety memo between them.
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
}

/**
 * What the safety step made for one project, kept until the project closes or changes: a second
 * safety call answers it (no second dated copy), and the conversion re-flushes and backs up again
 * only when the project changed since (`changes`, SQLite's `total_changes()`).
 */
export interface SafetyMemo {
  projectId: string
  backup: string
  datedCopy: string
  changes: number
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
 * The safety step on the project itself, before the dry run (decision SW-D2): flush, kept backup,
 * dated copy, in that order; a failure stops there. VALIDATION on a test copy (it needs none) or
 * a project already on v2. Answers the outcome and the memo to keep (the given one when it is
 * this project's: nothing is made twice).
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
  if (memo !== null && memo.projectId === session.info.id) {
    return { outcome: { ok: true, backup: memo.backup, datedCopy: memo.datedCopy }, memo }
  }
  const flushed = flush(session)
  if (flushed !== null) return { outcome: flushed, memo: null }
  const backup = keptBackup(deps)
  if ('ok' in backup) return { outcome: backup, memo: null }
  let datedCopy: string
  try {
    datedCopy = saveSafetyCopy(
      { folder: session.folder, sqlite: session.connection.sqlite },
      deps.now()
    )
  } catch (err) {
    return {
      outcome: failure(
        'datedCopy',
        `Could not save the dated copy beside the project: ${causeOf(err)}. The backup made a moment ago is kept: ${backup.file}.`,
        `Check there is room in ${path.dirname(session.folder)}, then try again.`
      ),
      memo: null
    }
  }
  const next: SafetyMemo = {
    projectId: session.info.id,
    backup: backup.file,
    datedCopy,
    changes: totalChanges(session.connection.sqlite)
  }
  return { outcome: { ok: true, backup: backup.file, datedCopy }, memo: next }
}

/**
 * The conversion (`switchover:convert`): the open project must be the one the dialog was for and
 * still v1 (step `project`); on the project itself, anything changed since the safety step is
 * flushed and backed up again (the dated copy stays the one made before the dry run, SW-D3);
 * the originals are read; the project is checked again after that await; then the conversion in
 * one transaction, which checks itself (step `convert`); then the project closes so the renderer
 * reopens it on v2. VALIDATION only when the safety step never ran for this project, which the
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
  const trial = switchoverTrialOf(db) !== null
  let safety: SafetyMemo | null = null
  if (!trial) {
    if (memo?.projectId !== session.info.id) {
      throw new AppError('VALIDATION', 'Make the backup and the dated copy first.')
    }
    safety = memo
    if (totalChanges(session.connection.sqlite) !== memo.changes) {
      const flushed = flush(session)
      if (flushed !== null) return { outcome: flushed, memo }
      const backup = keptBackup(deps)
      if ('ok' in backup) return { outcome: backup, memo }
      safety = { ...memo, backup: backup.file, changes: totalChanges(session.connection.sqlite) }
    }
  }
  const backup = safety?.backup ?? null
  const datedCopy = safety?.datedCopy ?? null
  const convertFailed = (err: unknown): SwitchoverFailure =>
    failure(
      'convert',
      `The conversion stopped and undid everything: ${causeOf(err)}.`,
      backup === null
        ? 'Try again. If it stops again, please send this message to support; the project this copy was made from is not changed.'
        : `Try again. If it stops again, your backup is ${backup}; please send this message to support.`
    )
  let prepared: Awaited<ReturnType<typeof prepareSwitchover>>
  try {
    prepared = await prepareSwitchover(db, session.folder)
  } catch (err) {
    return { outcome: convertFailed(err), memo: safety }
  }
  if (deps.current() !== session.info) {
    return {
      outcome: failure('project', 'The open project changed during the switch-over.', AGAIN),
      memo: safety
    }
  }
  let counts: ReturnType<typeof convertSwitchover>
  try {
    counts = convertSwitchover(db, session.info.format, prepared, input.consent, deps.now(), {
      record: { trial, backup, datedCopy }
    })
  } catch (err) {
    return { outcome: convertFailed(err), memo: safety }
  }
  const folder = session.folder
  // The project reopens on v2: main closes it (a Drive project is copied back) and the renderer
  // opens the same folder again, no restart (decision SW-D12).
  deps.close()
  return { outcome: { ok: true, folder, trial, backup, datedCopy, counts }, memo: null }
}

/**
 * The run's state between channels: the safety memo, dropped whenever the open project changes
 * (`manager.onChange` → `clear`).
 */
export class SwitchoverRun {
  private memo: SafetyMemo | null = null

  constructor(private readonly deps: SwitchoverRunDeps) {}

  safety(): SwitchoverSafetyOutcome {
    const { outcome, memo } = switchoverSafety(this.deps, this.memo)
    this.memo = memo
    return outcome
  }

  async convert(input: SwitchoverConvertInput): Promise<SwitchoverOutcome> {
    const { outcome, memo } = await runConvert(this.deps, input, this.memo)
    this.memo = memo
    return outcome
  }

  clear(): void {
    this.memo = null
  }
}
