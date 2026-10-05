import { createEvent, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TreeNode } from '@shared/ipc/contract'
import { emptySceneMeta, type SceneMeta } from '@shared/sceneMeta'
import { UNAVAILABLE_SUMMARY, type SceneSummaryState } from '@shared/summary'
import { resetSceneMetaStore, useSceneMetaStore } from '@renderer/features/editor/sceneMetaStore'
import { resetSummaryStore } from '@renderer/features/editor/summaryStore'
import { treeFixture } from '@renderer/features/manuscript/treeFixture'
import { buildIndex, useTreeStore } from '@renderer/features/manuscript/treeStore'
import { resetPendingSaves } from '@renderer/features/project/pendingSaves'
import { setIpcClient, type IpcClient } from '@renderer/lib/ipc'
import { cardDropTarget, cardStepTarget } from './cardMove'
import { CorkBoard, FolderViewToggle } from './CorkBoard'
import { resetOutlineViewStore, useOutlineViewStore } from './outlineViewStore'

/** Chapter 1 holds three scenes here: Scene 1 (fixture), Scene 1b, Scene 1c. */
const scene = (id: string, position: number, title: string, wordCount: number): TreeNode => ({
  ...treeFixture.find((n) => n.id === 'sc-1')!,
  id,
  position,
  title,
  wordCount
})
const nodes: TreeNode[] = [
  ...treeFixture,
  scene('sc-1b', 1, 'Scene 1b', 40),
  scene('sc-1c', 2, 'Scene 1c', 5)
]

let metas: Record<string, SceneMeta>
let summaries: Record<string, SceneSummaryState>
let moves: { id: string; parentId: string; afterId?: string | null }[]

const summaryOf = (id: string, text: string): SceneSummaryState => ({
  available: true,
  summary: {
    nodeId: id,
    summary: text,
    keyPoints: [],
    characters: [],
    contentHash: 'h',
    promptVersion: 'summary.v2',
    model: 'gpt-test',
    truncated: false,
    createdAt: '2026-10-05T00:00:00.000Z'
  },
  stale: false,
  status: 'idle',
  error: null
})

/**
 * `sceneMeta:get` answers from `metas`, `summary:get` from `summaries`, `tree:move` with the row
 * at the gap-closed target position (like main), and the folder's tag bar gets empty lists.
 */
function install(): void {
  const invoke = vi.fn(async (channel: string, input: unknown) => {
    if (channel === 'sceneMeta:get') {
      const { id } = input as { id: string }
      return { id, meta: metas[id] ?? emptySceneMeta() }
    }
    if (channel === 'sceneMeta:set') return undefined
    if (channel === 'summary:get') {
      const { id } = input as { id: string }
      return summaries[id] ?? UNAVAILABLE_SUMMARY
    }
    if (channel === 'documentTag:list') return []
    if (channel === 'proposal:pendingTags') return []
    if (channel === 'tree:move') {
      const req = input as { id: string; parentId: string; afterId?: string | null }
      moves.push(req)
      const state = useTreeStore.getState()
      const node = state.byId[req.id]
      if (!node) throw new Error('missing')
      const siblings = (state.childrenOf[req.parentId] ?? []).filter((id) => id !== req.id)
      const position =
        req.afterId === undefined
          ? siblings.length
          : req.afterId === null
            ? 0
            : siblings.indexOf(req.afterId) + 1
      return { ...node, parentId: req.parentId, position }
    }
    throw new Error(`unexpected ${channel}`)
  })
  const client: IpcClient = { invoke: invoke as IpcClient['invoke'], on: () => () => {} }
  setIpcClient(client)
}

beforeEach(() => {
  resetSceneMetaStore()
  resetSummaryStore()
  resetPendingSaves()
  resetOutlineViewStore()
  useTreeStore.getState().clear()
  useTreeStore.setState({ ...buildIndex(nodes), loaded: true })
  metas = {}
  summaries = {}
  moves = []
  install()
})
afterEach(() => {
  // The synopsis edits schedule a debounced `sceneMeta:set`; it must not fire into the next file.
  resetSceneMetaStore()
  resetSummaryStore()
})

const board = (): HTMLElement => screen.getByRole('list', { name: 'Cork board' })
const card = (title: string): HTMLElement => within(board()).getByRole('listitem', { name: title })
const cardTitles = (): (string | null)[] =>
  within(board())
    .getAllByRole('listitem')
    .map((el) => el.getAttribute('aria-label'))
const synopsisOf = (title: string): HTMLElement =>
  within(card(title)).getByRole('textbox', { name: 'Synopsis' })

interface DragData {
  dropEffect: string
  effectAllowed: string
  data: Record<string, string>
  setData(type: string, value: string): void
  getData(type: string): string
}
const dragData = (): DragData => ({
  dropEffect: 'none',
  effectAllowed: 'uninitialized',
  data: {},
  setData(type, value) {
    this.data[type] = value
  },
  getData(type) {
    return this.data[type] ?? ''
  }
})

