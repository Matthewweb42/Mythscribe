import { fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { APP_SHORTCUTS, EDITOR_SHORTCUTS, SHORTCUT_IDS } from './shortcuts'
import { ShortcutsDialog } from './ShortcutsDialog'

const dialog = (): HTMLElement => screen.getByRole('dialog', { name: 'Keyboard shortcuts' })

describe('ShortcutsDialog (F-7.7)', () => {
  it('is a labelled modal that focuses its close button', () => {
    render(<ShortcutsDialog onClose={vi.fn()} />)
    expect(dialog()).toHaveAttribute('aria-modal', 'true')
    expect(screen.getByRole('button', { name: 'Close keyboard shortcuts' })).toHaveFocus()
  })

  it('lists every app shortcut and every editor shortcut, grouped, with the platform chord', () => {
    render(<ShortcutsDialog onClose={vi.fn()} />)
    const tables = within(dialog()).getAllByRole('table')
    expect(tables.map((t) => within(t).getByText(/^(App|Insert|Editor)$/).textContent)).toEqual([
      'App',
      'Insert',
      'Editor'
    ])
    const rows = within(dialog()).getAllByRole('row')
    expect(rows).toHaveLength(SHORTCUT_IDS.length + EDITOR_SHORTCUTS.length)
    const row = (label: string): HTMLElement =>
      within(dialog()).getByRole('row', { name: new RegExp(`^${label} \\S+$`) })
    expect(row('Insert scene')).toHaveTextContent('Ctrl+Shift+S')
    expect(row('Insert chapter')).toHaveTextContent('Ctrl+Shift+C')
    expect(row('Settings')).toHaveTextContent('Ctrl+,')
    expect(row('AI assistant')).toHaveTextContent('Ctrl+K')
    expect(row('Focus mode')).toHaveTextContent('F11')
    expect(row('Save')).toHaveTextContent('Ctrl+S')
    // F-7.10: the zoom chords are app shortcuts, so the reference lists them from the registry.
    expect(row('Zoom in')).toHaveTextContent('Ctrl+=')
    expect(row('Zoom out')).toHaveTextContent('Ctrl+-')
    expect(row('Reset zoom')).toHaveTextContent('Ctrl+0')
    expect(row('Bold')).toHaveTextContent('Ctrl+B')
    expect(row('Accept the ghost text')).toHaveTextContent('Tab')
    // The Insert group holds exactly the insert chords, in registry order.
    const insert = tables[1]!
    expect(
      within(insert)
        .getAllByRole('rowheader')
        .map((h) => h.textContent)
    ).toEqual(
      SHORTCUT_IDS.filter((id) => APP_SHORTCUTS[id].group === 'insert').map(
        (id) => APP_SHORTCUTS[id].label
      )
    )
  })

  it('closes on Escape, the close button, and a backdrop click', async () => {
    const onClose = vi.fn()
    render(<ShortcutsDialog onClose={onClose} />)
    await userEvent.keyboard('{Escape}')
    expect(onClose).toHaveBeenCalledTimes(1)
    await userEvent.click(screen.getByRole('button', { name: 'Close keyboard shortcuts' }))
    expect(onClose).toHaveBeenCalledTimes(2)
    fireEvent.mouseDown(dialog().parentElement!)
    expect(onClose).toHaveBeenCalledTimes(3)
    // A click inside the dialog is not a backdrop click.
    fireEvent.mouseDown(dialog())
    expect(onClose).toHaveBeenCalledTimes(3)
  })
})
