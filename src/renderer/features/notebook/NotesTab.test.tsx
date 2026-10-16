import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { CalendarRange, ListTree } from 'lucide-react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Channel, Input, Output } from '@shared/ipc/contract'
import { resetAppAccessStore } from '@renderer/features/account/appAccessStore'
import { resetAiSettingsStore } from '@renderer/features/ai/aiSettingsStore'
import { resetPendingSaves } from '@renderer/features/project/pendingSaves'
import { resetLayoutStore, useLayoutStore } from '@renderer/features/shell/layoutStore'
import { setIpcClient, type IpcClient } from '@renderer/lib/ipc'
import { resetNotebookStore } from './notebookStore'
import { NotesTab, type NotesView } from './NotesTab'

/** Structure A (2026-10-16): the views that live under Notes in the fresh start, above its tree. */

const views: readonly NotesView[] = [
  { id: 'outline', label: 'Outline', icon: ListTree },
  { id: 'timeline', label: 'Timeline', icon: CalendarRange }
]

const client: IpcClient = {
  async invoke<C extends Channel>(channel: C, input: Input<C>): Promise<Output<C>> {
    if (channel === 'layout:set') return input as Output<C>
    throw new Error(`unexpected ${channel}`)
  },
  on: () => () => {}
}

describe('NotesTab views (structure A)', () => {
  beforeEach(() => {
    resetPendingSaves()
    resetLayoutStore()
    resetNotebookStore()
    resetAppAccessStore()
    resetAiSettingsStore()
    setIpcClient(client)
  })

  afterEach(() => {
    resetLayoutStore()
    resetNotebookStore()
  })

  it('shows Outline and Timeline as the large folders at the top of the tree; one opens its section', async () => {
    const user = userEvent.setup()
    render(<NotesTab views={views} />)
    const group = screen.getByRole('group', { name: 'Views' })
    expect(
      within(group)
        .getAllByRole('button')
        .map((b) => b.textContent)
    ).toEqual(['Outline', 'Timeline'])
    expect(
      screen.getByRole('toolbar', { name: 'Notes' }).compareDocumentPosition(group) &
        Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy()
    await user.click(within(group).getByRole('button', { name: 'Timeline' }))
    expect(useLayoutStore.getState().layout.sidebar.tab).toBe('timeline')
  })

  it('lists no views outside the fresh start', () => {
    render(<NotesTab />)
    expect(screen.queryByRole('group', { name: 'Views' })).not.toBeInTheDocument()
    expect(screen.getByRole('toolbar', { name: 'Notes' })).toBeInTheDocument()
  })
})
