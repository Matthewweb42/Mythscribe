import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Channel, Input, Output } from '@shared/ipc/contract'
import { EMPTY_SCENE_META } from '@shared/sceneMeta'
import type { Label, LabelLink } from '@shared/storyLabels'
import { UNAVAILABLE_SUMMARY } from '@shared/summary'
import { resetSceneMetaStore } from '@renderer/features/editor/sceneMetaStore'
import { resetSummaryStore } from '@renderer/features/editor/summaryStore'
import { ManuscriptTree } from '@renderer/features/manuscript/ManuscriptTree'
import { treeFixture } from '@renderer/features/manuscript/treeFixture'
import { buildIndex, useTreeStore } from '@renderer/features/manuscript/treeStore'
import { OutlineTab } from '@renderer/features/outline/OutlineTab'
import { resetOutlineViewStore } from '@renderer/features/outline/outlineViewStore'
import { resetPlanLinksStore } from '@renderer/features/outline/planLinksStore'
import { resetStructureStore } from '@renderer/features/outline/structureStore'
import { resetPendingSaves } from '@renderer/features/project/pendingSaves'
import { useProjectStore } from '@renderer/features/project/projectStore'
import { labelFixture } from '@renderer/features/records/recordFixture'
import { useDialogStore } from '@renderer/features/shell/dialogs/dialogStore'
import { setIpcClient } from '@renderer/lib/ipc'
import { LabelFilterBar } from './LabelFilterBar'
import { labelCountLabel } from './labelFilter'
import { LabelPicker } from './LabelPicker'
import { LabelsDialog } from './LabelsDialog'
import { linksByNode, resetLabelStore, useLabelStore } from './labelStore'

/**
 * F-16.7 (plan P1 §3), the labels of story memory v2: the label store (links grouped by node in
 * the author's order, a delete that clears its links and filters), the Labels dialog (create,
 * rename, kind, order, delete), the picker on a scene or Research page, and the label filter of
 * the Manuscript tree and the Outline.
 */

type Handler = (input: unknown) => unknown
let calls: [Channel, unknown][]

const WRY = labelFixture('l-wry', 'Wry', 0)
const GRIM = labelFixture('l-grim', 'Grim', 1, { colour: '#222222' })
const TW = labelFixture('l-tw', 'Violence', 2, { kind: 'content' })

const LINKS: LabelLink[] = [
  { labelId: 'l-grim', nodeId: 'sc-1' },
  { labelId: 'l-wry', nodeId: 'sc-1' },
  { labelId: 'l-wry', nodeId: 'sc-4' }
]

function install(overrides: Partial<Record<Channel, Handler>> = {}): void {
  calls = []
  setIpcClient({
    async invoke<C extends Channel>(channel: C, input: Input<C>): Promise<Output<C>> {
      calls.push([channel, input])
      const override = overrides[channel]
      if (override) return (await override(input)) as Output<C>
      if (channel === 'label:list') return [WRY, GRIM, TW] as Output<C>
      if (channel === 'label:links') return LINKS as Output<C>
      if (channel === 'sceneMeta:get') {
        const { id } = input as Input<'sceneMeta:get'>
        return { id, meta: { ...EMPTY_SCENE_META } } as Output<C>
      }
      if (channel === 'summary:get') return UNAVAILABLE_SUMMARY as Output<C>
      if (channel === 'planLinks:get') return { suggestions: [], aiApplied: [] } as Output<C>
      throw new Error(`unexpected ${channel}`)
    },
    on: () => () => {}
  })
}

const sent = (channel: Channel): unknown[] =>
  calls.filter(([each]) => each === channel).map(([, input]) => input)

const v2 = (): void =>
  useProjectStore.setState({
    current: {
      id: 'p-2',
      name: 'Memory',
      format: 'novel',
      path: '/books/Memory.mythscribe',
      created: 'c',
      modified: 'm',
      lastOpened: 'l',
      schemaVersion: 33,
      storyMemory: 'v2'
    }
  })

beforeEach(() => {
  install()
  resetLabelStore()
  resetPendingSaves()
  resetSceneMetaStore()
  resetSummaryStore()
  resetStructureStore()
  resetOutlineViewStore()
  resetPlanLinksStore()
  useDialogStore.setState({ modals: [], toasts: [] })
  useTreeStore.getState().clear()
  useTreeStore.setState({ ...buildIndex(treeFixture), loaded: true })
  v2()
})
afterEach(() => {
  resetLabelStore()
  resetSceneMetaStore()
  resetSummaryStore()
  resetPlanLinksStore()
  resetPendingSaves()
  useTreeStore.getState().clear()
  useProjectStore.setState({ current: null })
  setIpcClient(null)
})

