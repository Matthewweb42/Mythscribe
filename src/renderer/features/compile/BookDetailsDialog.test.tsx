import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defaultBookDetails } from '@shared/bookDetails'
import { useDialogStore } from '@renderer/features/shell/dialogs/dialogStore'
import { setIpcClient } from '@renderer/lib/ipc'
import { BookDetailsDialog } from './BookDetailsDialog'
import { detailsProblem, draftDetails, toDraft } from './bookDetailsDraft'
import { useBookDetailsStore } from './bookDetailsStore'
import { callsTo, installFakeCompileMain, type FakeCompileMain } from './compileTestIpc'

let fake: FakeCompileMain

function reset(): void {
  useBookDetailsStore.getState().clear()
  useDialogStore.setState({ modals: [], toasts: [] })
}

beforeEach(() => {
  reset()
  fake = installFakeCompileMain()
})
afterEach(() => {
  reset()
  setIpcClient(null)
})

describe('bookDetailsDraft', () => {
  it('splits the also-by lines and the keywords, and checks the language', () => {
    const draft = toDraft({ ...defaultBookDetails(), alsoBy: ['One'], keywords: ['a', 'b'] })
    expect(draft).toMatchObject({ alsoBy: 'One', keywords: 'a, b' })
    const details = draftDetails({ ...draft, alsoBy: ' One \n\nTwo', keywords: 'x, , y ' })
    expect(details.alsoBy).toEqual(['One', 'Two'])
    expect(details.keywords).toEqual(['x', 'y'])
    expect(detailsProblem(details)).toBeNull()
    expect(detailsProblem({ ...details, language: 'english!' })).toBe(
      'Language: a code like en, en-GB, or fr'
    )
  })
})

describe('BookDetailsDialog (F-12.4)', () => {
  it('loads the details, saves the edits, and closes', async () => {
    fake.details = { ...defaultBookDetails(), title: 'Salt Road' }
    const user = userEvent.setup()
    const onClose = vi.fn()
    render(<BookDetailsDialog onClose={onClose} />)
    const title = await screen.findByRole('textbox', { name: 'Title' })
    expect(title).toHaveValue('Salt Road')
    await user.type(screen.getByRole('textbox', { name: 'Author (pen name)' }), 'Ada Marlowe')
    await user.type(screen.getByRole('textbox', { name: 'Also by' }), 'First Book{Enter}Second')
    await user.click(screen.getByRole('button', { name: 'Add ISBN' }))
    await user.type(screen.getByRole('textbox', { name: 'Edition 1' }), 'Paperback')
    await user.type(screen.getByRole('textbox', { name: 'ISBN 1' }), '978-0-00-000000-0')
    await user.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(onClose).toHaveBeenCalled())
    expect(fake.details).toMatchObject({
      title: 'Salt Road',
      author: 'Ada Marlowe',
      alsoBy: ['First Book', 'Second'],
      isbns: [{ edition: 'Paperback', isbn: '978-0-00-000000-0' }]
    })
    expect(useBookDetailsStore.getState().details?.author).toBe('Ada Marlowe')
  })

  it('refuses a bad language code and asks before dropping edits', async () => {
    const user = userEvent.setup()
    const onClose = vi.fn()
    render(<BookDetailsDialog onClose={onClose} />)
    const language = await screen.findByRole('textbox', { name: 'Language' })
    await user.clear(language)
    await user.type(language, 'english!')
    expect(screen.getByRole('alert')).toHaveTextContent('Language: a code like en, en-GB, or fr')
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
    await user.click(screen.getByRole('button', { name: 'Close' }))
    const confirm = useDialogStore.getState().modals[0]
    expect(confirm?.kind).toBe('confirm')
    if (confirm?.kind === 'confirm') useDialogStore.getState().resolveConfirm(confirm.id, true)
    await waitFor(() => expect(onClose).toHaveBeenCalled())
    expect(callsTo(fake, 'bookDetails:set')).toEqual([])
  })

  it('sets and removes the cover at once', async () => {
    const user = userEvent.setup()
    render(<BookDetailsDialog onClose={() => {}} />)
    await user.click(await screen.findByRole('button', { name: 'Choose image…' }))
    expect(await screen.findByRole('img', { name: 'Book cover' })).toHaveAttribute(
      'src',
      'mythscribe-asset://covers/cover.0a1b2c3d.png'
    )
    await user.click(screen.getByRole('button', { name: 'Remove cover' }))
    await waitFor(() => expect(screen.queryByRole('img', { name: 'Book cover' })).toBeNull())
    expect(fake.details.cover).toBeNull()
  })
})
