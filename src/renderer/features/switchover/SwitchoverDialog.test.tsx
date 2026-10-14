import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { defaultAiSettings, type AiSettings } from '@shared/aiSettings'
import type { CloudSyncStatus } from '@shared/cloudSync'
import type { Channel, Input, Output, ProjectInfo } from '@shared/ipc/contract'
import type {
  RebuildEstimate,
  SwitchoverConsent,
  SwitchoverFailure,
  SwitchoverPlan,
  SwitchoverSafetyOutcome
} from '@shared/memory/switchover'
import type { MemoryStatus, RebuildStartResult } from '@shared/memory/views'
import { resetBackupStore } from '@renderer/features/backups/backupStore'
import { resetMemoryStore, useMemoryStore } from '@renderer/features/memory/memoryStore'
import { resetCloudSyncStore, useCloudSyncStore } from '@renderer/features/project/cloudSyncStore'
import { useDialogStore } from '@renderer/features/shell/dialogs/dialogStore'
import { registerPendingSave, resetPendingSaves } from '@renderer/features/project/pendingSaves'
import { useProjectStore } from '@renderer/features/project/projectStore'
import { setIpcClient, type IpcClient } from '@renderer/lib/ipc'
import { SwitchoverDialog } from './SwitchoverDialog'
import { backupWhen } from '@renderer/features/backups/backupWhen'
import { rebuildLine, whatChanges } from './switchoverText'
import { resetSwitchoverStore, useSwitchoverStore } from './switchoverStore'

const ORIGINAL: ProjectInfo = {
  id: 'real',
  name: 'Book',
  format: 'novel',
  path: '/drive/My Drive/Book.mythscribe',
  created: 'c',
  modified: 'm',
  lastOpened: 'l',
  schemaVersion: 40,
  storyMemory: 'v1'
}

const COPY: ProjectInfo = {
  ...ORIGINAL,
  id: 'copy',
  name: 'Book (story memory test 2026-10-12 0900)',
  path: '/drive/My Drive/Book (story memory test 2026-10-12 0900).mythscribe'
}

const BACKUP = '/backups/real/Book before story memory 2026-10-14 101500.zip'
const DATED = '/drive/My Drive/Book (before story memory 2026-10-14 1015).mythscribe'

const PLAN: SwitchoverPlan = {
  kept: [{ name: 'The manuscript', detail: '3 documents.' }],
  converted: [
    { name: 'Mara', detail: 'Record (character): from its tag.' },
    { name: 'Mara Vell', detail: 'Record (character): from its sheet.' }
  ],
  dropped: [{ name: 'Tags the AI made', detail: '#reeds' }],
  merges: [
    {
      keep: 'entity:1',
      keepName: 'Mara Vell',
      keepCategory: 'character',
      merge: 'tag:2',
      mergeName: 'Mara',
      mergeCategory: 'character',
      rule: 'subset',
      name: 'Mara Vell',
      matched: 'Mara'
    }
  ],
  filedByAi: [{ name: 'Mara Vell', lines: ['Personality: Stubborn'] }],
  notes: ['Tag nesting is dropped: #grief under #melancholy.'],
  inlineTags: 1,
  rebuild: {
    scenes: 3,
    requests: 76,
    tokensIn: 30_000,
    tokensOut: 3_000,
    costUsd: 0.03,
    priced: true,
    source: 'ownKey',
    fastModel: 'deepseek/deepseek-v4-flash',
    strongModel: 'deepseek/deepseek-v4-pro',
    minutes: 1
  }
}

const COUNTS = {
  records: 2,
  labels: 1,
  research: 0,
  scenesWithDetails: 0,
  dismissals: 0,
  merged: 1,
  tokens: 2,
  documents: 1
}

const BACKUP_FAILED: SwitchoverFailure = {
  ok: false,
  step: 'backup',
  message:
    'Could not make the backup: ENOTDIR. Nothing was changed: this project still uses the old story memory.',
  nextStep: 'Choose another backup folder in Settings › Backups, then try again.'
}

const CONVERT_FAILED: SwitchoverFailure = {
  ok: false,
  step: 'convert',
  message:
    'The conversion stopped and undid everything: disk full. Nothing was changed: this project still uses the old story memory.',
  nextStep: `Try again. If it stops again, your backup is ${BACKUP}; please send this message to support.`
}

/** What `memory:status` answers after the reopen: reading may run, nothing read yet. */
const STATUS: MemoryStatus = {
  lastRead: null,
  paused: null,
  todayUsd: 0,
  cloud: null,
  rebuild: null,
  check: null
}

/** The price `memory:rebuildEstimate` answers on the switched project. */
const ESTIMATE: RebuildEstimate = { ...PLAN.rebuild, scenes: 12, costUsd: 0.04, minutes: 2 }

const DRIVE: CloudSyncStatus = {
  provider: 'googleDrive',
  state: 'synced',
  lastSyncedAt: null,
  error: null,
  conflictCopy: null,
  conflictCopyHolds: null
}

