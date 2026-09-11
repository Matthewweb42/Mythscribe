import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { TreeNode } from '@shared/ipc/contract'
import { useDialogStore } from '@renderer/features/shell/dialogs/dialogStore'
import { setIpcClient, type IpcClient } from '@renderer/lib/ipc'
import { CreateNodeBar } from './CreateNodeBar'
import { treeFixture } from './treeFixture'
import { buildIndex, useTreeStore } from './treeStore'

const created: TreeNode = {
  id: 'new',
  parentId: 'ch-1',
  sectionType: null,
  kind: 'document',
  hierarchyLevel: 'scene',
  title: 'Untitled Scene',
  position: 1,
  wordCount: 0,
  matterType: null,
  preset: null,
  created: 'c',
  modified: 'm'
}

function install(result: TreeNode | Error): ReturnType<typeof vi.fn> {
  const invoke = vi.fn(async () => {
    if (result instanceof Error) throw result
    return result
  })
  const client: IpcClient = { invoke: invoke as IpcClient['invoke'], on: () => () => {} }
  setIpcClient(client)
  return invoke
}

const button = (name: string): HTMLElement => screen.getByRole('button', { name })

beforeEach(() => {
  useTreeStore.getState().clear()
  useDialogStore.setState({ modals: [], toasts: [] })
  useTreeStore.setState({ ...buildIndex(treeFixture), loaded: true })
})

describe('CreateNodeBar', () => {
  it('labels the buttons by format', () => {
    const { rerender } = render(<CreateNodeBar format="webnovel" />)
    expect(button('New scene')).toBeInTheDocument()
    expect(button('New chapter')).toBeInTheDocument()
    expect(button('New arc')).toBeInTheDocument()
    rerender(<CreateNodeBar format="novel" />)
    expect(button('New part')).toBeInTheDocument()
  })

  it('enables every level with nothing selected and with a scene selected', () => {
    render(<CreateNodeBar format="novel" />)
    expect(button('New scene')).toBeEnabled()
    expect(button('New chapter')).toBeEnabled()
    expect(button('New part')).toBeEnabled()
    act(() => useTreeStore.getState().select('sc-1'))
    expect(button('New scene')).toBeEnabled()
    expect(button('New part')).toBeEnabled()
  })

  it('disables all three with a front-matter row selected', () => {
    render(<CreateNodeBar format="novel" />)
    act(() => useTreeStore.getState().select('title-page'))
    expect(button('New scene')).toBeDisabled()
    expect(button('New chapter')).toBeDisabled()
    expect(button('New part')).toBeDisabled()
  })

  it('disables only the level that has no valid placement', () => {
    const emptyArc = treeFixture.filter((n) => n.parentId !== 'arc-2' && n.parentId !== 'ch-4')
    useTreeStore.setState({ ...buildIndex(emptyArc), loaded: true, selectedId: 'arc-2' })
    render(<CreateNodeBar format="novel" />)
    expect(button('New scene')).toBeDisabled()
    expect(button('New chapter')).toBeEnabled()
    expect(button('New part')).toBeEnabled()
  })

  it('disables the buttons while a request is in flight', () => {
    useTreeStore.setState({ busy: true })
    render(<CreateNodeBar format="novel" />)
    expect(button('New scene')).toBeDisabled()
  })

  it('creates a sibling scene after the selection', async () => {
    const invoke = install(created)
    useTreeStore.setState({ selectedId: 'sc-1' })
    render(<CreateNodeBar format="novel" />)
    await userEvent.click(button('New scene'))
    expect(invoke).toHaveBeenCalledWith('tree:create', {
      parentId: 'ch-1',
      afterId: 'sc-1',
      kind: 'document',
      hierarchyLevel: 'scene'
    })
    expect(useTreeStore.getState().childrenOf['ch-1']).toEqual(['sc-1', 'new'])
    expect(useTreeStore.getState().renamingId).toBe('new')
  })

  it('surfaces a failed create as a toast', async () => {
    install(new Error('Database is locked'))
    render(<CreateNodeBar format="novel" />)
    await userEvent.click(button('New chapter'))
    expect(useDialogStore.getState().toasts.map((t) => t.message)).toEqual(['Database is locked'])
    expect(useTreeStore.getState().busy).toBe(false)
  })
})
