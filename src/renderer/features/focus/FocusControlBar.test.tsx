import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Editor } from '@tiptap/core'
import { defaultAiSettings } from '@shared/aiSettings'
import { defaultFocusSettings, type FocusSettings } from '@shared/focus'
import type { Channel, Input, Output } from '@shared/ipc/contract'
import type { TiptapNodeT } from '@shared/tiptap'
import { resetAiSettingsStore, useAiSettingsStore } from '@renderer/features/ai/aiSettingsStore'
import {
  resetActiveEditorStore,
  useActiveEditorStore
} from '@renderer/features/editor/activeEditorStore'
import { buildExtensions } from '@renderer/features/editor/extensions'
import { SETTINGS_SAVE_DELAY_MS } from '@renderer/features/editor/settingsStore'
import { resetPendingSaves } from '@renderer/features/project/pendingSaves'
import { useDialogStore } from '@renderer/features/shell/dialogs/dialogStore'
import { setIpcClient, type IpcClient } from '@renderer/lib/ipc'
import { HIDE_DELAY_MS, INTRO_MS, SHOW_ZONE_PX } from './autoHide'
import { resetBackgroundStore, useBackgroundStore } from './backgroundStore'
import { FocusControlBar } from './FocusControlBar'
import { resetFocusStore, useFocusStore } from './focusStore'

const doc = (text: string): TiptapNodeT => ({
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text }] }]
})

const newEditor = (text: string): Editor =>
  new Editor({
    extensions: buildExtensions({ sceneBreak: '~~~', onSave: () => {}, inlineTagNodeId: 'sc-1' }),
    content: doc(text)
  })

/** A fake main that records the focus-settings writes and does what the window is asked. */
function install(): { settingsWrites: FocusSettings[]; fullScreen: boolean[] } {
  const settingsWrites: FocusSettings[] = []
  const fullScreen: boolean[] = []
  const client: IpcClient = {
    async invoke<C extends Channel>(channel: C, input: Input<C>): Promise<Output<C>> {
      if (channel === 'focusSettings:set') {
        settingsWrites.push(input as FocusSettings)
        return input as Output<C>
      }
      if (channel === 'window:setFullScreen') {
        const { on } = input as Input<'window:setFullScreen'>
        fullScreen.push(on)
        return { on } as Output<C>
      }
      throw new Error(`unexpected ${channel}`)
    },
    on: () => () => {}
  }
  setIpcClient(client)
  return { settingsWrites, fullScreen }
}

const bar = (): HTMLElement => screen.getByRole('toolbar', { name: 'Focus controls' })
const visible = (): string | null => bar().getAttribute('data-visible')
const pointerAt = (clientY: number): void => {
  fireEvent.pointerMove(document, { clientY })
}
const advance = (ms: number): void => {
  act(() => {
    vi.advanceTimersByTime(ms)
  })
}

const reset = (): void => {
  resetPendingSaves()
  resetBackgroundStore()
  resetAiSettingsStore()
  resetFocusStore()
  resetActiveEditorStore()
  useDialogStore.setState({ modals: [], toasts: [] })
}

