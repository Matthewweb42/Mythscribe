import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Channel, EventName, EventPayload, Input, Output } from '@shared/ipc/contract'
import type { SupporterStatus } from '@shared/license'
import { builtInTheme, type CustomTheme, type CustomThemeInput } from '@shared/themes'
import { defaultViewSettings, nextZoom, type ViewSettings } from '@shared/zoom'
import { resetAccountStore, useAccountStore } from '@renderer/features/account/accountStore'
import { useDialogStore } from '@renderer/features/shell/dialogs/dialogStore'
import { setIpcClient, type IpcClient } from '@renderer/lib/ipc'
import { AppearanceSettingsTab } from './AppearanceSettingsTab'
import { resetViewStore, useViewStore } from './viewStore'

let calls: { channel: Channel; input: unknown }[]
/** What main holds; it steps and answers exactly as the handlers do. */
let view: ViewSettings
/** F-7.9: the startup choice main holds; its requests are kept apart from the view ones. */
let reopenLastProject: boolean
let startupCalls: { channel: Channel; input: unknown }[]

const client: IpcClient = {
  async invoke<C extends Channel>(channel: C, input: Input<C>): Promise<Output<C>> {
    if (channel === 'startup:get' || channel === 'startup:setReopenLastProject') {
      startupCalls.push({ channel, input })
      if (channel === 'startup:setReopenLastProject') {
        reopenLastProject = (input as { on: boolean }).on
      }
      return { reopenLastProject } as Output<C>
    }
    calls.push({ channel, input })
    switch (channel) {
      case 'view:get':
        return view as Output<C>
      case 'view:zoomDocument': {
        const { step } = input as { step: 'in' | 'out' | 'reset' }
        view = { ...view, editorZoom: nextZoom(view.editorZoom, step) }
        return view as Output<C>
      }
      case 'view:setUiScale': {
        const { scale } = input as { scale: ViewSettings['uiScale'] }
        view = { ...view, uiScale: scale }
        return view as Output<C>
      }
      case 'view:setPageEdges': {
        const { on } = input as { on: boolean }
        view = { ...view, pageEdges: on }
        return view as Output<C>
      }
      case 'view:setTheme': {
        view = { ...view, theme: (input as { theme: string }).theme }
        return view as Output<C>
      }
      case 'view:saveCustomTheme': {
        const { theme } = input as { theme: CustomThemeInput }
        const saved: CustomTheme = { ...theme, id: theme.id ?? 'custom-a1b2c3d4e5f6' }
        const others = view.customThemes.filter((t) => t.id !== saved.id)
        view = { ...view, theme: saved.id, customThemes: [...others, saved] }
        return view as Output<C>
      }
      case 'view:deleteCustomTheme': {
        const { id } = input as { id: string }
        const gone = view.customThemes.find((t) => t.id === id)
        view = {
          ...view,
          theme: view.theme === id && gone ? gone.base : view.theme,
          customThemes: view.customThemes.filter((t) => t.id !== id)
        }
        return view as Output<C>
      }
      default:
        throw new Error(`unexpected ${channel}`)
    }
  },
  on<E extends EventName>(_event: E, _listener: (payload: EventPayload<E>) => void): () => void {
    return () => undefined
  }
}

const level = (): string => screen.getByTestId('appearance-document-zoom').textContent ?? ''
const sizes = (): HTMLElement[] =>
  within(screen.getByRole('radiogroup', { name: 'Interface size' })).getAllByRole('radio')

beforeEach(() => {
  resetViewStore()
  resetAccountStore()
  calls = []
  startupCalls = []
  reopenLastProject = true
  view = defaultViewSettings()
  setIpcClient(client)
  useDialogStore.setState({ modals: [], toasts: [] })
})
afterEach(() => {
  resetViewStore()
  resetAccountStore()
})