/** Fires a drag event at `clientX`; jsdom has no `DragEvent`, so the position is set by hand. */
function dragEvent(
  type: 'dragStart' | 'dragOver' | 'drop' | 'dragEnd',
  element: Element,
  dataTransfer: DragData,
  clientX = 0
): boolean {
  const event = createEvent[type](element, { dataTransfer })
  Object.defineProperty(event, 'clientX', { value: clientX })
  return fireEvent(element, event)
}

/** Cards are laid out 200px wide from x=100: 120 is the left half, 280 the right. */
const x = { left: 120, right: 280 }

/** Starts dragging `source` by its handle and hovers `target` at `clientX`. */
function dragOver(source: string, target: string, clientX: number): DragData {
  const dataTransfer = dragData()
  const handle = within(card(source)).getByRole('button', { name: source }).parentElement!
  dragEvent('dragStart', handle, dataTransfer)
  const targetCard = card(target)
  vi.spyOn(targetCard, 'getBoundingClientRect').mockReturnValue(new DOMRect(100, 0, 200, 160))
  dragEvent('dragOver', targetCard, dataTransfer, clientX)
  return dataTransfer
}

describe('CorkBoard', () => {
  it("shows the folder's direct children in tree order with words, synopsis, and status", async () => {
    metas['sc-1b'] = { ...emptySceneMeta(), synopsis: 'Mara finds the map.', status: 'draft' }
    render(<CorkBoard folderId="ch-1" format="webnovel" />)
    expect(cardTitles()).toEqual(['Scene 1', 'Scene 1b', 'Scene 1c'])
    await waitFor(() => expect(synopsisOf('Scene 1b')).toHaveValue('Mara finds the map.'))
    expect(within(card('Scene 1b')).getByRole('combobox', { name: 'Status' })).toHaveValue('draft')
    expect(within(card('Scene 1b')).getByTestId('card-status-stripe')).toHaveClass(
      'bg-status-draft'
    )
    expect(within(card('Scene 1')).getByTestId('card-words')).toHaveTextContent('1,200 words')
    expect(within(card('Scene 1c')).getByRole('combobox', { name: 'Status' })).toHaveValue('none')
  })

  it("shows a part's chapters, not its scenes", () => {
    render(<CorkBoard folderId="arc-1" format="webnovel" />)
    expect(cardTitles()).toEqual(['Chapter 1', 'Chapter 2', 'Chapter 3'])
    // A chapter's rollup is the sum of its scenes.
    expect(within(card('Chapter 1')).getByTestId('card-words')).toHaveTextContent('1,245 words')
  })

  it('shows the AI summary greyed while the synopsis is empty, and never copies it', async () => {
    summaries['sc-1'] = summaryOf('sc-1', 'Kael waits out the storm.')
    render(<CorkBoard folderId="ch-1" format="webnovel" />)
    const fallback = await within(card('Scene 1')).findByTestId('card-ai-summary')
    expect(fallback).toHaveTextContent('AIKael waits out the storm.')
    expect(within(fallback).getByText('AI')).toHaveAttribute(
      'title',
      'AI summary, shown until you write a synopsis'
    )
    await waitFor(() => expect(synopsisOf('Scene 1')).toBeEnabled())
    expect(synopsisOf('Scene 1')).toHaveValue('')
    await userEvent.type(synopsisOf('Scene 1'), 'Mine')
    expect(within(card('Scene 1')).queryByTestId('card-ai-summary')).toBeNull()
  })

  it('writes synopsis and status edits through the scene metadata store', async () => {
    render(<CorkBoard folderId="ch-1" format="webnovel" />)
    await waitFor(() => expect(synopsisOf('Scene 1c')).toBeEnabled())
    await userEvent.type(synopsisOf('Scene 1c'), 'The bridge falls.')
    await userEvent.selectOptions(
      within(card('Scene 1c')).getByRole('combobox', { name: 'Status' }),
      'revised'
    )
    const stored = useSceneMetaStore.getState().docs['sc-1c']
    expect(stored?.dirty).toBe(true)
    expect(stored?.content).toMatchObject({ synopsis: 'The bridge falls.', status: 'revised' })
    expect(within(card('Scene 1c')).getByTestId('card-status-stripe')).toHaveClass(
      'bg-status-revised'
    )
  })

  it('drops a card before the hovered one on its left half', async () => {
    render(<CorkBoard folderId="ch-1" format="webnovel" />)
    const transfer = dragOver('Scene 1c', 'Scene 1', x.left)
    expect(transfer.dropEffect).toBe('move')
    expect(card('Scene 1')).toHaveAttribute('data-drop', 'before')
    dragEvent('drop', card('Scene 1'), transfer, x.left)
    await waitFor(() => expect(cardTitles()).toEqual(['Scene 1c', 'Scene 1', 'Scene 1b']))
    expect(moves).toEqual([{ id: 'sc-1c', parentId: 'ch-1', afterId: null }])
    expect(board().querySelector('[data-drop]')).toBeNull()
  })

  it('drops a card after the hovered one on its right half', async () => {
    render(<CorkBoard folderId="ch-1" format="webnovel" />)
    const transfer = dragOver('Scene 1', 'Scene 1b', x.right)
    expect(card('Scene 1b')).toHaveAttribute('data-drop', 'after')
    dragEvent('drop', card('Scene 1b'), transfer, x.right)
    await waitFor(() => expect(cardTitles()).toEqual(['Scene 1b', 'Scene 1', 'Scene 1c']))
    expect(moves).toEqual([{ id: 'sc-1', parentId: 'ch-1', afterId: 'sc-1b' }])
  })

  it('refuses a drop that changes nothing', () => {
    render(<CorkBoard folderId="ch-1" format="webnovel" />)
    // Scene 1 is already right before Scene 1b.
    const transfer = dragOver('Scene 1', 'Scene 1b', x.left)
    expect(transfer.dropEffect).toBe('none')
    expect(card('Scene 1b')).not.toHaveAttribute('data-drop')
    dragEvent('drop', card('Scene 1b'), transfer, x.left)
    expect(moves).toEqual([])
  })

  it('moves a card with Alt+ArrowLeft and Alt+ArrowRight and keeps the focus on it', async () => {
    render(<CorkBoard folderId="ch-1" format="webnovel" />)
    const title = within(card('Scene 1b')).getByRole('button', { name: 'Scene 1b' })
    title.focus()
    await userEvent.keyboard('{Alt>}{ArrowRight}{/Alt}')
    await waitFor(() => expect(cardTitles()).toEqual(['Scene 1', 'Scene 1c', 'Scene 1b']))
    await waitFor(() => expect(title).toHaveFocus())
    await userEvent.keyboard('{Alt>}{ArrowRight}{/Alt}')
    await userEvent.keyboard('{Alt>}{ArrowLeft}{/Alt}')
    await waitFor(() => expect(cardTitles()).toEqual(['Scene 1', 'Scene 1b', 'Scene 1c']))
    // The last card cannot move later, so only two moves reached main.
    expect(moves).toEqual([
      { id: 'sc-1b', parentId: 'ch-1', afterId: 'sc-1c' },
      { id: 'sc-1b', parentId: 'ch-1', afterId: 'sc-1' }
    ])
  })

  it('opens a node from its card title', async () => {
    render(<CorkBoard folderId="ch-1" format="webnovel" />)
    await userEvent.click(within(card('Scene 1b')).getByRole('button', { name: 'Scene 1b' }))
    expect(useTreeStore.getState().selectedId).toBe('sc-1b')
  })

  it('invites the author to add a scene to an empty folder', () => {
    useTreeStore.setState({
      ...buildIndex(nodes.filter((n) => n.id !== 'sc-3')),
      loaded: true
    })
    render(<CorkBoard folderId="ch-3" format="webnovel" />)
    expect(screen.queryByRole('list', { name: 'Cork board' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Add a scene' })).toBeInTheDocument()
  })
})

describe('cardDropTarget', () => {
  it('reorders siblings only', () => {
    const index = buildIndex(nodes)
    expect(cardDropTarget(index, 'sc-2', 'sc-1', 'before')).toBeNull()
    expect(cardDropTarget(index, 'sc-1c', 'sc-1b', 'before')).toEqual({
      parentId: 'ch-1',
      afterId: 'sc-1'
    })
  })

  it('steps nowhere past either end', () => {
    const index = buildIndex(nodes)
    expect(cardStepTarget(index, 'sc-1', -1)).toBeNull()
    expect(cardStepTarget(index, 'sc-1c', 1)).toBeNull()
    expect(cardStepTarget(index, 'sc-1', 1)).toEqual({ parentId: 'ch-1', afterId: 'sc-1b' })
  })
})

describe('FolderViewToggle', () => {
  it('switches the folder view between the stack and the cork board', async () => {
    render(<FolderViewToggle />)
    const stacked = screen.getByRole('button', { name: 'Stacked' })
    const cork = screen.getByRole('button', { name: 'Cork board' })
    expect(stacked).toHaveAttribute('aria-pressed', 'true')
    await userEvent.click(cork)
    expect(useOutlineViewStore.getState().folderView).toBe('cork')
    expect(cork).toHaveAttribute('aria-pressed', 'true')
    expect(stacked).toHaveAttribute('aria-pressed', 'false')
    await userEvent.click(stacked)
    expect(useOutlineViewStore.getState().folderView).toBe('stacked')
  })
})