beforeEach(() => {
  vi.useFakeTimers()
  reset()
  useFocusStore.setState({ active: true })
  useBackgroundStore.setState({ backgrounds: [], settings: defaultFocusSettings() })
  useAiSettingsStore.setState({ settings: { ...defaultAiSettings(), dial: 2 } })
  vi.stubGlobal('innerHeight', 800)
})
afterEach(() => {
  reset()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('FocusControlBar (F-6.5)', () => {
  it('shows for the intro, then only near the bottom edge, over the bar, or with focus inside', () => {
    install()
    render(<FocusControlBar />)
    expect(bar()).toHaveAttribute('data-testid', 'focus-control-bar')
    expect(visible()).toBe('true')
    advance(INTRO_MS)
    expect(visible()).toBe('false')

    // The pointer within the show zone of the bottom edge shows it; away from it, the delay runs.
    pointerAt(800 - SHOW_ZONE_PX)
    expect(visible()).toBe('true')
    pointerAt(400)
    expect(visible()).toBe('true')
    advance(HIDE_DELAY_MS - 1)
    expect(visible()).toBe('true')
    advance(1)
    expect(visible()).toBe('false')
    pointerAt(800 - SHOW_ZONE_PX - 1)
    expect(visible()).toBe('false')

    // Over the bar it stays, whatever the edge says.
    fireEvent.pointerEnter(bar())
    expect(visible()).toBe('true')
    advance(HIDE_DELAY_MS * 2)
    expect(visible()).toBe('true')
    fireEvent.pointerLeave(bar())
    advance(HIDE_DELAY_MS)
    expect(visible()).toBe('false')

    // Keyboard focus inside it (Tab from the editor) shows it; focus leaving the bar releases.
    const notes = within(bar()).getByRole('button', { name: 'Notes' })
    fireEvent.focus(notes)
    expect(visible()).toBe('true')
    fireEvent.blur(notes, { relatedTarget: null })
    advance(HIDE_DELAY_MS)
    expect(visible()).toBe('false')
  })

  it('moving focus between its own controls keeps it shown', () => {
    install()
    render(<FocusControlBar />)
    advance(INTRO_MS)
    const notes = within(bar()).getByRole('button', { name: 'Notes' })
    const exit = within(bar()).getByRole('button', { name: 'Exit focus mode' })
    fireEvent.focus(notes)
    fireEvent.blur(notes, { relatedTarget: exit })
    fireEvent.focus(exit)
    advance(HIDE_DELAY_MS * 2)
    expect(visible()).toBe('true')
  })

  it('opens the Background Manager and stays shown while it is open', () => {
    install()
    render(<FocusControlBar />)
    fireEvent.click(within(bar()).getByRole('button', { name: 'Backgrounds…' }))
    const dialog = screen.getByRole('dialog', { name: 'Backgrounds' })
    expect(bar()).not.toContainElement(dialog)
    advance(INTRO_MS + HIDE_DELAY_MS)
    expect(visible()).toBe('true')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Close backgrounds' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    advance(HIDE_DELAY_MS)
    expect(visible()).toBe('false')
  })

  it('Rotate toggles the rotation setting through the store, which persists it', () => {
    const { settingsWrites } = install()
    render(<FocusControlBar />)
    const rotate = within(bar()).getByRole('button', { name: 'Rotate' })
    expect(rotate).toHaveAttribute('aria-pressed', 'false')
    fireEvent.click(rotate)
    expect(rotate).toHaveAttribute('aria-pressed', 'true')
    expect(useBackgroundStore.getState().settings?.rotation.enabled).toBe(true)
    advance(SETTINGS_SAVE_DELAY_MS)
    expect(settingsWrites.map((w) => w.rotation.enabled)).toEqual([true])
    fireEvent.click(rotate)
    expect(rotate).toHaveAttribute('aria-pressed', 'false')
  })

  it('carries the VibeWrite toggle wired to the AI settings', () => {
    install()
    render(<FocusControlBar />)
    const vibe = within(bar()).getByRole('button', { name: 'VibeWrite' })
    expect(vibe).toHaveAttribute('aria-pressed', 'false')
    fireEvent.click(vibe)
    expect(useAiSettingsStore.getState().settings?.ghostText.enabled).toBe(true)
    expect(vibe).toHaveAttribute('aria-pressed', 'true')
  })

  it('Notes and AI assistant toggle the focus store flags, never the layout', () => {
    install()
    render(<FocusControlBar />)
    const notes = within(bar()).getByRole('button', { name: 'Notes' })
    const assistant = within(bar()).getByRole('button', { name: 'AI assistant' })
    expect(notes).toHaveAttribute('aria-pressed', 'false')
    expect(assistant).toHaveAttribute('aria-pressed', 'false')
    fireEvent.click(notes)
    expect(useFocusStore.getState().panels).toEqual({ notes: true, assistant: false })
    expect(notes).toHaveAttribute('aria-pressed', 'true')
    fireEvent.click(assistant)
    expect(useFocusStore.getState().panels).toEqual({ notes: true, assistant: true })
    fireEvent.click(notes)
    expect(useFocusStore.getState().panels).toEqual({ notes: false, assistant: true })
  })

  it('the darkness and width sliders drive the overlay setting and show their values', () => {
    const { settingsWrites } = install()
    render(<FocusControlBar />)
    const darkness = within(bar()).getByRole('slider', { name: 'Darkness' })
    const width = within(bar()).getByRole('slider', { name: 'Width' })
    expect(darkness).toHaveValue('60')
    expect(width).toHaveValue('70')
    expect(screen.getByTestId('focus-darkness-value')).toHaveTextContent('60 %')
    expect(screen.getByTestId('focus-width-value')).toHaveTextContent('70 %')
    fireEvent.change(darkness, { target: { value: '30' } })
    fireEvent.change(width, { target: { value: '50' } })
    expect(useBackgroundStore.getState().settings?.overlay).toEqual({ darkness: 30, width: 50 })
    expect(screen.getByTestId('focus-darkness-value')).toHaveTextContent('30 %')
    expect(screen.getByTestId('focus-width-value')).toHaveTextContent('50 %')
    advance(SETTINGS_SAVE_DELAY_MS)
    expect(settingsWrites.map((w) => w.overlay)).toEqual([{ darkness: 30, width: 50 }])
  })

  it('disables the settings controls until the focus settings load', () => {
    install()
    useBackgroundStore.setState({ settings: null })
    render(<FocusControlBar />)
    expect(within(bar()).getByRole('button', { name: 'Rotate' })).toBeDisabled()
    expect(within(bar()).getByRole('slider', { name: 'Darkness' })).toBeDisabled()
    expect(within(bar()).getByRole('slider', { name: 'Width' })).toBeDisabled()
    expect(within(bar()).getByRole('button', { name: 'Exit focus mode' })).toBeEnabled()
  })

  it('shows the live word count of the active editor, blank without one', () => {
    install()
    const editor = newEditor('one two three')
    render(<FocusControlBar />)
    expect(screen.getByTestId('focus-words')).toHaveTextContent('')
    act(() => useActiveEditorStore.getState().set('sc-1', editor))
    expect(screen.getByTestId('focus-words')).toHaveTextContent('3 words')
    act(() => {
      editor.commands.insertContentAt(editor.state.doc.content.size - 1, ' four')
    })
    expect(screen.getByTestId('focus-words')).toHaveTextContent('4 words')
    const other = newEditor('word')
    act(() => useActiveEditorStore.getState().set('sc-2', other))
    expect(screen.getByTestId('focus-words')).toHaveTextContent('1 word')
    act(() => useActiveEditorStore.getState().release(other))
    expect(screen.getByTestId('focus-words')).toHaveTextContent('')
    editor.destroy()
    other.destroy()
  })

  it('Exit asks the window to leave fullscreen', async () => {
    const { fullScreen } = install()
    render(<FocusControlBar />)
    await act(async () => {
      fireEvent.click(within(bar()).getByRole('button', { name: 'Exit focus mode' }))
    })
    expect(fullScreen).toEqual([false])
    expect(useFocusStore.getState().active).toBe(false)
  })
})
