import { render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Channel, Input, Output } from '@shared/ipc/contract'
import type { NotebookItem } from '@shared/notebook'
import { resetAppAccessStore } from '@renderer/features/account/appAccessStore'
import { resetAiSettingsStore } from '@renderer/features/ai/aiSettingsStore'
import { resetPendingSaves } from '@renderer/features/project/pendingSaves'
import { resetLayoutStore } from '@renderer/features/shell/layoutStore'
import { setIpcClient, type IpcClient } from '@renderer/lib/ipc'
import { resetNotebookStore, useNotebookStore } from './notebookStore'
import { NotesTab } from './NotesTab'

/**
 * The notes binder (2026-10-16): the Notes tab's tree opens on its three sections, Outline,
 * Timeline and Documents; structure A's "Views" rows (the old Outline and Timeline views) are gone.
 */

const item = (
  id: string,
  parentId: string | null,
  position: number,
  role: NotebookItem['role'] = null
): NotebookItem => ({
  id,
  parentId,
  kind: 'folder',
  title: id,
  position,
  modified: '2026-10-16T00:00:00.000Z',
  role
})

const ITEMS: NotebookItem[] = [
  item('Outline', null, 0, 'outline'),
  item('Timeline', null, 1, 'timeline'),
  item('Documents', null, 2, 'documents'),
  item('Characters', 'Documents', 0)
]

const client: IpcClient = {
  async invoke<C extends Channel>(channel: C, input: Input<C>): Promise<Output<C>> {
    if (channel === 'layout:set') return input as Output<C>
    if (channel === 'notebook:list') return ITEMS as Output<C>
    throw new Error(`unexpected ${channel}`)
  },
  on: () => () => {}
}

describe('NotesTab (the notes binder)', () => {
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

  it('shows the three sections at the top of the tree and no Views rows', async () => {
    await useNotebookStore.getState().load()
    render(<NotesTab />)
    expect(screen.queryByRole('group', { name: 'Views' })).not.toBeInTheDocument()
    expect(screen.getByRole('toolbar', { name: 'Notes' })).toBeInTheDocument()
    const tree = screen.getByRole('tree', { name: 'Notes' })
    const top = within(tree)
      .getAllByRole('treeitem')
      .filter((row) => row.getAttribute('aria-level') === '1')
    expect(top.map((row) => row.getAttribute('aria-label'))).toEqual([
      'Outline',
      'Timeline',
      'Documents'
    ])
    // Documents holds a folder, so the starter set is not offered.
    expect(screen.queryByRole('button', { name: 'Start with folders' })).not.toBeInTheDocument()
  })
})
