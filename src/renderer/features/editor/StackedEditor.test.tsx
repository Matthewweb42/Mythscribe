import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  contract,
  type Channel,
  type Input,
  type Output,
  type TreeNode
} from '@shared/ipc/contract'
import { defaultEditorSettings } from '@shared/editorSettings'
import type { TiptapNodeT } from '@shared/tiptap'
import { countWords } from '@shared/wordCount'
import { treeFixture } from '@renderer/features/manuscript/treeFixture'
import { buildIndex, useTreeStore } from '@renderer/features/manuscript/treeStore'
import { resetPendingSaves } from '@renderer/features/project/pendingSaves'
import { useDialogStore } from '@renderer/features/shell/dialogs/dialogStore'
import { setIpcClient, type IpcClient } from '@renderer/lib/ipc'
import { resetDocumentStore, useDocumentStore } from './documentStore'
import { resetEditorSettingsStore, useEditorSettingsStore } from './settingsStore'
import { StackedEditor } from './StackedEditor'

const doc = (text: string): TiptapNodeT => ({
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text }] }]
})

interface PendingGet {
  id: string
  resolve: (content: TiptapNodeT | null) => void
}

/**
 * `document:get` resolves only when the test releases it; `document:save` records its input and
 * resolves at once; `tree:create` answers like main would, appending under the requested parent.
 */
function fakeClient(): {
  client: IpcClient
  gets: PendingGet[]
  saves: Input<'document:save'>[]
  creates: Input<'tree:create'>[]
} {
  const gets: PendingGet[] = []
  const saves: Input<'document:save'>[] = []
  const creates: Input<'tree:create'>[] = []
  const client: IpcClient = {
    async invoke<C extends Channel>(channel: C, input: Input<C>): Promise<Output<C>> {
      if (channel === 'document:save') {
        const save = input as Input<'document:save'>
        saves.push(save)
        return { wordCount: countWords(save.content), modified: 'm' } as Output<C>
      }
      if (channel === 'document:get') {
        const { id } = input as Input<'document:get'>
        return new Promise<Output<C>>((resolve) => {
          gets.push({ id, resolve: (content) => resolve({ id, content } as Output<C>) })
        })
      }
      if (channel === 'tree:create') {
        const req = contract['tree:create'].input.parse(input)
        creates.push(req)
        const created: TreeNode = {
          id: 'new',
          parentId: req.parentId,
          sectionType: null,
          kind: req.kind,
          hierarchyLevel: req.hierarchyLevel,
          title: req.hierarchyLevel === 'scene' ? 'Untitled Scene' : 'Untitled',
          position: (useTreeStore.getState().childrenOf[req.parentId] ?? []).length,
          wordCount: 0,
          matterType: null,
          preset: null,
          created: 'c',
          modified: 'm'
        }
        return created as Output<C>
      }
      if (channel === 'documentTag:list') return [] as Output<C>
      if (channel === 'sceneMeta:get') {
        const { id } = input as Input<'sceneMeta:get'>
        return { id, meta: { location: '', pov: '', timeline: '' } } as Output<C>
      }
      throw new Error(`unexpected ${channel}`)
    },
    on: () => () => {}
  }
  return { client, gets, saves, creates }
}

let gets: PendingGet[]
let saves: Input<'document:save'>[]
let creates: Input<'tree:create'>[]

/** A second front-matter document, so the matter separator has two regions to sit between. */
const dedication: TreeNode = {
  ...treeFixture.find((n) => n.id === 'title-page')!,
  id: 'dedication',
  title: 'Dedication',
  position: 1,
  matterType: 'dedication'
}

/** The fixture without the given rows, loaded into the tree store. */
function loadTree(without: string[] = [], extra: TreeNode[] = []): void {
  const nodes = [...treeFixture.filter((n) => !without.includes(n.id)), ...extra]
  useTreeStore.setState({ ...buildIndex(nodes), loaded: true })
}

/** Releases the `document:get` for `id` with `content`. */
async function release(id: string, content: TiptapNodeT | null): Promise<void> {
  const get = gets.find((g) => g.id === id)
  if (!get) throw new Error(`no pending get for ${id}`)
  await act(async () => {
    get.resolve(content)
  })
}

/** The document regions (`<section>`); the folder's own tag bar (F-4.5) is a region too but not a document. */
const regions = (): HTMLElement[] =>
  screen.getAllByRole('region').filter((r) => r.tagName === 'SECTION')
const regionNames = (): string[] => regions().map((r) => r.getAttribute('aria-label') ?? '')
const boxIn = (region: HTMLElement): HTMLElement =>
  within(region).getByRole('textbox', { name: 'Document' })
