import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Channel, Input, Output, ProjectInfo } from '@shared/ipc/contract'
import { MENU, menuItems } from '@shared/menu'
import { useProjectStore } from '@renderer/features/project/projectStore'
import { useDialogStore } from '@renderer/features/shell/dialogs/dialogStore'
import {
  resetShellDialogStore,
  useShellDialogStore
} from '@renderer/features/shell/shellDialogStore'
import { setIpcClient, type IpcClient } from '@renderer/lib/ipc'
import { MenuBar } from './MenuBar'

const info: ProjectInfo = {
  id: '1',
  name: 'Serial',
  format: 'webnovel',
  path: '/tmp/Serial.mythscribe',
  created: 'c',
  modified: 'm',
  lastOpened: 'l',
  schemaVersion: 1
}

let invoke: ReturnType<typeof vi.fn<(channel: string, input: unknown) => Promise<unknown>>>

beforeEach(() => {
  invoke = vi.fn(async () => null)
  const client: IpcClient = {
    invoke: <C extends Channel>(channel: C, input: Input<C>) =>
      invoke(channel, input) as Promise<Output<C>>,
    on: () => () => {}
  }
  setIpcClient(client)
  resetShellDialogStore()
  useProjectStore.setState({ current: null, ready: true, busy: false, recents: [] })
  useDialogStore.setState({ modals: [], toasts: [] })
})

const bar = (): HTMLElement => screen.getByRole('menubar', { name: 'Application menu' })
const trigger = (name: string): HTMLElement => within(bar()).getByRole('menuitem', { name })
const popup = (name: string): HTMLElement => screen.getByRole('menu', { name })
const item = (menu: string, name: string): HTMLElement =>
  within(popup(menu)).getByRole('menuitem', { name })