describe('labelStore (F-16.7)', () => {
  it('groups the links by node in the author’s label order', async () => {
    expect(linksByNode(LINKS, [WRY, GRIM])).toEqual({
      'sc-1': ['l-wry', 'l-grim'],
      'sc-4': ['l-wry']
    })
    await act(() => useLabelStore.getState().load())
    expect(useLabelStore.getState().byNode).toEqual({
      'sc-1': ['l-wry', 'l-grim'],
      'sc-4': ['l-wry']
    })
  })

  it('assigns and unassigns from main’s answer, and a delete takes its links and filters', async () => {
    await act(() => useLabelStore.getState().load())
    install({
      'label:assign': () => [WRY, TW],
      'label:unassign': () => [TW],
      'label:delete': () => [GRIM, TW]
    })
    await act(() => useLabelStore.getState().assign('l-tw', 'sc-4'))
    expect(useLabelStore.getState().byNode['sc-4']).toEqual(['l-wry', 'l-tw'])
    await act(() => useLabelStore.getState().unassign('l-wry', 'sc-4'))
    expect(useLabelStore.getState().byNode['sc-4']).toEqual(['l-tw'])
    act(() => useLabelStore.getState().setFilter('outline', 'l-wry'))
    await act(() => useLabelStore.getState().remove('l-wry'))
    expect(useLabelStore.getState().labels.map((label) => label.id)).toEqual(['l-grim', 'l-tw'])
    expect(useLabelStore.getState().byNode['sc-1']).toEqual(['l-grim'])
    expect(useLabelStore.getState().filter.outline).toBeNull()
  })
})

describe('LabelsDialog (F-16.7)', () => {
  it('creates a label with its kind, renames, changes the kind, moves and deletes one', async () => {
    await act(() => useLabelStore.getState().load())
    const made = labelFixture('l-new', 'Tender', 3)
    let labels: Label[] = [WRY, GRIM, TW]
    install({
      'label:create': () => {
        labels = [...labels, made]
        return made
      },
      'label:update': (input) => {
        const { id, ...patch } = input as Input<'label:update'>
        const next = { ...(labels.find((label) => label.id === id) ?? WRY), ...patch }
        labels = labels.map((label) => (label.id === id ? next : label))
        return next
      },
      'label:reorder': (input) => {
        const { ids } = input as Input<'label:reorder'>
        labels = ids.flatMap((id, position) => {
          const label = labels.find((each) => each.id === id)
          return label === undefined ? [] : [{ ...label, position }]
        })
        return labels
      },
      'label:delete': (input) => {
        labels = labels.filter((label) => label.id !== (input as Input<'label:delete'>).id)
        return labels
      }
    })
    act(() => useLabelStore.getState().openManager())
    render(<LabelsDialog />)
    const dialog = screen.getByRole('dialog', { name: 'Labels' })
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'New label name' }), {
      target: { value: 'Tender' }
    })
    fireEvent.change(within(dialog).getByRole('combobox', { name: 'New label kind' }), {
      target: { value: 'tone' }
    })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add' }))
    await waitFor(() => expect(sent('label:create')).toEqual([{ name: 'Tender', kind: 'tone' }]))
    await screen.findByRole('listitem', { name: 'Tender' })

    const name = screen.getByRole('textbox', { name: 'Name of Wry' })
    fireEvent.change(name, { target: { value: 'Dry' } })
    fireEvent.blur(name)
    await waitFor(() => expect(sent('label:update')).toEqual([{ id: 'l-wry', name: 'Dry' }]))
    fireEvent.change(await screen.findByRole('combobox', { name: 'Kind of Grim' }), {
      target: { value: 'theme' }
    })
    await waitFor(() =>
      expect(sent('label:update')).toContainEqual({ id: 'l-grim', kind: 'theme' })
    )
    fireEvent.click(screen.getByRole('button', { name: 'Move Grim up' }))
    await waitFor(() =>
      expect(sent('label:reorder')).toEqual([{ ids: ['l-grim', 'l-wry', 'l-tw', 'l-new'] }])
    )
    expect(screen.getByRole('button', { name: 'Move Grim up' })).toBeDisabled()

    fireEvent.click(screen.getByRole('button', { name: 'Delete Violence' }))
    const modal = await waitFor(() => {
      const open = useDialogStore.getState().modals[0]
      if (open === undefined) throw new Error('no confirm yet')
      return open
    })
    act(() => useDialogStore.getState().resolveConfirm(modal.id, true))
    await waitFor(() => expect(sent('label:delete')).toEqual([{ id: 'l-tw' }]))
    await waitFor(() => expect(screen.queryByRole('listitem', { name: 'Violence' })).toBeNull())
    fireEvent.click(screen.getByRole('button', { name: 'Done' }))
    expect(useLabelStore.getState().managing).toBe(false)
  })
})

