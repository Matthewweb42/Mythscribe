import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DialogHost } from './DialogHost'
import { dialogs, toast, useDialogStore } from './dialogStore'

beforeEach(() => {
  useDialogStore.setState({ modals: [], toasts: [] })
})

describe('DialogHost', () => {
  it('renders a confirm dialog and resolves true on confirm', async () => {
    render(<DialogHost />)
    const promise = dialogs.confirm({
      title: 'Close project',
      message: 'Unsaved work is saved automatically.',
      confirmLabel: 'Close',
      danger: true
    })
    const dialog = await screen.findByRole('dialog', { name: 'Close project' })
    expect(dialog).toHaveTextContent('Unsaved work is saved automatically.')
    await userEvent.click(screen.getByRole('button', { name: 'Close' }))
    await expect(promise).resolves.toBe(true)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('resolves false on Escape', async () => {
    render(<DialogHost />)
    const promise = dialogs.confirm({ title: 'Sure?', message: '' })
    await screen.findByRole('dialog')
    await userEvent.keyboard('{Escape}')
    await expect(promise).resolves.toBe(false)
  })

  it('prompt returns the typed value and enforces validation', async () => {
    render(<DialogHost />)
    const promise = dialogs.prompt({
      title: 'Project name',
      validate: (v) => (v.trim() ? null : 'Name is required')
    })
    const input = await screen.findByRole('textbox', { name: 'Project name' })
    await userEvent.keyboard('{Enter}')
    expect(await screen.findByRole('alert')).toHaveTextContent('Name is required')
    await userEvent.type(input, 'My Novel{Enter}')
    await expect(promise).resolves.toBe('My Novel')
  })

  it('prompt returns null on cancel', async () => {
    render(<DialogHost />)
    const promise = dialogs.prompt({ title: 'Name' })
    await screen.findByRole('dialog')
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    await expect(promise).resolves.toBeNull()
  })

  it('choose shows every answer, Enter picks the primary, and Escape cancels', async () => {
    render(<DialogHost />)
    const options = {
      title: 'Which version?',
      message: 'Both changed.',
      details: ['This computer: today', 'Drive: yesterday'],
      choices: [
        { value: 'mine' as const, label: 'Keep mine' },
        { value: 'theirs' as const, label: 'Keep theirs' }
      ],
      primary: 'theirs' as const
    }
    const first = dialogs.choose(options)
    const dialog = await screen.findByRole('dialog', { name: 'Which version?' })
    expect(dialog).toHaveTextContent('This computer: today')
    expect(screen.getByRole('button', { name: 'Keep theirs' })).toHaveFocus()
    await userEvent.click(screen.getByRole('button', { name: 'Keep mine' }))
    await expect(first).resolves.toBe('mine')

    const second = dialogs.choose(options)
    await screen.findByRole('dialog')
    await userEvent.keyboard('{Enter}')
    await expect(second).resolves.toBe('theirs')

    const third = dialogs.choose(options)
    await screen.findByRole('dialog')
    await userEvent.keyboard('{Escape}')
    await expect(third).resolves.toBeNull()
  })

  it('shows toasts and lets the user dismiss them', async () => {
    render(<DialogHost />)
    toast.error('Could not open project')
    const status = await screen.findByRole('status')
    expect(status).toHaveTextContent('Could not open project')
    await userEvent.click(screen.getByRole('button', { name: 'Dismiss notification' }))
    expect(status).not.toHaveTextContent('Could not open project')
  })

  it("runs a toast's action and dismisses it", async () => {
    render(<DialogHost />)
    const run = vi.fn()
    toast.successWithAction('Organise applied 2 changes', { label: 'Undo', run })
    const status = await screen.findByRole('status')
    await userEvent.click(screen.getByRole('button', { name: 'Undo' }))
    expect(run).toHaveBeenCalledTimes(1)
    expect(status).not.toHaveTextContent('Organise applied 2 changes')
  })
})