describe('MenuBar (F-7.1)', () => {
  it('renders the six triggers from the definition, closed, with one tab stop', () => {
    render(<MenuBar />)
    const triggers = within(bar()).getAllByRole('menuitem')
    expect(triggers.map((t) => t.textContent)).toEqual(MENU.map((s) => s.label))
    for (const t of triggers) {
      expect(t).toHaveAttribute('aria-haspopup', 'menu')
      expect(t).toHaveAttribute('aria-expanded', 'false')
    }
    expect(triggers.map((t) => t.tabIndex)).toEqual([0, -1, -1, -1, -1, -1])
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  })

  it('a click opens the popup with every entry, separators included, shortcuts decorative', async () => {
    useProjectStore.setState({ current: info })
    render(<MenuBar />)
    await userEvent.click(trigger('File'))
    expect(trigger('File')).toHaveAttribute('aria-expanded', 'true')
    const file = popup('File')
    expect(
      within(file)
        .getAllByRole('menuitem')
        .map((m) => m.textContent)
    ).toEqual(['New project', 'Open project…', 'SaveCtrl+S', 'Close project'])
    expect(within(file).getAllByRole('separator')).toHaveLength(2)
    expect(item('File', 'Save')).toHaveAttribute('aria-keyshortcuts', 'Ctrl+S')
    expect(item('File', 'Save')).not.toHaveAttribute('aria-disabled')
    // Every item of the definition is reachable through the bar.
    await userEvent.click(trigger('File'))
    let seen = 0
    for (const section of MENU) {
      await userEvent.click(trigger(section.label))
      seen += within(popup(section.label)).getAllByRole('menuitem').length
      await userEvent.keyboard('{Escape}')
    }
    expect(seen).toBe(menuItems().length)
  })

  it('disables the project items without a project, and a click on one does nothing', async () => {
    render(<MenuBar />)
    await userEvent.click(trigger('Tools'))
    const tags = item('Tools', 'Tags')
    expect(tags).toHaveAttribute('aria-disabled', 'true')
    await userEvent.click(tags)
    expect(useShellDialogStore.getState().open).toBeNull()
    expect(popup('Tools')).toBeInTheDocument()
    // Settings is app-wide since F-15.2 (the Account tab needs no project).
    expect(item('Tools', 'Settings')).not.toHaveAttribute('aria-disabled')
    await userEvent.keyboard('{Escape}')
    await userEvent.click(trigger('Help'))
    expect(item('Help', 'About MythScribe')).not.toHaveAttribute('aria-disabled')
  })

  it('an item click runs its action and closes the menu', async () => {
    render(<MenuBar />)
    await userEvent.click(trigger('Help'))
    await userEvent.click(item('Help', 'Keyboard shortcuts'))
    expect(useShellDialogStore.getState().open).toBe('shortcuts')
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    expect(trigger('Help')).toHaveAttribute('aria-expanded', 'false')
  })

  it('never takes the focus on a click, so Edit › Paste lands where the caret was', async () => {
    render(
      <>
        <input aria-label="Field" />
        <MenuBar />
      </>
    )
    const field = screen.getByRole('textbox', { name: 'Field' })
    field.focus()
    await userEvent.click(trigger('Edit'))
    expect(field).toHaveFocus()
    await userEvent.click(item('Edit', 'Paste'))
    expect(invoke).toHaveBeenCalledWith('menu:edit', { role: 'paste' })
    expect(field).toHaveFocus()
  })

  it('hovering another trigger while open switches menus; an outside click and Escape close', async () => {
    render(
      <>
        <p>outside</p>
        <MenuBar />
      </>
    )
    await userEvent.click(trigger('File'))
    await userEvent.hover(trigger('View'))
    expect(screen.queryByRole('menu', { name: 'File' })).not.toBeInTheDocument()
    expect(popup('View')).toBeInTheDocument()
    await userEvent.click(screen.getByText('outside'))
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    // Hovering with nothing open opens nothing.
    await userEvent.hover(trigger('Help'))
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    await userEvent.click(trigger('Help'))
    await userEvent.keyboard('{Escape}')
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  })

  it('is keyboard operable: arrows along the bar, Enter opens onto the first item, arrows move, Escape restores the focus', async () => {
    useProjectStore.setState({ current: info })
    render(<MenuBar />)
    await userEvent.tab()
    expect(trigger('File')).toHaveFocus()
    await userEvent.keyboard('{ArrowRight}')
    expect(trigger('Edit')).toHaveFocus()
    await userEvent.keyboard('{ArrowLeft}{ArrowLeft}')
    expect(trigger('Help')).toHaveFocus()
    await userEvent.keyboard('{Enter}')
    expect(item('Help', 'Documentation')).toHaveFocus()
    await userEvent.keyboard('{ArrowDown}')
    expect(item('Help', 'Keyboard shortcuts')).toHaveFocus()
    await userEvent.keyboard('{End}')
    expect(item('Help', 'About MythScribe')).toHaveFocus()
    await userEvent.keyboard('{ArrowDown}')
    expect(item('Help', 'Documentation')).toHaveFocus()
    await userEvent.keyboard('{ArrowUp}')
    expect(item('Help', 'About MythScribe')).toHaveFocus()
    // ArrowRight wraps to File and lands on its first item.
    await userEvent.keyboard('{ArrowRight}')
    expect(item('File', 'New project')).toHaveFocus()
    await userEvent.keyboard('{ArrowLeft}')
    expect(item('Help', 'Documentation')).toHaveFocus()
    await userEvent.keyboard('{Escape}')
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    expect(trigger('Help')).toHaveFocus()
    // Enter on a focused item runs it (Help's fourth item since F-15.7 is About).
    await userEvent.keyboard('{ArrowDown}{ArrowDown}{ArrowDown}{ArrowDown}{Enter}')
    expect(useShellDialogStore.getState().open).toBe('about')
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  })

  it('typing while a menu is open closes it and lets the key through', async () => {
    render(
      <>
        <input aria-label="Field" />
        <MenuBar />
      </>
    )
    const field = screen.getByRole('textbox', { name: 'Field' })
    field.focus()
    await userEvent.click(trigger('Insert'))
    expect(popup('Insert')).toBeInTheDocument()
    await userEvent.keyboard('x')
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    expect(field).toHaveValue('x')
  })

  it('labels the Insert items by the project format', async () => {
    useProjectStore.setState({ current: info })
    render(<MenuBar />)
    await userEvent.click(trigger('Insert'))
    expect(
      within(popup('Insert'))
        .getAllByRole('menuitem')
        .map((m) => m.textContent)
    ).toEqual(['SceneCtrl+Shift+S', 'ChapterCtrl+Shift+C', 'ArcCtrl+Shift+P', 'Scene break'])
  })
})
