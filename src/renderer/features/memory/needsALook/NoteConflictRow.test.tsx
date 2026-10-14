import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Input } from '@shared/ipc/contract'
import type { StoryRecord } from '@shared/memory/records'
import type { TiptapNodeT } from '@shared/tiptap'
import { pageKey, resetPageStore, usePageStore } from '@renderer/features/research/pageStore'
import { useDialogStore } from '@renderer/features/shell/dialogs/dialogStore'
import { resetDismissedStore } from '@renderer/features/thisScene/dismissedStore'
import { IpcRequestError, setIpcClient } from '@renderer/lib/ipc'
import {
  findingSideFixture,
  findingsViewFixture,
  installFakeMain,
  noteFindingFixture,
  type FakeMain
} from '../memoryFixture'
import { resetMemoryStore } from '../memoryStore'
import { NOTE_BUSY, NoteConflictRow } from './NoteConflictRow'

/**
 * F-16.29 (plan P4 §4, P4-D18): a book-against-note conflict: "Your note on Orrin says born 1790;
 * the book says 1792 (1.1)", *Go there*, *Open my note*, *Update my note* only when offered (the
 * code-made proposal, edited and saved behind the page store, refused when the line moved) and
 * *Not a problem*; never *This one's right* (the book is canon).
 */

const NOTE = noteFindingFixture('f-6')
const KEY = pageKey({ kind: 'pinned', id: 'r-orrin' })
let main: FakeMain
let applyFails = false
/** Orrin's Pinned page as main holds it, one line per paragraph. */
let pinned: string[]
/** Runs while `memory:applyNotePatch` is on the wire: the author typing on the open page meanwhile. */
let duringApply: (() => void) | null

const page = (lines: readonly string[]): TiptapNodeT => ({
  type: 'doc',
  content: lines.map((text) => ({ type: 'paragraph', content: [{ type: 'text', text }] }))
})

const orrin = (): StoryRecord => ({
  id: 'r-orrin',
  categoryId: 'character',
  kind: 'character',
  name: 'Orrin',
  image: null,
  origin: 'author',
  aliases: [],
  created: '2026-10-13T09:00:00.000Z',
  modified: '2026-10-13T09:00:00.000Z',
  pinned: page(pinned),
  ideas: null
})

const toasts = (): string[] => useDialogStore.getState().toasts.map((toast) => toast.message)

beforeEach(() => {
  resetMemoryStore()
  resetDismissedStore()
  resetPageStore()
  applyFails = false
  pinned = ['Born: 1790']
  duringApply = null
  useDialogStore.setState({ modals: [], toasts: [] })
  main = installFakeMain({
    'memory:notePatch': () => ({
      findingId: 'f-6',
      owner: { kind: 'record', id: 'r-orrin', name: 'Orrin' },
      page: 'pinned',
      index: 0,
      before: 'Born: 1790',
      after: 'Born: 1792',
      sentence: 'Born: 1790',
      value: '1792'
    }),
    'memory:applyNotePatch': () => {
      if (applyFails) {
        throw new IpcRequestError({
          code: 'VALIDATION',
          message: 'That line changed since; open the page to edit it'
        })
      }
      duringApply?.()
      pinned = ['Born: 1792']
      return { owner: { kind: 'record', id: 'r-orrin' }, closed: true }
    },
    'record:get': () => orrin(),
    'record:savePage': (input) => {
      const { doc } = input as Input<'record:savePage'>
      pinned = (doc?.content ?? []).map((block) =>
        (block.content ?? []).map((child) => child.text ?? '').join('')
      )
      return orrin()
    },
    'recovery:stash': () => undefined,
    'recovery:clear': () => undefined,
    'memory:findings': () => findingsViewFixture(),
    'memory:findingAction': () => ({ dismissed: null, other: null })
  })
})
afterEach(() => {
  resetMemoryStore()
  resetPageStore()
  setIpcClient(null)
})