let calls: { channel: Channel; input: unknown }[]
/** What `switchover:trial` answers: null for the project itself. */
let trial: Output<'switchover:trial'>
/** What each `switchover:safety` answers, in turn (the last one repeats). */
let safety: SwitchoverSafetyOutcome[]
/** What each `switchover:convert` failure answers, in turn; empty: the conversion runs. */
let convertFailures: SwitchoverFailure[]
/** What `project:open` does; a test makes it fail. */
let reopen: (path: string) => ProjectInfo
/** Holds `switchover:safety` until the test lets it go (a stale answer). */
let holdSafety: Promise<void> | null
/** After the reopen: main's reading status, the project's AI settings, the price, the start. */
let status: MemoryStatus
let settings: AiSettings
let estimate: RebuildEstimate
let started: RebuildStartResult
/** `memory:rebuildEstimate` throws (the project busy, a read failing). */
let estimateFails: boolean
/** While set, `memory:rebuild` answers once it settles (Rebuild now's start in flight). */
let holdRebuild: Promise<void> | null

const channels = (): Channel[] => calls.map((call) => call.channel)

beforeEach(() => {
  resetSwitchoverStore()
  resetPendingSaves()
  resetCloudSyncStore()
  resetBackupStore()
  useDialogStore.setState({ modals: [], toasts: [] })
  useProjectStore.setState({ current: ORIGINAL, busy: false })
  calls = []
  trial = null
  safety = [{ ok: true, backup: BACKUP, datedCopy: DATED }]
  convertFailures = []
  holdSafety = null
  resetMemoryStore()
  status = STATUS
  settings = { ...defaultAiSettings(), dial: 1 }
  estimate = ESTIMATE
  started = { ok: true, queued: 12, estimate: ESTIMATE }
  estimateFails = false
  holdRebuild = null
  reopen = (path) => ({
    ...(path === COPY.path ? COPY : ORIGINAL),
    storyMemory: path === ORIGINAL.path && channels().includes('switchover:trialCopy') ? 'v1' : 'v2'
  })
  const client: IpcClient = {
    async invoke<C extends Channel>(channel: C, input: Input<C>): Promise<Output<C>> {
      calls.push({ channel, input })
      switch (channel) {
        case 'switchover:trial':
          return trial as Output<C>
        case 'switchover:trialCopy':
          return { folder: COPY.path, info: COPY } as Output<C>
        case 'switchover:safety': {
          if (holdSafety !== null) await holdSafety
          const next = safety.length > 1 ? safety.shift() : safety[0]
          return next as Output<C>
        }
        case 'switchover:plan':
          return PLAN as Output<C>
        case 'switchover:consent':
          return [
            { key: 't-1', tag: '#mara', count: 2, sample: 'Then #mara left.', replacement: 'mara' }
          ] as Output<C>
        case 'switchover:convert': {
          const failed = convertFailures.shift()
          if (failed !== undefined) return failed as Output<C>
          const onCopy = useProjectStore.getState().current?.id === 'copy'
          return {
            ok: true,
            folder: onCopy ? COPY.path : ORIGINAL.path,
            trial: onCopy,
            backup: onCopy ? null : BACKUP,
            datedCopy: onCopy ? null : DATED,
            counts: COUNTS
          } as Output<C>
        }
        case 'project:open':
          return reopen((input as { path: string }).path) as Output<C>
        case 'project:cloudSyncNow':
          return null as Output<C>
        case 'backups:reveal':
          return null as Output<C>
        case 'switchover:leave':
          return null as Output<C>
        case 'recovery:list':
          return [] as Output<C>
        case 'memory:status':
          return (
            calls.some((call) => call.channel === 'memory:rebuild') && started.ok
              ? {
                  ...status,
                  rebuild: { startedAt: 's', finishedAt: null, draftId: 'd', total: 12, done: 0 }
                }
              : status
          ) as Output<C>
        case 'aiSettings:get':
          return settings as Output<C>
        case 'memory:rebuildEstimate':
          if (estimateFails) throw new Error('The project is busy.')
          return estimate as Output<C>
        case 'memory:rebuild':
          if (holdRebuild !== null) await holdRebuild
          return started as Output<C>
        case 'memory:notices':
        case 'memory:cardLines':
          return (channel === 'memory:notices' ? [] : {}) as Output<C>
        default:
          throw new Error(`unexpected ${channel}`)
      }
    },
    on: () => () => {}
  }
  setIpcClient(client)
})

afterEach(() => {
  resetSwitchoverStore()
  resetCloudSyncStore()
  resetBackupStore()
  resetMemoryStore()
  // A switched project left open would run the next file's stores on the new memory.
  useProjectStore.setState({ current: null, busy: false })
  setIpcClient(null)
})

/** Opens the flow and waits for the intro's buttons. */
async function openIntro(): Promise<HTMLElement> {
  render(<SwitchoverDialog />)
  await useSwitchoverStore.getState().open()
  const intro = await screen.findByRole('dialog', { name: 'Switch to the new story memory' })
  return intro
}

