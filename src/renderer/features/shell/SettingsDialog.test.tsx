import { fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Sparkles, Type } from 'lucide-react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defaultEditorSettings } from '@shared/editorSettings'
import type { Channel, Input, Output } from '@shared/ipc/contract'
import {
  resetEditorSettingsStore,
  useEditorSettingsStore
} from '@renderer/features/editor/settingsStore'
import { resetAccountStore } from '@renderer/features/account/accountStore'
import { resetPendingSaves } from '@renderer/features/project/pendingSaves'
import { useDialogStore } from '@renderer/features/shell/dialogs/dialogStore'
import { setIpcClient, type IpcClient } from '@renderer/lib/ipc'
import { SettingsDialog } from './SettingsDialog'
import type { SettingsDialogTab } from './settingsDialogTabs'

/** Two fake tabs with the real ids, so the dialog's tab handling is driven without the real panels. */
const tabs: readonly [SettingsDialogTab, ...SettingsDialogTab[]] = [
  {
    id: 'editor',
    label: 'Editor',
    icon: Type,
    scope: 'project',
    render: () => <p>formatting here</p>
  },
  { id: 'ai', label: 'AI', icon: Sparkles, scope: 'project', render: () => <p>keys here</p> }
]

/** Accepts every `editorSettings:set`; anything else is unexpected here. */
const client: IpcClient = {
  async invoke<C extends Channel>(channel: C, input: Input<C>): Promise<Output<C>> {
    if (channel === 'editorSettings:set') {
      const value = input as Input<'editorSettings:set'>
      return value as Output<C>
    }
    throw new Error(`unexpected ${channel}`)
  },
  on: () => () => {}
}

const dialog = (): HTMLElement => screen.getByRole('dialog', { name: 'Settings' })
const tab = (name: string): HTMLElement => screen.getByRole('tab', { name })
const panel = (): HTMLElement => screen.getByRole('tabpanel')

beforeEach(() => {
  resetEditorSettingsStore()
  resetPendingSaves()
  // The real registry includes the Account tab (F-15.2); the shared worker must not hand it a
  // signed-in account left over from another file, which would send it looking for credits.
  resetAccountStore()
  useDialogStore.setState({ modals: [], toasts: [] })
  setIpcClient(client)
  useEditorSettingsStore.setState({ settings: { ...defaultEditorSettings('novel') } })
})
// The store's debounced write outlives a test: cancel it here so it cannot fire into the next file's fake client.
afterEach(() => {
  resetEditorSettingsStore()
})

describe('SettingsDialog (F-7.5)', () => {
  it('is a labelled modal dialog that shows the Editor tab and focuses it', () => {
    render(<SettingsDialog format="novel" onClose={vi.fn()} />)
    expect(dialog()).toHaveAttribute('aria-modal', 'true')
    expect(within(dialog()).getByRole('tablist', { name: 'Settings' })).toBeInTheDocument()
    expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual([
      'Editor',
      'AI',
      'Account',
      'Updates',
      'Diagnostics'
    ])
    expect(tab('Editor')).toHaveAttribute('aria-selected', 'true')
    expect(tab('Editor')).toHaveFocus()
    expect(panel()).toHaveAccessibleName('Editor')
    expect(tab('Editor')).toHaveAttribute('aria-controls', panel().id)
    // The registry wiring: the real Editor tab's controls and preview are inside.
    expect(within(panel()).getByRole('spinbutton', { name: 'Font size' })).toHaveValue(16)
    expect(within(panel()).getByTestId('editor-preview')).toBeInTheDocument()
  })

  it('closes on Escape, the close button, and a backdrop click, but not a click inside', async () => {
    const onClose = vi.fn()
    render(<SettingsDialog format="novel" onClose={onClose} />)
    await userEvent.keyboard('{Escape}')
    expect(onClose).toHaveBeenCalledTimes(1)

    await userEvent.click(screen.getByRole('button', { name: 'Close settings' }))
    expect(onClose).toHaveBeenCalledTimes(2)

    fireEvent.mouseDown(dialog())
    fireEvent.mouseDown(within(dialog()).getByRole('spinbutton', { name: 'Font size' }))
    expect(onClose).toHaveBeenCalledTimes(2)
    const backdrop = dialog().parentElement
    if (!backdrop) throw new Error('no backdrop')
    fireEvent.mouseDown(backdrop)
    expect(onClose).toHaveBeenCalledTimes(3)
  })

  it('a control in the Editor tab updates the settings store live', async () => {
    render(<SettingsDialog format="novel" onClose={vi.fn()} />)
    const fontSize = within(panel()).getByRole('spinbutton', { name: 'Font size' })
    await userEvent.clear(fontSize)
    await userEvent.type(fontSize, '20')
    expect(useEditorSettingsStore.getState().settings?.fontSize).toBe(20)
    expect(
      within(panel()).getByTestId('editor-preview').style.getPropertyValue('--ms-editor-font-size')
    ).toBe('20px')
  })

  it('opens on the tab the opener named, and focuses it (F-15.5)', () => {
    render(<SettingsDialog format="novel" onClose={vi.fn()} initialTab="ai" tabs={tabs} />)
    expect(tab('AI')).toHaveAttribute('aria-selected', 'true')
    expect(tab('AI')).toHaveFocus()
    expect(panel()).toHaveTextContent('keys here')
  })

  it('falls back to the first tab when the named one is not shown (F-15.5)', () => {
    render(<SettingsDialog format={null} onClose={vi.fn()} initialTab="editor" />)
    // F-15.7 / F-15.8: Updates and Diagnostics are app-wide too, so the welcome screen shows
    // them beside Account.
    expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual([
      'Account',
      'Updates',
      'Diagnostics'
    ])
    expect(tab('Account')).toHaveAttribute('aria-selected', 'true')
  })

  it('switches between injected tabs by click and by the arrow keys, one panel at a time', async () => {
    render(<SettingsDialog format="novel" onClose={vi.fn()} tabs={tabs} />)
    expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual(['Editor', 'AI'])
    expect(screen.getAllByRole('tabpanel')).toHaveLength(1)
    expect(panel()).toHaveTextContent('formatting here')
    expect(tab('AI')).toHaveAttribute('tabindex', '-1')

    await userEvent.click(tab('AI'))
    expect(tab('AI')).toHaveAttribute('aria-selected', 'true')
    expect(tab('Editor')).toHaveAttribute('aria-selected', 'false')
    expect(screen.getAllByRole('tabpanel')).toHaveLength(1)
    expect(panel()).toHaveTextContent('keys here')
    expect(panel()).toHaveAccessibleName('AI')

    tab('AI').focus()
    await userEvent.keyboard('{ArrowRight}')
    expect(tab('Editor')).toHaveAttribute('aria-selected', 'true')
    expect(tab('Editor')).toHaveFocus()
    await userEvent.keyboard('{ArrowLeft}')
    expect(tab('AI')).toHaveAttribute('aria-selected', 'true')
    expect(tab('AI')).toHaveFocus()
    await userEvent.keyboard('{Home}')
    expect(panel()).toHaveTextContent('formatting here')
    await userEvent.keyboard('{End}')
    expect(panel()).toHaveTextContent('keys here')
  })
})