describe('NoteConflictRow (F-16.29)', () => {
  it('says what the note and the book say, with Go there and Open my note, never This one’s right', () => {
    render(
      <ul>
        <NoteConflictRow finding={NOTE} />
      </ul>
    )
    const item = screen.getByTestId('note-conflict')
    expect(item).toHaveTextContent('Your note on Orrin says born 1790; the book says 1792 (1.1)')
    expect(item).toHaveTextContent('Orrin’s Pinned page: Born: 1790')
    expect(within(item).getByRole('button', { name: 'Go there' })).toBeInTheDocument()
    expect(within(item).getByRole('button', { name: 'Open my note' })).toBeInTheDocument()
    expect(within(item).getByRole('button', { name: 'Update my note' })).toBeInTheDocument()
    expect(within(item).queryByRole('button', { name: /This one/ })).toBeNull()
  })

  it('withholds Update my note when the book side is not narration in the present', () => {
    render(
      <ul>
        <NoteConflictRow
          finding={noteFindingFixture('f-7', {
            a: findingSideFixture('1792', '1.1', 'sc-1', { voice: 'dialogue' }),
            actions: { right: { a: false, b: false }, updateNote: false, notFlashback: null }
          })}
        />
      </ul>
    )
    expect(screen.queryByRole('button', { name: 'Update my note' })).toBeNull()
    expect(screen.getByRole('button', { name: /^Not a problem/ })).toBeInTheDocument()
  })

  it('edits the proposal and saves it through the note’s own save', async () => {
    render(
      <ul>
        <NoteConflictRow finding={NOTE} />
      </ul>
    )
    fireEvent.click(screen.getByRole('button', { name: 'Update my note' }))
    const field = await screen.findByLabelText('Your note, with the book’s 1792')
    expect(field).toHaveValue('Born: 1792')
    fireEvent.change(field, { target: { value: 'Born: 1792 (in Leith)' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() =>
      expect(main.sent('memory:applyNotePatch')).toEqual([
        { findingId: 'f-6', index: 0, before: 'Born: 1790', text: 'Born: 1792 (in Leith)' }
      ])
    )
    await waitFor(() =>
      expect(toasts()).toEqual(['Your note on Orrin now reads “Born: 1792 (in Leith)”.'])
    )
    // The closed finding goes from the list at once.
    expect(main.sent('memory:findings')).toEqual([{ nodeId: null }])
    expect(screen.queryByRole('textbox')).toBeNull()
  })

  it('says so when the line changed since, and keeps the edit open', async () => {
    applyFails = true
    render(
      <ul>
        <NoteConflictRow finding={NOTE} />
      </ul>
    )
    fireEvent.click(screen.getByRole('button', { name: 'Update my note' }))
    await screen.findByLabelText('Your note, with the book’s 1792')
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() =>
      expect(toasts()).toEqual(['That line changed since; open the page to edit it'])
    )
    expect(screen.getByRole('textbox')).toBeInTheDocument()
  })

  it('applies once and keeps her words when she typed on the note meanwhile', async () => {
    await usePageStore.getState().load(KEY)
    duringApply = () => {
      duringApply = null
      usePageStore.getState().edit(KEY, page(['Born: 1790', 'Typed meanwhile']))
    }
    render(
      <ul>
        <NoteConflictRow finding={NOTE} />
      </ul>
    )
    fireEvent.click(screen.getByRole('button', { name: 'Update my note' }))
    await screen.findByLabelText('Your note, with the book’s 1792')
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(toasts()).toEqual([NOTE_BUSY]))
    // The apply closed its finding: it never runs again on her saved draft.
    expect(main.sent('memory:applyNotePatch')).toHaveLength(1)
    expect(pinned).toEqual(['Born: 1790', 'Typed meanwhile'])
    // The stale proposal closes and the list is read again (the finding comes back re-found).
    expect(screen.queryByRole('textbox')).toBeNull()
    await waitFor(() => expect(main.sent('memory:findings')).toEqual([{ nodeId: null }]))
  })

  it('Not a problem answers the finding', async () => {
    render(
      <ul>
        <NoteConflictRow finding={NOTE} />
      </ul>
    )
    fireEvent.click(screen.getByRole('button', { name: /^Not a problem/ }))
    await waitFor(() =>
      expect(main.sent('memory:findingAction')).toEqual([
        { findingId: 'f-6', action: 'notProblem' } satisfies Input<'memory:findingAction'>
      ])
    )
  })
})