describe('SwitchoverDialog: the intro (F-16.31 part A)', () => {
  it('says what changes and recommends a copy first, focused, beside Switch this project… and Cancel', async () => {
    const intro = await openIntro()
    const list = within(intro).getByRole('list', { name: 'What changes' })
    const lines = within(list)
      .getAllByRole('listitem')
      .map((item) => item.textContent)
    expect(lines).toEqual([...whatChanges(false)])
    // What the dry run drops is named, not promised as kept (Switch-over slice 3 review).
    expect(lines[2]).toContain('what you dismissed that still applies')
    expect(lines[3]).toContain('Sheet text the AI added to your sheets')
    expect(lines[4]).toContain('sheets only the AI wrote')
    expect(lines[5]).toContain('A backup and a dated copy of the project are made first.')
    expect(intro).toHaveTextContent('Try it on a copy first (recommended)')
    const copy = within(intro).getByRole('button', { name: 'Try it on a copy first' })
    await waitFor(() => expect(copy).toHaveFocus())
    expect(within(intro).getByRole('button', { name: 'Switch this project…' })).toBeEnabled()
    // Opening the intro makes and changes nothing.
    expect(channels()).toEqual(['switchover:trial'])
    await userEvent.click(within(intro).getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(useDialogStore.getState().toasts).toEqual([])
  })

  it('on a test copy already open, offers only Switch this copy…, with no safety step', async () => {
    useProjectStore.setState({ current: COPY })
    trial = { source: ORIGINAL.path, createdAt: '2026-10-12T09:00:00.000Z' }
    const user = userEvent.setup()
    const intro = await openIntro()
    expect(intro).toHaveTextContent('This is a test copy.')
    // A copy gets no backup or dated copy of its own: its list does not promise one.
    const lines = within(intro)
      .getAllByRole('listitem')
      .map((item) => item.textContent)
    expect(lines).toEqual([...whatChanges(true)])
    expect(lines.at(-1)).toBe(
      'Snapshots are not changed. It runs once on this copy; the project it was made from stays as it is.'
    )
    expect(intro).not.toHaveTextContent('A backup and a dated copy of the project are made first.')
    expect(within(intro).queryByRole('button', { name: 'Switch this project…' })).toBeNull()
    expect(within(intro).queryByRole('button', { name: 'Try it on a copy first' })).toBeNull()
    await user.click(await within(intro).findByRole('button', { name: 'Switch this copy…' }))
    const dryRun = await screen.findByRole('dialog', { name: 'Switch-over dry run' })
    expect(dryRun).toHaveTextContent('This is a test copy; nothing has changed yet.')
    expect(channels()).not.toContain('switchover:safety')
    await user.click(screen.getByRole('button', { name: 'Next' }))
    await user.click(await screen.findByRole('button', { name: 'Convert' }))
    await screen.findByRole('dialog', { name: 'Switched over' })
    // Its final screen names the project it was made from.
    expect(screen.getByTestId('switchover-original')).toHaveTextContent(
      `Your project at ${ORIGINAL.path} is unchanged and still uses the old one.`
    )
  })
})

describe('SwitchoverDialog: the project itself (F-16.31 part A)', () => {
  it('runs the safety step after pending saves, then the dry run with the real wording and both paths', async () => {
    useCloudSyncStore.setState({ status: DRIVE })
    let flushed = 0
    registerPendingSave(async () => {
      flushed += 1
      calls.push({ channel: 'document:save', input: null })
    })
    const user = userEvent.setup()
    const intro = await openIntro()
    await user.click(within(intro).getByRole('button', { name: 'Switch this project…' }))
    const dryRun = await screen.findByRole('dialog', { name: 'Switch-over dry run' })
    expect(flushed).toBe(1)
    const order = channels()
    expect(order.indexOf('document:save')).toBeLessThan(order.indexOf('switchover:safety'))
    expect(order.indexOf('switchover:safety')).toBeLessThan(order.indexOf('switchover:plan'))
    const yours = within(dryRun).getByTestId('switchover-yours')
    expect(yours).toHaveTextContent(
      'This is your project. Nothing has changed yet; the backup and the dated copy are made.'
    )
    expect(yours).toHaveTextContent(`Backup: ${BACKUP}`)
    expect(yours).toHaveTextContent(`Dated copy: ${DATED}`)
    expect(dryRun).not.toHaveTextContent('This is a test copy')
    expect(screen.getByRole('list', { name: 'Converted' })).toHaveTextContent(
      'Mara: Record (character): from its tag.'
    )
    expect(screen.getByTestId('switchover-rebuild')).toHaveTextContent(
      'Rebuild memory: 3 scenes, about 3¢ on your own key, about a minute. It asks before it starts.'
    )
    // The consent screen's last line names the backup.
    await user.click(screen.getByRole('button', { name: 'Next' }))
    expect(await screen.findByTestId('switchover-consent-last')).toHaveTextContent(
      `Convert changes this project. Its backup is ${BACKUP}.`
    )
  })

  it('shows the Drive-aware progress line while the copies are made', async () => {
    useCloudSyncStore.setState({ status: DRIVE })
    let release = (): void => {}
    holdSafety = new Promise((resolve) => {
      release = resolve
    })
    const user = userEvent.setup()
    const intro = await openIntro()
    await user.click(within(intro).getByRole('button', { name: 'Switch this project…' }))
    expect(await screen.findByTestId('switchover-safety')).toHaveTextContent(
      'Making a backup and a dated copy in Google Drive…'
    )
    release()
    await screen.findByRole('dialog', { name: 'Switch-over dry run' })
  })

  it('keeps the intro with the failure block when the backup fails, and Try again runs the step again', async () => {
    safety = [BACKUP_FAILED, { ok: true, backup: BACKUP, datedCopy: DATED }]
    const user = userEvent.setup()
    const intro = await openIntro()
    await user.click(within(intro).getByRole('button', { name: 'Switch this project…' }))
    const block = await screen.findByTestId('switchover-failure')
    expect(block).toHaveAttribute('role', 'alert')
    expect(block).toHaveTextContent('What failed: The backup')
    expect(block).toHaveTextContent('Could not make the backup: ENOTDIR.')
    expect(block).toHaveTextContent(
      'Nothing was changed: this project still uses the old story memory.'
    )
    expect(block).toHaveTextContent(
      'Next: Choose another backup folder in Settings › Backups, then try again.'
    )
    expect(useSwitchoverStore.getState().phase).toBe('intro')
    expect(channels()).not.toContain('switchover:plan')
    await user.click(within(block).getByRole('button', { name: 'Try again' }))
    await screen.findByRole('dialog', { name: 'Switch-over dry run' })
    expect(channels().filter((c) => c === 'switchover:safety')).toHaveLength(2)
    expect(screen.queryByTestId('switchover-failure')).toBeNull()
  })

  it('goes back to the consent screen with the block when the conversion fails, and converts on Try again', async () => {
    convertFailures = [CONVERT_FAILED]
    const user = userEvent.setup()
    const intro = await openIntro()
    await user.click(within(intro).getByRole('button', { name: 'Switch this project…' }))
    await user.click(await screen.findByRole('button', { name: 'Next' }))
    await user.click(await screen.findByRole('button', { name: 'Convert' }))
    const block = await screen.findByTestId('switchover-failure')
    expect(block).toHaveTextContent('What failed: The conversion')
    expect(block).toHaveTextContent('The conversion stopped and undid everything: disk full.')
    expect(block).toHaveTextContent(`Next: Try again. If it stops again, your backup is ${BACKUP}`)
    expect(useSwitchoverStore.getState().phase).toBe('consent')
    expect(screen.getByRole('button', { name: 'Convert' })).toBeEnabled()
    // Nothing converted, so nothing reopens.
    expect(channels()).not.toContain('project:open')
    await user.click(within(block).getByRole('button', { name: 'Try again' }))
    await screen.findByRole('dialog', { name: 'Switched over' })
    expect(channels().filter((c) => c === 'switchover:convert')).toHaveLength(2)
  })

  it('offers no Try again when the open project changed, whose next step is to start again', async () => {
    convertFailures = [
      {
        ok: false,
        step: 'project',
        message:
          'The open project changed during the switch-over. Nothing was changed: this project still uses the old story memory.',
        nextStep: 'Open the project again and start from Help › Switch to the new story memory….'
      }
    ]
    const user = userEvent.setup()
    const intro = await openIntro()
    await user.click(within(intro).getByRole('button', { name: 'Switch this project…' }))
    await user.click(await screen.findByRole('button', { name: 'Next' }))
    await user.click(await screen.findByRole('button', { name: 'Convert' }))
    const block = await screen.findByTestId('switchover-failure')
    expect(block).toHaveTextContent('What failed: The project')
    expect(within(block).queryByRole('button', { name: 'Try again' })).toBeNull()
  })

  it('converts with the edited words, the ticked merge and the project id, reopens the same folder, and shows the final screen', async () => {
    useCloudSyncStore.setState({ status: DRIVE })
    const user = userEvent.setup()
    const intro = await openIntro()
    await user.click(within(intro).getByRole('button', { name: 'Switch this project…' }))
    await user.click(
      await screen.findByRole('checkbox', {
        name: 'Merge Mara (character) into Mara Vell (character)'
      })
    )
    await user.click(screen.getByRole('button', { name: 'Next' }))
    const field = await screen.findByRole('textbox', { name: 'Replacement for #mara' })
    await user.clear(field)
    await user.type(field, 'Mara')
    await user.click(screen.getByRole('button', { name: 'Convert' }))
    const done = await screen.findByRole('dialog', { name: 'Switched over' })
    expect(calls.find((call) => call.channel === 'switchover:convert')?.input).toEqual({
      consent: {
        replacements: [{ key: 't-1', text: 'Mara' }],
        merges: [{ keep: 'entity:1', merge: 'tag:2' }]
      } satisfies SwitchoverConsent,
      projectId: 'real'
    })
    expect(calls).toContainEqual({ channel: 'project:open', input: { path: ORIGINAL.path } })
    await waitFor(() => expect(useProjectStore.getState().current?.storyMemory).toBe('v2'))
    expect(screen.getByTestId('switchover-done')).toHaveTextContent(
      'Your project now uses the new story memory: 2 records, 1 label, 0 Research documents, 2 inline tags as words.'
    )
    expect(screen.getByTestId('switchover-backup')).toHaveTextContent(
      `Backup: ${BACKUP} (kept until you delete it)`
    )
    expect(screen.getByTestId('switchover-dated-copy')).toHaveTextContent(
      `Dated copy (in Google Drive): ${DATED}`
    )
    const back = screen.getByTestId('switchover-go-back')
    // Named as the Backups list shows it: its date, marked kept (the list shows no file names).
    const made = backupWhen(new Date(2026, 9, 14, 10, 15, 0).toISOString())
    expect(back).toHaveTextContent(
      `To go back: in Settings › Backups choose Restore on the backup from ${made} marked (kept: before story memory).`
    )
    expect(back).toHaveTextContent('You can also open the dated copy with File › Open project….')
    expect(screen.queryByTestId('switchover-original')).toBeNull()
    expect(within(done).queryByRole('button', { name: 'Open my project' })).toBeNull()
    await user.click(within(done).getByRole('button', { name: 'Show backups' }))
    await waitFor(() => expect(channels()).toContain('backups:reveal'))
    // The rebuild is offered (slice 4), so the way out is Later.
    await user.click(within(done).getByRole('button', { name: 'Later' }))
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('says the project is switched when only the reopen fails', async () => {
    reopen = () => {
      throw new Error('The folder is busy.')
    }
    const user = userEvent.setup()
    const intro = await openIntro()
    await user.click(within(intro).getByRole('button', { name: 'Switch this project…' }))
    await user.click(await screen.findByRole('button', { name: 'Next' }))
    await user.click(await screen.findByRole('button', { name: 'Convert' }))
    await screen.findByRole('dialog', { name: 'Switched over' })
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Your project is switched, but it did not open again: The folder is busy. Open it from File › Open project….'
    )
    expect(screen.queryByRole('button', { name: 'Convert' })).toBeNull()
    expect(channels().filter((c) => c === 'switchover:convert')).toHaveLength(1)
  })

  it('says nothing changed and where both copies are when the author cancels after the safety step', async () => {
    const user = userEvent.setup()
    const intro = await openIntro()
    await user.click(within(intro).getByRole('button', { name: 'Switch this project…' }))
    await user.click(await screen.findByRole('button', { name: 'Next' }))
    await screen.findByRole('button', { name: 'Convert' })
    await user.click(screen.getByRole('button', { name: 'Back' }))
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    const cancelled = `Nothing was changed. The backup and the dated copy made a moment ago stay where they are: ${BACKUP} · ${DATED}`
    expect(useDialogStore.getState().toasts.map((t) => t.message)).toEqual([cancelled])
    expect(channels()).not.toContain('switchover:convert')
    // Main's held v1 jobs go again.
    expect(channels().at(-1)).toBe('switchover:leave')

    // The consent screen has its own Cancel beside Back and Convert.
    useDialogStore.setState({ toasts: [] })
    await useSwitchoverStore.getState().open()
    await user.click(await screen.findByRole('button', { name: 'Switch this project…' }))
    await user.click(await screen.findByRole('button', { name: 'Next' }))
    const consent = await screen.findByRole('dialog', { name: 'Inline tags become words' })
    await user.click(within(consent).getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(useDialogStore.getState().toasts.map((t) => t.message)).toEqual([cancelled])
    expect(channels()).not.toContain('switchover:convert')
  })
})

describe('SwitchoverDialog: a copy first (F-16.15)', () => {
  it('makes the copy, converts it, names the original and opens it on Open my project', async () => {
    const user = userEvent.setup()
    const intro = await openIntro()
    await user.click(within(intro).getByRole('button', { name: 'Try it on a copy first' }))
    const dryRun = await screen.findByRole('dialog', { name: 'Switch-over dry run' })
    expect(useProjectStore.getState().current?.id).toBe('copy')
    expect(dryRun).toHaveTextContent('This is a test copy; nothing has changed yet.')
    expect(channels()).not.toContain('switchover:safety')
    expect(screen.getByRole('list', { name: 'Dropped' })).toHaveTextContent('#reeds')
    expect(dryRun).toHaveTextContent('Personality: Stubborn')
    await user.click(screen.getByRole('button', { name: 'Next' }))
    expect(await screen.findByTestId('switchover-consent-last')).toHaveTextContent(
      'Only this test copy changes; the project it was made from stays as it is.'
    )
    // A row left blank is sent with its proposed words.
    await user.clear(screen.getByRole('textbox', { name: 'Replacement for #mara' }))
    await user.click(screen.getByRole('button', { name: 'Convert' }))
    const done = await screen.findByRole('dialog', { name: 'Switched over' })
    expect(calls.find((call) => call.channel === 'switchover:convert')?.input).toEqual({
      consent: { replacements: [{ key: 't-1', text: 'mara' }], merges: [] },
      projectId: 'copy'
    })
    expect(screen.getByTestId('switchover-done')).toHaveTextContent(
      'This test copy now uses the new story memory: 2 records'
    )
    expect(screen.getByTestId('switchover-original')).toHaveTextContent(
      `Your project at ${ORIGINAL.path} is unchanged and still uses the old one.`
    )
    expect(screen.queryByTestId('switchover-backup')).toBeNull()
    expect(screen.queryByTestId('switchover-go-back')).toBeNull()
    await user.click(within(done).getByRole('button', { name: 'Open my project' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    await waitFor(() => expect(useProjectStore.getState().current?.id).toBe('real'))
    expect(calls.at(-2)).toEqual({ channel: 'project:open', input: { path: ORIGINAL.path } })
    expect(useProjectStore.getState().current?.storyMemory).toBe('v1')
  })

  it('opens the author’s project again when she leaves the copy it made before the end', async () => {
    const user = userEvent.setup()
    const intro = await openIntro()
    await user.click(within(intro).getByRole('button', { name: 'Try it on a copy first' }))
    const dryRun = await screen.findByRole('dialog', { name: 'Switch-over dry run' })
    expect(useProjectStore.getState().current?.id).toBe('copy')
    await user.click(within(dryRun).getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    await waitFor(() => expect(useProjectStore.getState().current?.id).toBe('real'))
    expect(calls).toContainEqual({ channel: 'project:open', input: { path: ORIGINAL.path } })
    await waitFor(() =>
      expect(useDialogStore.getState().toasts.map((t) => t.message)).toEqual([
        `Your project is open again and unchanged. The test copy was not switched. It stays at ${COPY.path}.`
      ])
    )
    // A copy flow holds nothing in main.
    expect(channels()).not.toContain('switchover:leave')
  })

  it('offers Open my project when the author leaves a copy that was already open', async () => {
    useProjectStore.setState({ current: COPY })
    trial = { source: ORIGINAL.path, createdAt: '2026-10-12T09:00:00.000Z' }
    const user = userEvent.setup()
    const intro = await openIntro()
    await within(intro).findByRole('button', { name: 'Switch this copy…' })
    await user.click(within(intro).getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    // She opened the copy herself: it stays open, and the toast offers the way back.
    expect(useProjectStore.getState().current?.id).toBe('copy')
    const [shown] = useDialogStore.getState().toasts
    expect(shown?.message).toBe(
      `You are working in the test copy. It stays at ${COPY.path}. Your project at ${ORIGINAL.path} is unchanged.`
    )
    expect(shown?.action?.label).toBe('Open my project')
    shown?.action?.run()
    await waitFor(() => expect(useProjectStore.getState().current?.id).toBe('real'))
  })

  it('settles the open project before the copy, as every project switch does', async () => {
    const user = userEvent.setup()
    const intro = await openIntro()
    await user.click(within(intro).getByRole('button', { name: 'Try it on a copy first' }))
    await screen.findByRole('dialog', { name: 'Switch-over dry run' })
    const order = channels()
    expect(order.indexOf('project:cloudSyncNow')).toBeLessThan(
      order.indexOf('switchover:trialCopy')
    )
  })

  it('says what the rebuild costs on each source', () => {
    // In cents, as the final screen and the rebuild dialog price the same rebuild.
    expect(rebuildLine({ ...PLAN.rebuild, source: 'local' })).toBe(
      'Rebuild memory: 3 scenes, free on your local model, about a minute.'
    )
    expect(rebuildLine({ ...PLAN.rebuild, scenes: 0 })).toBe('Rebuild memory: nothing to read yet.')
    expect(rebuildLine({ ...PLAN.rebuild, source: 'cloud', costUsd: 0.136, minutes: 12 })).toBe(
      'Rebuild memory: 3 scenes, about 14¢ from your MythScribe Cloud balance, about 12 minutes. It asks before it starts.'
    )
    expect(rebuildLine({ ...PLAN.rebuild, source: 'cloud', priced: false })).toContain(
      'a cost not yet known (MythScribe Cloud has no price for a model story memory uses)'
    )
  })
})

/** Runs the switch-over of the project itself to its final screen. */
async function switchToDone(): Promise<HTMLElement> {
  const user = userEvent.setup()
  const intro = await openIntro()
  await user.click(within(intro).getByRole('button', { name: 'Switch this project…' }))
  await user.click(await screen.findByRole('button', { name: 'Next' }))
  await user.click(await screen.findByRole('button', { name: 'Convert' }))
  return screen.findByRole('dialog', { name: 'Switched over' })
}

/** The ask once it has read the status, the settings and (when it may) the price. */
async function settledAsk(): Promise<HTMLElement> {
  const ask = await screen.findByTestId('switchover-rebuild-ask')
  await waitFor(() => expect(ask).not.toHaveTextContent('Working out'))
  return ask
}

describe('SwitchoverDialog: the rebuild ask (F-16.31 part A, Switch-over slice 4)', () => {
  it('on an own key, asks with the price and Rebuild now starts it and opens the rebuild dialog on its progress', async () => {
    const done = await switchToDone()
    const ask = await settledAsk()
    expect(ask).toHaveTextContent(
      'Rebuild memory now: the AI reads 12 scenes once, about 4¢ on your own key (about 2 minutes). Your text, Pinned, Ideas and Dismissed stay as they are.'
    )
    // The reads come after the reopen, the price only once reading may run; nothing is started.
    const order = channels()
    expect(order.indexOf('memory:status')).toBeGreaterThan(order.indexOf('project:open'))
    expect(order).toContain('aiSettings:get')
    expect(order.indexOf('memory:rebuildEstimate')).toBeGreaterThan(order.indexOf('memory:status'))
    expect(order).not.toContain('memory:rebuild')
    expect(within(done).getByRole('button', { name: 'Later' })).toHaveFocus()
    expect(within(done).queryByRole('button', { name: 'Close' })).toBeNull()
    await userEvent.click(within(ask).getByRole('button', { name: 'Rebuild now' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(channels().filter((c) => c === 'memory:rebuild')).toHaveLength(1)
    // The rebuild dialog opens watching the run (P2a's progress, Stop, the grouped summary).
    expect(useMemoryStore.getState().rebuildOpen).toBe('summary')
    expect(useMemoryStore.getState().status?.rebuild?.finishedAt).toBeNull()
    expect(channels().at(-1)).not.toBe('memory:rebuild')
  })

  it('on Cloud, asks from the balance and says the monthly cap does not count it and today’s cap still applies', async () => {
    settings = { ...defaultAiSettings(), dial: 1, source: 'cloud' }
    estimate = { ...ESTIMATE, source: 'cloud', costUsd: 0.05 }
    await switchToDone()
    const ask = await settledAsk()
    expect(ask).toHaveTextContent(
      'Rebuild memory now: the AI reads 12 scenes once, about 5¢ from your MythScribe Cloud balance (about 2 minutes).'
    )
    expect(ask).toHaveTextContent(
      'It is not counted toward your monthly reading cap; today’s AI spending cap still applies, so a long book may finish tomorrow.'
    )
    expect(within(ask).getByRole('button', { name: 'Rebuild now' })).toBeEnabled()
  })

  it('on Cloud without a price for its model, offers no Rebuild button and says what to do (SW-D9)', async () => {
    settings = { ...defaultAiSettings(), dial: 1, source: 'cloud' }
    estimate = { ...ESTIMATE, source: 'cloud', priced: false }
    const done = await switchToDone()
    const ask = await settledAsk()
    // Main's own refusal word for word (it would refuse the start too), then where it is offered.
    expect(ask).toHaveTextContent(
      'MythScribe Cloud has no price for a model story memory uses (deepseek/deepseek-v4-flash, deepseek/deepseek-v4-pro), so Rebuild memory does not start: on Cloud it starts only with its price. Pick another model in Settings › AI, or reset the models to their defaults. Then This scene › Needs a look offers Rebuild memory with its price.'
    )
    expect(within(done).queryByRole('button', { name: 'Rebuild now' })).toBeNull()
    expect(within(done).getByRole('button', { name: 'Later' })).toBeEnabled()
  })

  it('on an own key with a model not in the price table, says the cost is not known and may still start', async () => {
    estimate = { ...ESTIMATE, priced: false }
    await switchToDone()
    const ask = await settledAsk()
    expect(ask).toHaveTextContent(
      'the AI reads 12 scenes once, a cost not yet known (a model is not in the price table) on your own key'
    )
    expect(within(ask).getByRole('button', { name: 'Rebuild now' })).toBeEnabled()
  })

  it('on a local model, says it is free', async () => {
    settings = { ...defaultAiSettings(), dial: 1, source: 'local' }
    estimate = { ...ESTIMATE, source: 'local', costUsd: 0, minutes: 1 }
    await switchToDone()
    const ask = await settledAsk()
    expect(ask).toHaveTextContent(
      'Rebuild memory now: the AI reads 12 scenes once, free on your local model (about a minute).'
    )
    expect(within(ask).getByRole('button', { name: 'Rebuild now' })).toBeEnabled()
  })

  it('with Use AI off, offers no Rebuild button, asks no price and closes', async () => {
    settings = { ...defaultAiSettings(), dial: 0 }
    status = { ...STATUS, paused: 'off' }
    const done = await switchToDone()
    const ask = await settledAsk()
    expect(ask).toHaveTextContent(
      'Use AI is off, so nothing is read and nothing is spent. When you turn it on in Settings › AI, This scene › Needs a look offers Rebuild memory with its price.'
    )
    expect(within(done).queryByRole('button', { name: 'Rebuild now' })).toBeNull()
    expect(channels()).not.toContain('memory:rebuildEstimate')
    await userEvent.click(within(done).getByRole('button', { name: 'Close' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(channels()).not.toContain('memory:rebuild')
    expect(useMemoryStore.getState().rebuildOpen).toBeNull()
  })

  it('with Use AI on and the reading switch off, says so', async () => {
    status = { ...STATUS, paused: 'off' }
    await switchToDone()
    expect(await settledAsk()).toHaveTextContent(
      'Story memory reading is off, so nothing is read and nothing is spent. When you turn it on in Settings › AI,'
    )
    expect(screen.queryByRole('button', { name: 'Rebuild now' })).toBeNull()
  })

  it('with no provider, says to add a key or sign in, and that Needs a look then offers it', async () => {
    status = { ...STATUS, paused: 'noProvider' }
    const done = await switchToDone()
    expect(await settledAsk()).toHaveTextContent(
      'Story memory needs an AI provider: add a key or sign in to MythScribe Cloud in Settings › AI. Needs a look then offers Rebuild memory with its price.'
    )
    expect(within(done).queryByRole('button', { name: 'Rebuild now' })).toBeNull()
    expect(within(done).getByRole('button', { name: 'Close' })).toBeEnabled()
    expect(channels()).not.toContain('memory:rebuildEstimate')
  })

  it('shows a refused start with its next step and keeps Later and the dialog', async () => {
    started = {
      ok: false,
      code: 'DISABLED',
      message: 'Story memory paused: this model’s readings aren’t reliable enough.',
      nextStep: 'Switch to DeepSeek V4 Flash in Settings › AI.'
    }
    const done = await switchToDone()
    const ask = await settledAsk()
    await userEvent.click(within(ask).getByRole('button', { name: 'Rebuild now' }))
    expect(await within(ask).findByRole('alert')).toHaveTextContent(
      'Story memory paused: this model’s readings aren’t reliable enough. Switch to DeepSeek V4 Flash in Settings › AI.'
    )
    expect(screen.getByRole('dialog', { name: 'Switched over' })).toBe(done)
    expect(within(done).getByRole('button', { name: 'Later' })).toBeEnabled()
    expect(within(ask).getByRole('button', { name: 'Rebuild now' })).toBeEnabled()
    expect(useMemoryStore.getState().rebuildOpen).toBeNull()
    // Later closes; the notice in Needs a look takes it up.
    await userEvent.click(within(done).getByRole('button', { name: 'Later' }))
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('holds Later, Close and Escape while Rebuild now starts, then opens the rebuild’s progress', async () => {
    let release = (): void => undefined
    holdRebuild = new Promise((resolve) => {
      release = resolve
    })
    const done = await switchToDone()
    const ask = await settledAsk()
    await userEvent.click(within(ask).getByRole('button', { name: 'Rebuild now' }))
    expect(within(ask).getByRole('button', { name: 'Starting…' })).toBeDisabled()
    expect(within(done).getByRole('button', { name: 'Later' })).toBeDisabled()
    fireEvent.keyDown(done, { key: 'Escape' })
    expect(screen.getByRole('dialog', { name: 'Switched over' })).toBe(done)
    release()
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(useMemoryStore.getState().rebuildOpen).toBe('summary')
  })

  it('with today’s AI spending cap reached, waits with no Rebuild button and says when it is offered', async () => {
    status = { ...STATUS, paused: 'dailyCap' }
    const done = await switchToDone()
    expect(await settledAsk()).toHaveTextContent(
      'Today’s AI spending cap is reached, so Rebuild memory waits and nothing more is spent today. When you raise the cap in Settings › AI, or tomorrow, This scene › Needs a look offers Rebuild memory with its price.'
    )
    expect(within(done).queryByRole('button', { name: 'Rebuild now' })).toBeNull()
    expect(within(done).getByRole('button', { name: 'Later' })).toBeEnabled()
    expect(channels()).not.toContain('memory:rebuildEstimate')
  })

  it('offers nothing for a book with no scene to read', async () => {
    estimate = { ...ESTIMATE, scenes: 0 }
    const done = await switchToDone()
    expect(await settledAsk()).toHaveTextContent('Rebuild memory: nothing to read yet.')
    expect(within(done).queryByRole('button', { name: 'Rebuild now' })).toBeNull()
    expect(within(done).getByRole('button', { name: 'Close' })).toBeEnabled()
  })

  it('says why when the price cannot be read, and that Needs a look offers it', async () => {
    estimateFails = true
    const done = await switchToDone()
    expect(await settledAsk()).toHaveTextContent(
      'Could not work out what Rebuild memory would cost: The project is busy. This scene › Needs a look offers Rebuild memory with its price.'
    )
    expect(within(done).queryByRole('button', { name: 'Rebuild now' })).toBeNull()
  })

  it('asks nothing when the reopen fails', async () => {
    reopen = () => {
      throw new Error('The folder is busy.')
    }
    await switchToDone()
    expect(screen.queryByTestId('switchover-rebuild-ask')).toBeNull()
    expect(channels()).not.toContain('memory:status')
  })

  it('asks on a test copy too, beside Open my project', async () => {
    const user = userEvent.setup()
    const intro = await openIntro()
    await user.click(within(intro).getByRole('button', { name: 'Try it on a copy first' }))
    await user.click(await screen.findByRole('button', { name: 'Next' }))
    await user.click(await screen.findByRole('button', { name: 'Convert' }))
    const done = await screen.findByRole('dialog', { name: 'Switched over' })
    const ask = await settledAsk()
    expect(ask).toHaveTextContent('Rebuild memory now: the AI reads 12 scenes once')
    // It reads the copy only: switching the project later asks for its own rebuild again.
    expect(ask).toHaveTextContent(
      'This reads the test copy only: when you switch your project, it needs its own Rebuild memory, at about the same price.'
    )
    expect(within(done).getByRole('button', { name: 'Open my project' })).toHaveFocus()
    expect(within(done).getByRole('button', { name: 'Close' })).toBeEnabled()
    expect(within(ask).getByRole('button', { name: 'Rebuild now' })).toBeEnabled()
  })
})