describe('AppearanceSettingsTab (F-7.10)', () => {
  it('asks main for the settings it has not got yet and shows them', async () => {
    view = { ...defaultViewSettings(), editorZoom: 1.25, uiScale: 'large', pageEdges: false }
    render(<AppearanceSettingsTab />)
    await waitFor(() => expect(level()).toBe('125 %'))
    expect(calls).toEqual([{ channel: 'view:get', input: undefined }])
    expect(screen.getByTestId('appearance-ui-scale-large')).toHaveAttribute('aria-checked', 'true')
    expect(sizes().map((b) => b.textContent)).toEqual(['Small90 %', 'Medium100 %', 'Large115 %'])
    expect(screen.getByRole('checkbox', { name: 'Show page edges' })).not.toBeChecked()
  })

  it('flips the page edges silently (F-7.11)', async () => {
    useViewStore.setState({ ...view, loaded: true })
    render(<AppearanceSettingsTab />)
    const edges = screen.getByTestId('appearance-page-edges')
    expect(edges).toBeChecked()
    await userEvent.click(edges)
    await waitFor(() => expect(edges).not.toBeChecked())
    await userEvent.click(edges)
    await waitFor(() => expect(edges).toBeChecked())
    expect(calls).toEqual([
      { channel: 'view:setPageEdges', input: { on: false } },
      { channel: 'view:setPageEdges', input: { on: true } }
    ])
    expect(useDialogStore.getState().toasts).toEqual([])
  })

  it('applies an interface size at once, without asking again for what is already loaded', async () => {
    useViewStore.setState({ ...view, loaded: true })
    render(<AppearanceSettingsTab />)
    expect(calls).toEqual([])
    await userEvent.click(screen.getByTestId('appearance-ui-scale-small'))
    await waitFor(() =>
      expect(screen.getByTestId('appearance-ui-scale-small')).toHaveAttribute(
        'aria-checked',
        'true'
      )
    )
    expect(calls).toEqual([{ channel: 'view:setUiScale', input: { scale: 'small' } }])
    // The size is what the window does; only the zoom announces itself.
    expect(useDialogStore.getState().toasts).toEqual([])
  })

  it('steps the document zoom with − and + and puts it back with Reset', async () => {
    useViewStore.setState({ ...view, loaded: true })
    render(<AppearanceSettingsTab />)
    await userEvent.click(screen.getByRole('button', { name: 'Zoom in' }))
    await waitFor(() => expect(level()).toBe('110 %'))
    await userEvent.click(screen.getByRole('button', { name: 'Zoom out' }))
    await waitFor(() => expect(level()).toBe('100 %'))
    await userEvent.click(screen.getByRole('button', { name: 'Zoom in' }))
    await waitFor(() => expect(level()).toBe('110 %'))
    await userEvent.click(screen.getByRole('button', { name: 'Reset' }))
    await waitFor(() => expect(level()).toBe('100 %'))
    expect(calls.map((c) => c.input)).toEqual([
      { step: 'in' },
      { step: 'out' },
      { step: 'in' },
      { step: 'reset' }
    ])
    expect(useDialogStore.getState().toasts.map((t) => t.message)).toEqual([
      'Document zoom 110 %',
      'Document zoom 100 %',
      'Document zoom 110 %',
      'Document zoom 100 %'
    ])
  })

  it('offers no step past the ends of the table and no Reset at 100 %', () => {
    useViewStore.setState({ editorZoom: 1, uiScale: 'medium', pageEdges: true, loaded: true })
    render(<AppearanceSettingsTab />)
    expect(screen.getByRole('button', { name: 'Reset' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Zoom in' })).toBeEnabled()

    act(() => useViewStore.setState({ editorZoom: 2 }))
    expect(screen.getByRole('button', { name: 'Zoom in' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Zoom out' })).toBeEnabled()

    act(() => useViewStore.setState({ editorZoom: 0.67 }))
    expect(screen.getByRole('button', { name: 'Zoom out' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Zoom in' })).toBeEnabled()
  })
})

describe('AppearanceSettingsTab startup (F-7.9)', () => {
  it('shows whether the last project reopens and changes it in main', async () => {
    useViewStore.setState({ ...view, loaded: true })
    reopenLastProject = false
    render(<AppearanceSettingsTab />)
    const reopen = screen.getByRole('checkbox', { name: 'Reopen the last project on launch' })
    await waitFor(() => expect(reopen).toBeEnabled())
    expect(reopen).not.toBeChecked()
    await userEvent.click(reopen)
    await waitFor(() => expect(reopen).toBeChecked())
    expect(reopenLastProject).toBe(true)
    expect(startupCalls).toEqual([
      { channel: 'startup:get', input: undefined },
      { channel: 'startup:setReopenLastProject', input: { on: true } }
    ])
    expect(useDialogStore.getState().toasts).toEqual([])
  })
})

const SUPPORTER: SupporterStatus = {
  licensed: true,
  since: '2026-09-20T10:00:00.000Z',
  validUntil: null,
  offline: false,
  product: null,
  accent: 'default'
}
const MIDNIGHT: CustomTheme = {
  id: 'custom-0123456789ab',
  name: 'Midnight',
  base: 'dark',
  colors: { ...builtInTheme('dark').colors, bg: '#000814' }
}

const themeCard = (id: string): HTMLElement => screen.getByTestId(`appearance-theme-${id}`)

describe('AppearanceSettingsTab theme (F-7.8)', () => {
  it('offers the free themes, shows Sepia locked without a license, and picks one silently', async () => {
    useViewStore.setState({ ...view, loaded: true })
    render(<AppearanceSettingsTab />)
    const group = screen.getByRole('radiogroup', { name: 'Theme' })
    expect(
      within(group)
        .getAllByRole('radio')
        .map((r) => r.getAttribute('aria-label'))
    ).toEqual(['Dark', 'Light', 'High contrast', 'Sepia'])
    expect(themeCard('dark')).toHaveAttribute('aria-checked', 'true')
    expect(themeCard('sepia')).toBeDisabled()
    expect(themeCard('sepia')).toHaveAttribute('title', 'Supporter license needed')
    expect(screen.getByTestId('appearance-theme-new')).toBeDisabled()
    await userEvent.click(themeCard('light'))
    await waitFor(() => expect(themeCard('light')).toHaveAttribute('aria-checked', 'true'))
    expect(calls).toEqual([{ channel: 'view:setTheme', input: { theme: 'light' } }])
    expect(useDialogStore.getState().toasts).toEqual([])
  })

  it('checks Dark while a locked choice is kept, and still lets the author delete it', async () => {
    view = { ...view, theme: MIDNIGHT.id, customThemes: [MIDNIGHT] }
    useViewStore.setState({ ...view, loaded: true })
    render(<AppearanceSettingsTab />)
    expect(themeCard('dark')).toHaveAttribute('aria-checked', 'true')
    expect(themeCard(MIDNIGHT.id)).toBeDisabled()
    expect(screen.getByTestId('appearance-theme-edit')).toBeDisabled()
    await userEvent.click(screen.getByTestId('appearance-theme-delete'))
    // Asked through the dialog service (F-7.6) before anything is sent.
    const [modal] = useDialogStore.getState().modals
    expect(modal).toMatchObject({
      kind: 'confirm',
      options: {
        title: 'Delete theme',
        message: 'Delete “Midnight”? The window goes back to its base theme, Dark.'
      }
    })
    expect(calls).toEqual([])
    act(() => useDialogStore.getState().resolveConfirm(modal!.id, true))
    await waitFor(() => expect(view.customThemes).toEqual([]))
    expect(calls.at(-1)).toEqual({
      channel: 'view:deleteCustomTheme',
      input: { id: MIDNIGHT.id }
    })
  })

  it('creates a custom theme from the painted one and selects it with a license', async () => {
    useAccountStore.setState({ supporter: SUPPORTER })
    useViewStore.setState({ ...view, theme: 'sepia', loaded: true })
    render(<AppearanceSettingsTab />)
    expect(themeCard('sepia')).toBeEnabled()
    await userEvent.click(screen.getByTestId('appearance-theme-new'))
    const editor = screen.getByTestId('theme-editor')
    expect(within(editor).getByLabelText('Name')).toHaveValue('Custom theme 1')
    expect(within(editor).getByLabelText('Base')).toHaveValue('sepia')
    expect(within(editor).getByLabelText('Page')).toHaveValue(builtInTheme('sepia').colors.sheet)
    const name = within(editor).getByLabelText('Name')
    await userEvent.clear(name)
    await userEvent.type(name, 'Parchment')
    // A native colour input: change is what the picker fires.
    act(() => {
      const background = within(editor).getByLabelText('Background')
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(
        background,
        '#F0E0C0'
      )
      background.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await userEvent.click(within(editor).getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(screen.queryByTestId('theme-editor')).not.toBeInTheDocument())
    expect(calls.at(-1)).toEqual({
      channel: 'view:saveCustomTheme',
      input: {
        theme: {
          name: 'Parchment',
          base: 'sepia',
          colors: { ...builtInTheme('sepia').colors, bg: '#f0e0c0' }
        }
      }
    })
    expect(themeCard('custom-a1b2c3d4e5f6')).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByTestId('appearance-theme-edit')).toHaveTextContent('Edit “Parchment”…')
  })

  it('a new theme follows the base until a colour is changed; Cancel sends nothing', async () => {
    useAccountStore.setState({ supporter: SUPPORTER })
    useViewStore.setState({ ...view, loaded: true })
    render(<AppearanceSettingsTab />)
    await userEvent.click(screen.getByTestId('appearance-theme-new'))
    const editor = screen.getByTestId('theme-editor')
    await userEvent.selectOptions(within(editor).getByLabelText('Base'), 'light')
    expect(within(editor).getByLabelText('Text')).toHaveValue(builtInTheme('light').colors.fg)
    await userEvent.click(within(editor).getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByTestId('theme-editor')).not.toBeInTheDocument()
    expect(calls).toEqual([])
  })

  it('edits the selected custom theme in place', async () => {
    useAccountStore.setState({ supporter: SUPPORTER })
    view = { ...view, theme: MIDNIGHT.id, customThemes: [MIDNIGHT] }
    useViewStore.setState({ ...view, loaded: true })
    render(<AppearanceSettingsTab />)
    expect(themeCard(MIDNIGHT.id)).toHaveAttribute('aria-checked', 'true')
    await userEvent.click(screen.getByTestId('appearance-theme-edit'))
    const editor = screen.getByTestId('theme-editor')
    expect(within(editor).getByLabelText('Background')).toHaveValue('#000814')
    await userEvent.type(within(editor).getByLabelText('Name'), ' blue')
    await userEvent.click(within(editor).getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(view.customThemes[0]?.name).toBe('Midnight blue'))
    expect(calls.at(-1)).toEqual({
      channel: 'view:saveCustomTheme',
      input: { theme: { ...MIDNIGHT, name: 'Midnight blue' } }
    })
  })

  it('holds the accent picker, moved here from the Account tab', () => {
    useViewStore.setState({ ...view, loaded: true })
    render(<AppearanceSettingsTab />)
    expect(screen.getByRole('group', { name: 'Accent colour' })).toBeInTheDocument()
    expect(screen.getByTestId('account-accent-ember')).toBeDisabled()
  })
})
