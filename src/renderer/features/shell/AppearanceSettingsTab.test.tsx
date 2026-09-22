import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Channel, EventName, EventPayload, Input, Output } from '@shared/ipc/contract'
import { nextZoom, type ViewSettings } from '@shared/zoom'
import { useDialogStore } from '@renderer/features/shell/dialogs/dialogStore'
import { setIpcClient, type IpcClient } from '@renderer/lib/ipc'
import { AppearanceSettingsTab } from './AppearanceSettingsTab'
import { resetViewStore, useViewStore } from './viewStore'

let calls: { channel: Channel; input: unknown }[]
/** What main holds; it steps and answers exactly as the handlers do. */
let view: ViewSettings

const client: IpcClient = {
  async invoke<C extends Channel>(channel: C, input: Input<C>): Promise<Output<C>> {
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
      default:
        throw new Error(`unexpected ${channel}`)
    }
  },
  on<E extends EventName>(_event: E, _listener: (payload: EventPayload<E>) => void): () => void {
    return () => undefined
  }
}

const level = (): string => screen.getByTestId('appearance-document-zoom').textContent ?? ''
const sizes = (): HTMLElement[] => screen.getAllByRole('radio')

beforeEach(() => {
  resetViewStore()
  calls = []
  view = { editorZoom: 1, uiScale: 'medium' }
  setIpcClient(client)
  useDialogStore.setState({ modals: [], toasts: [] })
})
afterEach(() => {
  resetViewStore()
})

describe('AppearanceSettingsTab (F-7.10)', () => {
  it('asks main for the settings it has not got yet and shows them', async () => {
    view = { editorZoom: 1.25, uiScale: 'large' }
    render(<AppearanceSettingsTab />)
    await waitFor(() => expect(level()).toBe('125 %'))
    expect(calls).toEqual([{ channel: 'view:get', input: undefined }])
    expect(screen.getByTestId('appearance-ui-scale-large')).toHaveAttribute('aria-checked', 'true')
    expect(sizes().map((b) => b.textContent)).toEqual(['Small90 %', 'Medium100 %', 'Large115 %'])
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
    useViewStore.setState({ editorZoom: 1, uiScale: 'medium', loaded: true })
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
