import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Channel, Input, Output, ProjectInfo } from '@shared/ipc/contract'
import type { SwitchoverConsent, SwitchoverPlan } from '@shared/memory/switchover'
import { useDialogStore } from '@renderer/features/shell/dialogs/dialogStore'
import { registerPendingSave, resetPendingSaves } from '@renderer/features/project/pendingSaves'
import { useProjectStore } from '@renderer/features/project/projectStore'
import { setIpcClient, type IpcClient } from '@renderer/lib/ipc'
import { SwitchoverDialog } from './SwitchoverDialog'
import { rebuildLine } from './switchoverText'
import { resetSwitchoverStore, useSwitchoverStore } from './switchoverStore'

const INFO: ProjectInfo = {
  id: 'copy',
  name: 'Book (story memory test 2026-10-12 0900)',
  format: 'novel',
  path: '/tmp/Book (story memory test 2026-10-12 0900).mythscribe',
  created: 'c',
  modified: 'm',
  lastOpened: 'l',
  schemaVersion: 33,
  storyMemory: 'v1'
}

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

let calls: { channel: Channel; input: unknown }[]
/** What `project:open` does; a test makes it fail. */
let reopen: () => ProjectInfo

beforeEach(() => {
  resetSwitchoverStore()
  resetPendingSaves()
  useDialogStore.setState({ modals: [], toasts: [] })
  useProjectStore.setState({ current: null, busy: false })
  calls = []
  reopen = () => ({ ...INFO, storyMemory: 'v2' })
  const client: IpcClient = {
    async invoke<C extends Channel>(channel: C, input: Input<C>): Promise<Output<C>> {
      calls.push({ channel, input })
      switch (channel) {
        case 'switchover:trialCopy':
          return { folder: INFO.path, info: INFO } as Output<C>
        case 'switchover:plan':
          return PLAN as Output<C>
        case 'switchover:consent':
          return [
            { key: 't-1', tag: '#mara', count: 2, sample: 'Then #mara left.', replacement: 'mara' }
          ] as Output<C>
        case 'switchover:convert':
          return {
            folder: INFO.path,
            backup: '/backups/Book.zip',
            datedCopy: '/tmp/Book (before story memory 2026-10-12 0900).mythscribe',
            counts: {
              records: 2,
              labels: 0,
              research: 0,
              scenesWithDetails: 0,
              dismissals: 0,
              merged: 1,
              tokens: 2,
              documents: 1
            }
          } as Output<C>
        case 'project:open':
          return reopen() as Output<C>
        case 'project:cloudSyncNow':
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
  setIpcClient(null)
})

describe('SwitchoverDialog (F-16.15)', () => {
  it('makes the copy, shows the dry run, takes the edited words and the ticked merge, and reopens on v2', async () => {
    const user = userEvent.setup()
    render(<SwitchoverDialog />)
    await useSwitchoverStore.getState().start()
    expect(useProjectStore.getState().current?.id).toBe('copy')
    const dialog = await screen.findByRole('dialog', { name: 'Switch-over dry run' })
    expect(screen.getByRole('list', { name: 'Converted' })).toHaveTextContent(
      'Mara: Record (character): from its tag.'
    )
    expect(screen.getByRole('list', { name: 'Dropped' })).toHaveTextContent('#reeds')
    expect(dialog).toHaveTextContent('Personality: Stubborn')
    expect(screen.getByTestId('switchover-rebuild')).toHaveTextContent(
      'Rebuild memory: 3 scenes, about $0.03 on your own key, about 1 minute.'
    )
    const merge = screen.getByRole('checkbox', {
      name: 'Merge Mara (character) into Mara Vell (character)'
    })
    expect(merge).not.toBeChecked()
    await user.click(merge)

    await user.click(screen.getByRole('button', { name: 'Next' }))
    const field = await screen.findByRole('textbox', { name: 'Replacement for #mara' })
    expect(screen.getByTestId('switchover-consent')).toHaveTextContent('Then #mara left.')
    await user.clear(field)
    await user.type(field, 'Mara')
    await user.click(screen.getByRole('button', { name: 'Convert' }))

    await screen.findByRole('dialog', { name: 'Switched over' })
    const convert = calls.find((call) => call.channel === 'switchover:convert')
    expect(convert?.input).toEqual({
      replacements: [{ key: 't-1', text: 'Mara' }],
      merges: [{ keep: 'entity:1', merge: 'tag:2' }]
    } satisfies SwitchoverConsent)
    expect(calls).toContainEqual({ channel: 'project:open', input: { path: INFO.path } })
    await waitFor(() => expect(useProjectStore.getState().current?.storyMemory).toBe('v2'))
    expect(screen.getByTestId('switchover-done')).toHaveTextContent('2 records')
    await user.click(screen.getByRole('button', { name: 'Close' }))
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('sends a row left blank with its proposed words, and Cancel closes without converting', async () => {
    const user = userEvent.setup()
    render(<SwitchoverDialog />)
    await useSwitchoverStore.getState().start()
    await user.click(await screen.findByRole('button', { name: 'Next' }))
    await user.clear(await screen.findByRole('textbox', { name: 'Replacement for #mara' }))
    await user.click(screen.getByRole('button', { name: 'Back' }))
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(calls.some((call) => call.channel === 'switchover:convert')).toBe(false)

    await useSwitchoverStore.getState().start()
    await user.click(await screen.findByRole('button', { name: 'Next' }))
    await user.clear(await screen.findByRole('textbox', { name: 'Replacement for #mara' }))
    await user.click(screen.getByRole('button', { name: 'Convert' }))
    await screen.findByRole('dialog', { name: 'Switched over' })
    expect(calls.find((call) => call.channel === 'switchover:convert')?.input).toEqual({
      replacements: [{ key: 't-1', text: 'mara' }],
      merges: []
    })
  })

  it('settles the open project before the copy, and writes pending saves before converting', async () => {
    const user = userEvent.setup()
    useProjectStore.setState({ current: { ...INFO, id: 'original', name: 'Book' } })
    render(<SwitchoverDialog />)
    await useSwitchoverStore.getState().start()
    const order = calls.map((call) => call.channel)
    // The cloud copy of the original is offered first, as every project switch does.
    expect(order.indexOf('project:cloudSyncNow')).toBeLessThan(
      order.indexOf('switchover:trialCopy')
    )
    let flushed = 0
    registerPendingSave(async () => {
      flushed += 1
      calls.push({ channel: 'document:save', input: null })
    })
    await user.click(await screen.findByRole('button', { name: 'Next' }))
    await user.click(await screen.findByRole('button', { name: 'Convert' }))
    await screen.findByRole('dialog', { name: 'Switched over' })
    expect(flushed).toBeGreaterThan(0)
    const after = calls.map((call) => call.channel)
    expect(after.indexOf('document:save')).toBeLessThan(after.indexOf('switchover:convert'))
  })

  it('reports a failed reopen apart from the conversion, which is done', async () => {
    const user = userEvent.setup()
    reopen = () => {
      throw new Error('The folder is busy.')
    }
    render(<SwitchoverDialog />)
    await useSwitchoverStore.getState().start()
    await user.click(await screen.findByRole('button', { name: 'Next' }))
    await user.click(await screen.findByRole('button', { name: 'Convert' }))
    await screen.findByRole('dialog', { name: 'Switched over' })
    expect(screen.getByRole('alert')).toHaveTextContent(
      'The copy is converted, but it did not open again: The folder is busy. Open it from File › Open project….'
    )
    expect(screen.queryByRole('button', { name: 'Convert' })).toBeNull()
    expect(calls.filter((call) => call.channel === 'switchover:convert')).toHaveLength(1)
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