describe('LabelPicker (F-16.7)', () => {
  it('shows a node’s labels as chips, puts one on, takes one off, and opens the manager', async () => {
    await act(() => useLabelStore.getState().load())
    install({ 'label:assign': () => [WRY, TW], 'label:unassign': () => [TW] })
    render(<LabelPicker nodeId="sc-4" />)
    expect(screen.getAllByTestId('label-chip').map((chip) => chip.textContent)).toEqual(['Wry'])
    fireEvent.change(screen.getByRole('combobox', { name: 'Add a label' }), {
      target: { value: 'l-tw' }
    })
    await waitFor(() =>
      expect(screen.getAllByTestId('label-chip').map((chip) => chip.textContent)).toEqual([
        'Wry',
        'Violence'
      ])
    )
    expect(sent('label:assign')).toEqual([{ labelId: 'l-tw', nodeId: 'sc-4' }])
    fireEvent.click(screen.getByRole('button', { name: 'Remove label Wry' }))
    await waitFor(() =>
      expect(sent('label:unassign')).toEqual([{ labelId: 'l-wry', nodeId: 'sc-4' }])
    )
    fireEvent.click(screen.getByRole('button', { name: 'Manage labels…' }))
    expect(useLabelStore.getState().managing).toBe(true)
  })
})

describe('the label filter (F-16.7)', () => {
  it('narrows the Manuscript tree to the scenes carrying the label, with their folders', async () => {
    await act(() => useLabelStore.getState().load())
    render(
      <>
        <LabelFilterBar surface="manuscript" />
        <ManuscriptTree format="novel" />
      </>
    )
    const before = screen.getAllByRole('treeitem').length
    fireEvent.change(screen.getByRole('combobox', { name: 'Filter by label' }), {
      target: { value: 'l-wry' }
    })
    expect(screen.getByText(labelCountLabel(2, 'Wry'))).toBeInTheDocument()
    const tree = screen.getByRole('tree', { name: 'Document tree' })
    await waitFor(() => expect(within(tree).getAllByRole('treeitem').length).toBeLessThan(before))
    expect(within(tree).queryByText('Scene 2')).toBeNull()
    expect(within(tree).getByText('Scene 1')).toBeInTheDocument()
    expect(within(tree).getByText('Scene 4')).toBeInTheDocument()
    expect(within(tree).getByText('Chapter 1')).toBeInTheDocument()
    // Only this tree is filtered: the Research tree and the Outline keep their own.
    expect(useLabelStore.getState().filter).toEqual({
      manuscript: 'l-wry',
      research: null,
      outline: null
    })
    fireEvent.click(screen.getByRole('button', { name: 'Clear filter' }))
    await waitFor(() => expect(screen.getAllByRole('treeitem')).toHaveLength(before))
  })

  it('narrows the Outline to the labelled scenes and their folders', async () => {
    await act(() => useLabelStore.getState().load())
    render(<OutlineTab />)
    await screen.findByRole('list', { name: 'Outline' })
    // v2 has no Threads view until P2b.
    expect(screen.queryByRole('button', { name: 'Threads' })).toBeNull()
    fireEvent.change(screen.getByRole('combobox', { name: 'Filter by label' }), {
      target: { value: 'l-grim' }
    })
    const outline = await screen.findByRole('list', { name: 'Outline' })
    await waitFor(() =>
      expect(
        within(outline)
          .getAllByTestId('outline-row')
          .map((row) => row.textContent)
      ).toEqual([
        expect.stringContaining('Arc 1'),
        expect.stringContaining('Chapter 1'),
        expect.stringContaining('Scene 1')
      ])
    )
  })
})
