import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { docToText } from '@shared/docText'
import type { Channel, Input, Output } from '@shared/ipc/contract'
import {
  countInDoc,
  replaceInDoc,
  samplesInDoc,
  type ReplaceCommitRequest,
  type ReplacePreview,
  type ReplaceRequest
} from '@shared/replace'
import type { TiptapNodeT } from '@shared/tiptap'
import { countWords } from '@shared/wordCount'
import { resetDocumentStore, useDocumentStore } from '@renderer/features/editor/documentStore'
import { resetEditorSettingsStore } from '@renderer/features/editor/settingsStore'
import { StackedEditor } from '@renderer/features/editor/StackedEditor'
import { resetFocusStore } from '@renderer/features/focus/focusStore'
import { treeFixture } from '@renderer/features/manuscript/treeFixture'
import { buildIndex, useTreeStore } from '@renderer/features/manuscript/treeStore'
import { resetPendingSaves } from '@renderer/features/project/pendingSaves'
import { DialogHost } from '@renderer/features/shell/dialogs/DialogHost'
import { useDialogStore } from '@renderer/features/shell/dialogs/dialogStore'
import { resetViewStore } from '@renderer/features/shell/viewStore'
import { setIpcClient, type IpcClient } from '@renderer/lib/ipc'
import { ReplaceDialog } from './ReplaceDialog'
import { resetReplaceStore, useReplaceStore } from './replaceStore'

const doc = (...paragraphs: string[]): TiptapNodeT => ({
  type: 'doc',
  content: paragraphs.map((text) => ({ type: 'paragraph', content: [{ type: 'text', text }] }))
})

/**
 * A main that really stores, previews, replaces, and undoes, with the shared pure functions, so
 * the tests below see what the author would: the text in the editors and the text on disk.
 */
let stored: Record<string, TiptapNodeT>
let undo: { id: string; before: TiptapNodeT; after: TiptapNodeT }[] | null
let saves: Input<'document:save'>[]
let previews: ReplaceRequest[]
let commits: ReplaceCommitRequest[]