const button = (name: string): HTMLElement => screen.getByRole('button', { name })
const firstParagraphText = (saved: TiptapNodeT | undefined): string =>
  (saved?.content?.[0]?.content ?? []).map((n) => n.text ?? '').join('')

beforeEach(() => {
  resetDocumentStore()
  resetEditorSettingsStore()
  resetPendingSaves()
  useTreeStore.getState().clear()
  useDialogStore.setState({ modals: [], toasts: [] })
  const fake = fakeClient()
  gets = fake.gets
  saves = fake.saves
  creates = fake.creates
  setIpcClient(fake.client)
})

describe('StackedEditor (F-3.8, F-2.5)', () => {
  it('stacks every descendant document in tree order, each titled and loaded under its own id', async () => {
    loadTree()
    render(<StackedEditor folderId="arc-1" format="webnovel" />)
    expect(regionNames()).toEqual(['Scene 1', 'Scene 2', 'Scene 3'])
    expect(screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent)).toEqual([
      'Scene 1',
      'Scene 2',
      'Scene 3'
    ])
    expect(gets.map((g) => g.id)).toEqual(['sc-1', 'sc-2', 'sc-3'])
    expect(screen.getAllByRole('textbox', { name: 'Document' })).toHaveLength(3)

    await release('sc-2', doc('Second'))
    await release('sc-1', doc('First'))
    await release('sc-3', null)
    const [first, second, third] = regions()
    await waitFor(() => expect(boxIn(first!)).toHaveTextContent('First'))
    expect(boxIn(second!)).toHaveTextContent('Second')
    expect(boxIn(third!)).toHaveTextContent('')
    expect(boxIn(third!)).toHaveAttribute('contenteditable', 'true')
    expect(Object.keys(useDocumentStore.getState().docs).sort()).toEqual(['sc-1', 'sc-2', 'sc-3'])
  })

  it("shows the folder's combined saved count, without a session delta, in the status bar (F-3.3)", async () => {
    loadTree()
    const rollup = useTreeStore.getState().wordCountRollup
    const before = rollup['arc-1'] ?? 0
    render(<StackedEditor folderId="arc-1" format="webnovel" />)
    expect(screen.getByTestId('status-words')).toHaveTextContent(`${before.toLocaleString()} words`)
    expect(screen.queryByTestId('status-delta')).not.toBeInTheDocument()
    // A region's save updates the rollup, and the bar follows it.
    await release('sc-1', doc('one'))
    await act(async () => {
      useTreeStore.getState().setWordCount('sc-1', (rollup['sc-1'] ?? 0) + 10)
    })
    expect(screen.getByTestId('status-words')).toHaveTextContent(
      `${(before + 10).toLocaleString()} words`
    )
  })

  it('sets the column width once for the whole stack (F-3.4)', () => {
    loadTree()
    render(<StackedEditor folderId="arc-1" format="webnovel" />)
    const pane = screen.getByRole('toolbar', { name: 'Formatting' }).parentElement
    expect(pane?.style.getPropertyValue('--ms-editor-max-width')).toBe('700px')
    for (const region of regions()) {
      expect(boxIn(region).parentElement).toHaveClass('max-w-(--ms-editor-max-width)', 'mx-auto')
    }
    // Each region's title heading also sits inside the shared column, not full width.
    for (const heading of screen.getAllByRole('heading', { level: 2 })) {
      expect(heading).toHaveClass('max-w-(--ms-editor-max-width)', 'mx-auto')
    }
    // The scene-break separator between regions follows the same column.
    for (const sep of screen.getAllByRole('separator', { name: 'Scene break' })) {
      expect(sep).toHaveClass('max-w-(--ms-editor-max-width)', 'mx-auto')
    }
  })

  it('sets the same column class on the page-break separator between matter documents (F-3.4)', () => {
    loadTree([], [dedication])
    render(<StackedEditor folderId="front" format="novel" />)
    const line = screen.getByRole('separator', { name: 'Page break' })
    expect(line).toHaveClass('max-w-(--ms-editor-max-width)', 'mx-auto')
  })

  it('separates manuscript scenes with the scene-break text of the format', () => {
    loadTree()
    render(<StackedEditor folderId="arc-1" format="webnovel" />)
    const breaks = screen.getAllByRole('separator', { name: 'Scene break' })
    expect(breaks).toHaveLength(2)
    expect(breaks.map((b) => b.textContent)).toEqual(['~~~', '~~~'])
    expect(breaks[0]?.tagName).toBe('DIV')
    expect(screen.queryByRole('separator', { name: 'Page break' })).not.toBeInTheDocument()
    // The separator sits between the first and second region.
    const [first, second] = regions()
    expect(first!.compareDocumentPosition(breaks[0]!)).toBe(Node.DOCUMENT_POSITION_FOLLOWING)
    expect(breaks[0]!.compareDocumentPosition(second!)).toBe(Node.DOCUMENT_POSITION_FOLLOWING)
  })

  it('follows the project settings for the column, the text, and the separator (F-3.6)', () => {
    loadTree()
    useEditorSettingsStore.setState({
      settings: {
        ...defaultEditorSettings('webnovel'),
        maxWidth: 640,
        fontSize: 18,
        sceneBreak: '###'
      }
    })
    render(<StackedEditor folderId="arc-1" format="webnovel" />)
    const pane = screen.getByRole('toolbar', { name: 'Formatting' }).parentElement
    expect(pane?.style.getPropertyValue('--ms-editor-max-width')).toBe('640px')
    expect(pane?.style.getPropertyValue('--ms-editor-font-size')).toBe('18px')
    expect(pane?.style.getPropertyValue('--ms-editor-paragraph-spacing')).toBe('1em')
    expect(
      screen.getAllByRole('separator', { name: 'Scene break' }).map((b) => b.textContent)
    ).toEqual(['###', '###'])
    act(() => useEditorSettingsStore.getState().update({ sceneBreak: '~~~' }))
    expect(
      screen.getAllByRole('separator', { name: 'Scene break' }).map((b) => b.textContent)
    ).toEqual(['~~~', '~~~'])
  })

  it('separates front-matter documents with a page-break line', () => {
    loadTree([], [dedication])
    render(<StackedEditor folderId="front" format="novel" />)
    expect(regionNames()).toEqual(['Title Page', 'Dedication'])
    const line = screen.getByRole('separator', { name: 'Page break' })
    expect(line.tagName).toBe('HR')
    expect(screen.queryByRole('separator', { name: 'Scene break' })).not.toBeInTheDocument()
  })

  it('renders a document itself as a single region without a separator', () => {
    loadTree()
    render(<StackedEditor folderId="sc-4" format="novel" />)
    expect(regionNames()).toEqual(['Scene 4'])
    expect(screen.queryByRole('separator', { name: 'Scene break' })).not.toBeInTheDocument()
  })

  it('types into one region without touching the other and saves under its own id', async () => {
    loadTree()
    render(<StackedEditor folderId="ch-1" format="novel" />)
    // Chapter 1 has one scene; give it a sibling so two regions share the stack.
    loadTree(
      [],
      [
        {
          ...treeFixture.find((n) => n.id === 'sc-2')!,
          id: 'sc-1b',
          parentId: 'ch-1',
          position: 1,
          title: 'Scene 1'
        }
      ]
    )
    await waitFor(() => expect(regionNames()).toEqual(['Scene 1', 'Scene 1']))
    await release('sc-1', doc('Alpha'))
    await release('sc-1b', doc('Beta'))
    const [first, second] = regions()
    await waitFor(() => expect(boxIn(first!)).toHaveAttribute('contenteditable', 'true'))
    await waitFor(() => expect(boxIn(second!)).toHaveAttribute('contenteditable', 'true'))

    await userEvent.click(boxIn(second!))
    await userEvent.keyboard(' typed')
    // jsdom places the caret at the start of the clicked box; only the target matters here.
    expect(boxIn(second!)).toHaveTextContent('typed')
    expect(boxIn(second!)).toHaveTextContent('Beta')
    expect(boxIn(first!)).toHaveTextContent('Alpha')
    expect(boxIn(first!)).not.toHaveTextContent('typed')
    expect(useDocumentStore.getState().docs['sc-1b']?.dirty).toBe(true)
    expect(useDocumentStore.getState().docs['sc-1']?.dirty).toBe(false)

    await userEvent.keyboard('{Control>}s{/Control}')
    await waitFor(() => expect(saves).toHaveLength(1))
    expect(saves[0]?.id).toBe('sc-1b')
    expect(firstParagraphText(saves[0]?.content)).toContain('typed')
    expect(firstParagraphText(saves[0]?.content)).toContain('Beta')
    await waitFor(() => expect(useDocumentStore.getState().docs['sc-1b']?.dirty).toBe(false))
  })

  it('follows a rename in the tree while the region is shown (F-3.8)', async () => {
    loadTree()
    render(<StackedEditor folderId="arc-1" format="novel" />)
    expect(regionNames()).toEqual(['Scene 1', 'Scene 2', 'Scene 3'])

    act(() => {
      useTreeStore.setState((s) => ({
        byId: { ...s.byId, 'sc-2': { ...s.byId['sc-2']!, title: 'The Storm' } }
      }))
    })

    expect(regionNames()).toEqual(['Scene 1', 'The Storm', 'Scene 3'])
    expect(screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent)).toEqual([
      'Scene 1',
      'The Storm',
      'Scene 3'
    ])
  })

  it('keeps the shared toolbar disabled until a region is focused, then targets that region', async () => {
    loadTree()
    render(<StackedEditor folderId="arc-1" format="novel" />)
    expect(screen.getAllByRole('toolbar', { name: 'Formatting' })).toHaveLength(1)
    expect(button('Bold')).toBeDisabled()
    await release('sc-1', doc('First'))
    await release('sc-2', doc('Second'))
    const [first, second] = regions()
    await waitFor(() => expect(boxIn(first!)).toHaveAttribute('contenteditable', 'true'))
    await waitFor(() => expect(boxIn(second!)).toHaveAttribute('contenteditable', 'true'))
    expect(button('Bold')).toBeDisabled()

    await userEvent.click(boxIn(second!))
    await waitFor(() => expect(button('Bold')).toBeEnabled())
    await userEvent.keyboard('{Control>}a{/Control}')
    await userEvent.click(button('Bold'))
    await waitFor(() => expect(boxIn(second!).querySelector('strong')).toHaveTextContent('Second'))
    expect(boxIn(first!).querySelector('strong')).toBeNull()
  })

  it('drops the toolbar target when its region leaves the stack', async () => {
    loadTree()
    render(<StackedEditor folderId="arc-1" format="novel" />)
    await release('sc-3', doc('Third'))
    const third = regions()[2]!
    await waitFor(() => expect(boxIn(third)).toHaveAttribute('contenteditable', 'true'))
    await userEvent.click(boxIn(third))
    await waitFor(() => expect(button('Bold')).toBeEnabled())

    act(() => loadTree(['sc-3']))
    await waitFor(() => expect(regionNames()).toEqual(['Scene 1', 'Scene 2']))
    await waitFor(() => expect(button('Bold')).toBeDisabled())
    expect(useDocumentStore.getState().docs['sc-3']).toBeUndefined()
  })

  it('invites the author to add a scene to an empty chapter and mounts the new region', async () => {
    loadTree(['sc-1'])
    useTreeStore.getState().select('ch-1')
    render(<StackedEditor folderId="ch-1" format="novel" />)
    expect(screen.queryAllByRole('region').filter((r) => r.tagName === 'SECTION')).toEqual([])
    expect(screen.queryByRole('toolbar')).not.toBeInTheDocument()
    expect(screen.getByText('Nothing here yet. Add a scene to start writing.')).toBeInTheDocument()

    await userEvent.click(button('Add a scene'))
    expect(creates).toEqual([
      { parentId: 'ch-1', afterId: undefined, kind: 'document', hierarchyLevel: 'scene' }
    ])
    await waitFor(() => expect(regionNames()).toEqual(['Untitled Scene']))
    expect(screen.getByRole('toolbar', { name: 'Formatting' })).toBeInTheDocument()
    expect(gets.map((g) => g.id)).toEqual(['new'])
    expect(useTreeStore.getState().selectedId).toBe('ch-1') // the stack stays; the new scene renames in the tree
    expect(useTreeStore.getState().renamingId).toBe('new')
  })

  it('invites the author to add a document to an empty matter folder', async () => {
    loadTree()
    render(<StackedEditor folderId="end" format="novel" />)
    expect(
      screen.getByText('Nothing here yet. Add a document to start writing.')
    ).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Add a scene' })).not.toBeInTheDocument()

    await userEvent.click(button('Add a document'))
    expect(creates).toEqual([
      { parentId: 'end', afterId: undefined, kind: 'document', hierarchyLevel: null }
    ])
    await waitFor(() => expect(regionNames()).toEqual(['Untitled']))
  })

  it('shows text only for an empty part, which has no scene target', () => {
    loadTree(['ch-4', 'ch-5', 'ch-6', 'sc-4', 'sc-5', 'sc-6'])
    render(<StackedEditor folderId="arc-2" format="novel" />)
    expect(
      screen.getByText('Nothing here yet. Add a chapter first, then a scene.')
    ).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Add a scene' })).not.toBeInTheDocument()
  })
})
