import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { CloudSyncStatus } from '@shared/cloudSync'
import type { Channel, Input, Output, ProjectInfo } from '@shared/ipc/contract'
import type {
  SwitchoverConsent,
  SwitchoverFailure,
  SwitchoverPlan,
  SwitchoverSafetyOutcome
} from '@shared/memory/switchover'
import { resetBackupStore } from '@renderer/features/backups/backupStore'
import { resetCloudSyncStore, useCloudSyncStore } from '@renderer/features/project/cloudSyncStore'
import { useDialogStore } from '@renderer/features/shell/dialogs/dialogStore'
import { registerPendingSave, resetPendingSaves } from '@renderer/features/project/pendingSaves'
import { useProjectStore } from '@renderer/features/project/projectStore'
import { setIpcClient, type IpcClient } from '@renderer/lib/ipc'
import { SwitchoverDialog } from './SwitchoverDialog'
import { WHAT_CHANGES, rebuildLine } from './switchoverText'
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
        case 'recovery:list':
          return [] as Output<C>
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
    expect(within(list).getAllByRole('listitem').map((item) => item.textContent)).toEqual([
      ...WHAT_CHANGES
    ])
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
      'Rebuild memory: 3 scenes, about $0.03 on your own key, about 1 minute.'
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
    expect(back).toHaveTextContent(
      'To go back: in Settings › Backups choose Restore and pick “Book before story memory 2026-10-14 101500.zip”.'
    )
    expect(back).toHaveTextContent('You can also open the dated copy with File › Open project….')
    expect(screen.queryByTestId('switchover-original')).toBeNull()
    expect(within(done).queryByRole('button', { name: 'Open my project' })).toBeNull()
    await user.click(within(done).getByRole('button', { name: 'Show backups' }))
    await waitFor(() => expect(channels()).toContain('backups:reveal'))
    await user.click(within(done).getByRole('button', { name: 'Close' }))
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
    expect(useDialogStore.getState().toasts.map((t) => t.message)).toEqual([
      `Nothing was changed. The backup and the dated copy made a moment ago stay where they are: ${BACKUP} · ${DATED}`
    ])
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
    expect(rebuildLine({ ...PLAN.rebuild, source: 'local' })).toBe(
      'Rebuild memory: 3 scenes, free on your local model, about 1 minute.'
    )
    expect(rebuildLine({ ...PLAN.rebuild, scenes: 0 })).toBe('Rebuild memory: nothing to read yet.')
    expect(rebuildLine({ ...PLAN.rebuild, source: 'cloud', priced: false })).toContain(
      'a cost not yet known'
    )
  })
})