function install(): void {
  const client: IpcClient = {
    async invoke<C extends Channel>(channel: C, input: Input<C>): Promise<Output<C>> {
      if (channel === 'document:get') {
        const { id } = input as Input<'document:get'>
        return { id, content: stored[id] ?? null } as Output<C>
      }
      if (channel === 'document:save') {
        const save = input as Input<'document:save'>
        saves.push(save)
        stored[save.id] = save.content
        return { wordCount: countWords(save.content), modified: 'm' } as Output<C>
      }
      if (channel === 'replace:preview') {
        const request = input as ReplaceRequest
        previews.push(request)
        const items = Object.entries(stored)
          .map(([id, content]) => ({
            id,
            title: useTreeStore.getState().byId[id]?.title ?? id,
            location: 'Arc 1',
            count: countInDoc(content, request),
            samples: samplesInDoc(content, request)
          }))
          .filter((item) => item.count > 0)
        const preview: ReplacePreview = { items, total: items.length, truncated: false }
        return preview as Output<C>
      }
      if (channel === 'replace:commit') {
        const request = input as ReplaceCommitRequest
        commits.push(request)
        const changed: { id: string; count: number; wordCount: number }[] = []
        const entries: NonNullable<typeof undo> = []
        for (const id of request.ids) {
          const before = stored[id]
          if (before === undefined) continue
          const replaced = replaceInDoc(before, request)
          if (replaced.count === 0) continue
          stored[id] = replaced.doc
          entries.push({ id, before, after: replaced.doc })
          changed.push({ id, count: replaced.count, wordCount: countWords(replaced.doc) })
        }
        if (entries.length > 0) undo = entries
        return {
          changed,
          total: changed.reduce((sum, each) => sum + each.count, 0)
        } as Output<C>
      }
      if (channel === 'replace:undo') {
        const restored: { id: string; wordCount: number }[] = []
        const skipped: string[] = []
        for (const entry of undo ?? []) {
          if (JSON.stringify(stored[entry.id]) !== JSON.stringify(entry.after)) {
            skipped.push(entry.id)
            continue
          }
          stored[entry.id] = entry.before
          restored.push({ id: entry.id, wordCount: countWords(entry.before) })
        }
        undo = null
        return { restored, skipped } as Output<C>
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
  setIpcClient(client)
}

const dialog = (): HTMLElement => screen.getByRole('dialog', { name: 'Replace in project' })
const findBox = (): HTMLElement => within(dialog()).getByRole('textbox', { name: 'Find' })
const replaceBox = (): HTMLElement =>
  within(dialog()).getByRole('textbox', { name: 'Replace with' })
const groups = (): HTMLElement[] => within(dialog()).queryAllByTestId('replace-document')
/** The footer button, whatever its label currently counts. */
const commitButton = (): HTMLElement =>
  within(dialog()).getByRole('button', { name: /^Replace( \d|$)/ })
/** What main holds for `id`, as text: an editor's save adds attributes a typed fixture lacks. */
const storedText = (id: string): string => docToText(stored[id] ?? { type: 'doc' })
const toasts = (): string[] => useDialogStore.getState().toasts.map((t) => t.message)
const regions = (): HTMLElement[] =>
  screen.getAllByRole('region').filter((r) => r.tagName === 'SECTION')
const editorIn = (region: HTMLElement | undefined): HTMLElement => {
  if (!region) throw new Error('no region')
  return within(region).getByRole('textbox', { name: 'Document' })
}

/** A button of the confirm that precedes every write. */
async function confirmButton(name: string): Promise<HTMLElement> {
  const confirm = await screen.findByRole('dialog', { name: 'Replace across documents' })
  return within(confirm).getByRole('button', { name })
}

/** Opens the dialog and types both fields; resolves once the preview for them is on screen. */
async function fill(find: string, replacement: string): Promise<void> {
  act(() => useReplaceStore.getState().openReplace())
  await userEvent.type(findBox(), find)
  if (replacement !== '') await userEvent.type(replaceBox(), replacement)
  await waitFor(() =>
    expect(useReplaceStore.getState()).toMatchObject({
      status: 'done',
      answered: { query: find, replacement }
    })
  )
}

/** Presses the footer button and accepts the confirm. */
async function commitAndConfirm(): Promise<void> {
  await userEvent.click(commitButton())
  await userEvent.click(await confirmButton('Replace'))
  await waitFor(() => expect(useDialogStore.getState().modals).toEqual([]))
  await waitFor(() => expect(useReplaceStore.getState().busy).toBe(false))
}

beforeEach(() => {
  resetReplaceStore()
  resetDocumentStore()
  resetEditorSettingsStore()
  resetPendingSaves()
  resetFocusStore()
  useTreeStore.setState({ ...buildIndex(treeFixture), loaded: true, selectedId: null })
  useDialogStore.setState({ modals: [], toasts: [] })
  stored = {
    'sc-1': doc('The lantern swung.', 'A Lantern, a lantern.'),
    'sc-2': doc('No light here.'),
    'sc-3': doc('One more lantern.')
  }
  undo = null
  saves = []
  previews = []
  commits = []
  install()
})
afterEach(() => {
  // Debounced writes outlive a test: cancel them so none fires into the next file's fake client.
  resetReplaceStore()
  resetDocumentStore()
  resetEditorSettingsStore()
  resetViewStore()
  resetPendingSaves()
  useTreeStore.getState().clear()
})

describe('ReplaceDialog (F-10.2)', () => {
  it('renders nothing while closed and focuses Find when it opens', () => {
    render(<ReplaceDialog />)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    act(() => useReplaceStore.getState().openReplace())
    expect(findBox()).toHaveFocus()
    expect(within(dialog()).getByRole('status')).toHaveTextContent('Type the text to find.')
    expect(commitButton()).toBeDisabled()
    // Nothing is selected in the tree, so there is no scope to choose.
    expect(within(dialog()).queryByRole('radiogroup')).not.toBeInTheDocument()
  })

  it('previews one group per document with the change struck through and inserted', async () => {
    render(<ReplaceDialog />)
    await fill('lantern', 'lamp')
    expect(groups()).toHaveLength(2)
    const [first, second] = groups()
    expect(first).toHaveTextContent('Scene 1')
    expect(first).toHaveTextContent('3 occurrences')
    expect(second).toHaveTextContent('1 occurrence')
    const lines = within(first!).getAllByRole('listitem')
    expect(lines.map((line) => line.textContent)).toEqual([
      'The lanternlamp swung.',
      'A Lanternlamp, a lantern.',
      'A Lantern, a lanternlamp.'
    ])
    expect(lines[1]?.querySelector('del')).toHaveTextContent('Lantern')
    expect(lines[1]?.querySelector('ins')).toHaveTextContent('lamp')
    expect(commitButton()).toHaveTextContent('Replace 4 occurrences in 2 documents')
    expect(commitButton()).toBeEnabled()
    // Nothing has been written.
    expect(commits).toEqual([])
    expect(stored['sc-1']).toEqual(doc('The lantern swung.', 'A Lantern, a lantern.'))
  })

  it('shows "+k more" past the sample cap and no insertion for a deletion', async () => {
    stored = { 'sc-1': doc('x x x x x x x') }
    render(<ReplaceDialog />)
    await fill('x', '')
    const [group] = groups()
    expect(group).toHaveTextContent('7 occurrences')
    expect(group).toHaveTextContent('+2 more')
    expect(group?.querySelectorAll('del')).toHaveLength(5)
    expect(group?.querySelector('ins')).toBeNull()
  })

  it('says when no document holds the text, and keeps the button disabled', async () => {
    render(<ReplaceDialog />)
    await fill('zeppelin', 'x')
    expect(within(dialog()).getByRole('status')).toHaveTextContent('No document holds “zeppelin”.')
    expect(groups()).toHaveLength(0)
    expect(commitButton()).toBeDisabled()
  })

  it('passes Match case and Whole word on, and offers the selection as a scope', async () => {
    useTreeStore.setState({ selectedId: 'arc-1' })
    render(<ReplaceDialog />)
    await fill('lantern', 'lamp')
    await userEvent.click(within(dialog()).getByRole('checkbox', { name: 'Match case' }))
    await waitFor(() => expect(groups()[0]).toHaveTextContent('2 occurrences'))
    await userEvent.click(within(dialog()).getByRole('checkbox', { name: 'Whole word' }))
    await waitFor(() => expect(previews[previews.length - 1]?.wholeWord).toBe(true))
    const scope = within(dialog()).getByRole('radiogroup', { name: 'Replace in' })
    const title = useTreeStore.getState().byId['arc-1']?.title
    expect(within(scope).getByRole('radio', { name: 'All documents' })).toBeChecked()
    await userEvent.click(
      within(scope).getByRole('radio', { name: `${title} and everything in it` })
    )
    await waitFor(() => expect(previews[previews.length - 1]?.scopeId).toBe('arc-1'))
    expect(previews[previews.length - 1]).toMatchObject({ matchCase: true, wholeWord: true })
  })

  it('leaves an unticked document out, and disables the button with nothing ticked', async () => {
    render(
      <>
        <ReplaceDialog />
        <DialogHost />
      </>
    )
    await fill('lantern', 'lamp')
    await userEvent.click(within(dialog()).getByRole('checkbox', { name: 'Replace in Scene 1' }))
    expect(commitButton()).toHaveTextContent('Replace 1 occurrence in 1 document')
    await userEvent.click(within(dialog()).getByRole('checkbox', { name: 'Replace in Scene 3' }))
    expect(commitButton()).toBeDisabled()
    expect(commitButton()).toHaveTextContent(/^Replace$/)
    await userEvent.click(within(dialog()).getByRole('checkbox', { name: 'Replace in Scene 3' }))

    await userEvent.click(commitButton())
    await userEvent.click(await confirmButton('Replace'))
    await waitFor(() => expect(commits).toHaveLength(1))
    expect(commits[0]?.ids).toEqual(['sc-3'])
    await waitFor(() => expect(stored['sc-3']).toEqual(doc('One more lamp.')))
    expect(stored['sc-1']).toEqual(doc('The lantern swung.', 'A Lantern, a lantern.'))
  })

  it('names the counts in a confirm and writes nothing when it is cancelled', async () => {
    render(
      <>
        <ReplaceDialog />
        <DialogHost />
      </>
    )
    await fill('lantern', 'lamp')
    await userEvent.click(commitButton())
    expect(await confirmButton('Replace')).toBeInTheDocument()
    expect(
      screen.getByText(/Replace 4 occurrences in 2 documents of “lantern” with “lamp”\?/)
    ).toBeInTheDocument()
    await userEvent.click(await confirmButton('Cancel'))
    expect(commits).toEqual([])
    expect(dialog()).toBeInTheDocument()

    // A deletion says so.
    await userEvent.clear(replaceBox())
    await waitFor(() =>
      expect(useReplaceStore.getState()).toMatchObject({
        status: 'done',
        answered: { replacement: '' }
      })
    )
    await userEvent.click(commitButton())
    expect(await confirmButton('Delete')).toBeInTheDocument()
    expect(
      screen.getByText(/Delete 4 occurrences in 2 documents of “lantern”\?/)
    ).toBeInTheDocument()
    await userEvent.click(await confirmButton('Cancel'))
    expect(commits).toEqual([])
  })

  it('replaces, offers Undo last replace, and takes it back', async () => {
    render(
      <>
        <ReplaceDialog />
        <DialogHost />
      </>
    )
    await fill('lantern', 'lamp')
    expect(within(dialog()).queryByRole('button', { name: 'Undo last replace' })).toBeNull()
    await userEvent.click(commitButton())
    await userEvent.click(await confirmButton('Replace'))
    await waitFor(() => expect(toasts()).toEqual(['Replaced 4 occurrences in 2 documents.']))
    expect(stored['sc-1']).toEqual(doc('The lamp swung.', 'A lamp, a lamp.'))
    expect(stored['sc-3']).toEqual(doc('One more lamp.'))
    // The preview is asked again: nothing is left to replace.
    await waitFor(() =>
      expect(within(dialog()).getByRole('status')).toHaveTextContent('No document holds “lantern”.')
    )

    // The focus returns to Find, so Escape still reaches the dialog.
    await waitFor(() => expect(findBox()).toHaveFocus())

    useDialogStore.setState({ toasts: [] })
    await userEvent.click(within(dialog()).getByRole('button', { name: 'Undo last replace' }))
    await waitFor(() => expect(toasts()).toEqual(['Restored 2 documents.']))
    await waitFor(() => expect(findBox()).toHaveFocus())
    expect(stored['sc-1']).toEqual(doc('The lantern swung.', 'A Lantern, a lantern.'))
    expect(stored['sc-3']).toEqual(doc('One more lantern.'))
    expect(within(dialog()).queryByRole('button', { name: 'Undo last replace' })).toBeNull()
    await waitFor(() => expect(groups()).toHaveLength(2))
  })

  it('closes on Escape and on the close button, keeping the fields', async () => {
    render(<ReplaceDialog />)
    await fill('lantern', 'lamp')
    await userEvent.keyboard('{Escape}')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    act(() => useReplaceStore.getState().openReplace())
    expect(findBox()).toHaveValue('lantern')
    expect(replaceBox()).toHaveValue('lamp')
    await userEvent.click(within(dialog()).getByRole('button', { name: 'Close replace' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })
})

/**
 * The risks of a bulk rewrite behind open editors (F-10.2): an unsaved draft must reach main
 * before the replace, every mounted editor of a changed document must show the new text, and no
 * later autosave may put the old text back.
 */
describe('ReplaceDialog over mounted editors (F-10.2)', () => {
  /** Arc 1 stacked (Scene 1, 2, 3), every region loaded and editable, beside the dialog. */
  async function mountStack(): Promise<void> {
    render(
      <>
        <StackedEditor folderId="arc-1" format="webnovel" />
        <ReplaceDialog />
        <DialogHost />
      </>
    )
    await waitFor(() => {
      for (const region of regions()) {
        expect(editorIn(region)).toHaveAttribute('contenteditable', 'true')
      }
    })
    expect(editorIn(regions()[0])).toHaveTextContent('The lantern swung.')
  }

  it('saves an unsaved draft before replacing, and the replace applies to it', async () => {
    await mountStack()
    // jsdom places the caret at the start of the clicked box.
    await userEvent.click(editorIn(regions()[1]))
    await userEvent.keyboard('New lantern. ')
    expect(useDocumentStore.getState().docs['sc-2']?.dirty).toBe(true)
    expect(saves).toEqual([])

    await fill('lantern', 'lamp')
    // The preview flushed the draft, so main counted the typed word too.
    expect(saves.map((save) => save.id)).toEqual(['sc-2'])
    expect(groups()).toHaveLength(3)
    await commitAndConfirm()

    expect(storedText('sc-2')).toBe('New lamp. No light here.')
    expect(editorIn(regions()[1])).toHaveTextContent('New lamp. No light here.')
  })

  it('refreshes every mounted editor of a changed document, and leaves the others mounted', async () => {
    await mountStack()
    const untouched = editorIn(regions()[1])
    await fill('lantern', 'lamp')
    await commitAndConfirm()
    await waitFor(() => expect(editorIn(regions()[0])).toHaveTextContent('The lamp swung.'))
    expect(editorIn(regions()[0])).toHaveTextContent('A lamp, a lamp.')
    expect(editorIn(regions()[2])).toHaveTextContent('One more lamp.')
    expect(editorIn(regions()[0])).toHaveAttribute('contenteditable', 'true')
    // The document without a match kept its editor instance (and so its undo history).
    expect(editorIn(regions()[1])).toBe(untouched)
    expect(useDocumentStore.getState().docs['sc-1']).toEqual({
      content: doc('The lamp swung.', 'A lamp, a lamp.'),
      dirty: false
    })
  })

  it('never writes the old text back: the next edit and autosave build on the replaced text', async () => {
    await mountStack()
    await fill('lantern', 'lamp')
    await commitAndConfirm()
    await waitFor(() => expect(editorIn(regions()[0])).toHaveTextContent('The lamp swung.'))
    // Nothing was pending, so nothing was saved by the replace itself.
    expect(saves).toEqual([])

    await userEvent.keyboard('{Escape}')
    await userEvent.click(editorIn(regions()[0]))
    await userEvent.keyboard('Then: ')
    await act(async () => {
      await useDocumentStore.getState().flush()
    })
    expect(saves.map((save) => save.id)).toEqual(['sc-1'])
    expect(storedText('sc-1')).toBe('Then: The lamp swung.\nA lamp, a lamp.')
    expect(JSON.stringify(stored)).not.toContain('lantern')
  })

  it('drops a draft that is still pending when the documents are read again', async () => {
    await mountStack()
    await fill('lantern', 'lamp')
    // A draft that appears after the preview's flush (it cannot be typed through the modal, but
    // the store must hold even so) is caught by the flush before the commit.
    await userEvent.click(commitButton())
    const accept = await confirmButton('Replace')
    act(() => useDocumentStore.getState().edit('sc-3', doc('One more lantern, stale.')))
    // The flush before the commit writes it, as it should: main replaces in what it was given.
    await userEvent.click(accept)
    await waitFor(() => expect(useReplaceStore.getState().busy).toBe(false))
    expect(stored['sc-3']).toEqual(doc('One more lamp, stale.'))
    await waitFor(() => expect(editorIn(regions()[2])).toHaveTextContent('One more lamp, stale.'))

    // And with a draft the flush never saw, `reload` discards it rather than saving it.
    act(() => useDocumentStore.getState().edit('sc-3', doc('One more lantern, again.')))
    stored['sc-3'] = doc('Rewritten by main.')
    await act(async () => {
      await useDocumentStore.getState().reload(['sc-3'])
    })
    await act(async () => {
      await useDocumentStore.getState().flush()
    })
    expect(stored['sc-3']).toEqual(doc('Rewritten by main.'))
    await waitFor(() => expect(editorIn(regions()[2])).toHaveTextContent('Rewritten by main.'))
    expect(useDocumentStore.getState().docs['sc-3']?.dirty).toBe(false)
  })

  it('undo restores the text in every mounted editor and skips a document edited since', async () => {
    await mountStack()
    await fill('lantern', 'lamp')
    await commitAndConfirm()
    await waitFor(() => expect(editorIn(regions()[2])).toHaveTextContent('One more lamp.'))

    // The author keeps writing in Scene 3 before thinking better of the replace.
    await userEvent.keyboard('{Escape}')
    await userEvent.click(editorIn(regions()[2]))
    await userEvent.keyboard('Later. ')
    expect(useDocumentStore.getState().docs['sc-3']?.dirty).toBe(true)
    act(() => useReplaceStore.getState().openReplace())
    useDialogStore.setState({ toasts: [] })
    await userEvent.click(within(dialog()).getByRole('button', { name: 'Undo last replace' }))
    await waitFor(() => expect(useReplaceStore.getState().undoable).toBeNull())

    // The newer words were saved first, so main saw Scene 3 changed and left it alone.
    expect(storedText('sc-3')).toBe('Later. One more lamp.')
    expect(editorIn(regions()[2])).toHaveTextContent('Later. One more lamp.')
    expect(stored['sc-1']).toEqual(doc('The lantern swung.', 'A Lantern, a lantern.'))
    await waitFor(() => expect(editorIn(regions()[0])).toHaveTextContent('The lantern swung.'))
    expect(toasts()).toEqual([
      'Restored 1 document. 1 document changed since the replace and was left as it is.'
    ])
  })
})
