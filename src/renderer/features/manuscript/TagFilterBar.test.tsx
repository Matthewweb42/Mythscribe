import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it } from 'vitest'
import type { Channel, Input, Output } from '@shared/ipc/contract'
import { useDialogStore } from '@renderer/features/shell/dialogs/dialogStore'
import {
  resetDocumentTagStore,
  useDocumentTagStore
} from '@renderer/features/tags/documentTagStore'
import { tagFixture } from '@renderer/features/tags/tagFixture'
import { resetTagStore, useTagStore } from '@renderer/features/tags/tagStore'
import { IpcRequestError, setIpcClient, type IpcClient } from '@renderer/lib/ipc'
import { TagFilterBar } from './TagFilterBar'
import { treeFixture } from './treeFixture'
import { buildIndex, useTreeStore } from './treeStore'

type Links = Output<'documentTag:listAll'>

/** Answers `documentTag:listAll` with `links` (or throws `fail`) and records every call. */
function install(links: Links, fail?: string): [Channel, unknown][] {
  const calls: [Channel, unknown][] = []
  const client: IpcClient = {
    async invoke<C extends Channel>(channel: C, input: Input<C>): Promise<Output<C>> {
      calls.push([channel, input])
      if (channel !== 'documentTag:listAll') throw new Error(`unexpected ${channel}`)
      if (fail !== undefined) throw new IpcRequestError({ code: 'NO_PROJECT', message: fail })
      return links as Output<C>
    },
    on: () => () => {}
  }
  setIpcClient(client)
  return calls
}

const bar = (): HTMLElement => screen.getByRole('combobox', { name: 'Filter by tag' })
const toasts = (): string[] => useDialogStore.getState().toasts.map((t) => t.message)

beforeEach(() => {
  useTreeStore.getState().clear()
  resetTagStore()
  resetDocumentTagStore()
  useDialogStore.setState({ modals: [], toasts: [] })
  useTreeStore.setState({ ...buildIndex(treeFixture), loaded: true })
  useTagStore.setState({
    byId: Object.fromEntries(tagFixture.map((tag) => [tag.id, tag])),
    ids: tagFixture.map((tag) => tag.id)
  })
})

describe('TagFilterBar (F-4.10)', () => {
  it('renders nothing while the tag bank is empty', () => {
    resetTagStore()
    install([])
    const { container } = render(<TagFilterBar />)
    expect(container).toBeEmptyDOMElement()
  })

  it('groups the bank by category under an "All documents" option', () => {
    install([])
    render(<TagFilterBar />)
    expect(bar()).toHaveValue('')
    const groups = Array.from(bar().querySelectorAll('optgroup')).map((group) => [
      group.label,
      Array.from(group.querySelectorAll('option')).map((option) => option.textContent)
    ])
    expect(groups).toEqual([
      ['Characters', ['mara']],
      ['Settings', ['dark-forest']],
      ['Tone', ['moody']]
    ])
    expect(screen.getByRole('option', { name: 'All documents' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Clear filter' })).not.toBeInTheDocument()
    expect(screen.queryByText(/carr(y|ies) #/)).not.toBeInTheDocument()
  })

  it('picking a tag reloads every link, filters the tree, and counts the matches', async () => {
    const calls = install([
      { nodeId: 'sc-2', tagId: 't-forest' },
      { nodeId: 'sc-4', tagId: 't-forest' },
      { nodeId: 'sc-1', tagId: 't-mara' }
    ])
    render(<TagFilterBar />)
    await userEvent.selectOptions(bar(), 't-forest')
    expect(calls).toEqual([['documentTag:listAll', undefined]])
    expect(useTreeStore.getState().tagFilter).toBe('t-forest')
    expect(useDocumentTagStore.getState().tagIdsByNode['sc-2']).toEqual(['t-forest'])
    expect(bar()).toHaveValue('t-forest')
    expect(screen.getByText('2 documents carry #dark-forest')).toBeInTheDocument()
  })

  it('counts one match and none in the singular and the empty form', async () => {
    install([{ nodeId: 'sc-2', tagId: 't-forest' }])
    render(<TagFilterBar />)
    await userEvent.selectOptions(bar(), 't-forest')
    expect(screen.getByText('1 document carries #dark-forest')).toBeInTheDocument()
    await userEvent.selectOptions(bar(), 't-moody')
    expect(screen.getByText('No documents carry #moody')).toBeInTheDocument()
  })

  it('Clear filter and "All documents" both restore the whole tree', async () => {
    install([{ nodeId: 'sc-2', tagId: 't-forest' }])
    render(<TagFilterBar />)
    await userEvent.selectOptions(bar(), 't-forest')
    await userEvent.click(screen.getByRole('button', { name: 'Clear filter' }))
    expect(useTreeStore.getState().tagFilter).toBeNull()
    expect(bar()).toHaveValue('')
    expect(screen.queryByText(/carr(y|ies) #/)).not.toBeInTheDocument()
    await userEvent.selectOptions(bar(), 't-forest')
    expect(useTreeStore.getState().tagFilter).toBe('t-forest')
    await userEvent.selectOptions(bar(), '')
    expect(useTreeStore.getState().tagFilter).toBeNull()
  })

  it('a failed refresh toasts and still filters on what the store knows', async () => {
    install([], 'No project is open')
    useDocumentTagStore.setState({ tagIdsByNode: { 'sc-2': ['t-forest'] } })
    render(<TagFilterBar />)
    await userEvent.selectOptions(bar(), 't-forest')
    expect(toasts()).toEqual(['No project is open'])
    expect(useTreeStore.getState().tagFilter).toBe('t-forest')
    expect(screen.getByText('1 document carries #dark-forest')).toBeInTheDocument()
  })

  it('a filter set from elsewhere shows in the select', () => {
    install([])
    useDocumentTagStore.setState({ tagIdsByNode: { 'sc-2': ['t-mara'] } })
    render(<TagFilterBar />)
    act(() => useTreeStore.getState().setTagFilter('t-mara'))
    expect(bar()).toHaveValue('t-mara')
    expect(screen.getByText('1 document carries #mara')).toBeInTheDocument()
  })
})
