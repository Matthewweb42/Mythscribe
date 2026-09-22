import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Channel, Input, Output } from '@shared/ipc/contract'
import { useDialogStore } from '@renderer/features/shell/dialogs/dialogStore'
import { setIpcClient, type IpcClient } from '@renderer/lib/ipc'
import { ZOOM_MENU_STEPS, zoomStepFor, zoomWindow } from './zoom'

let invoke: ReturnType<typeof vi.fn<(channel: string, input: unknown) => Promise<unknown>>>

/** Main answers `window:zoom` with `factor`, or throws it when it is an error. */
function install(answer: unknown): void {
  invoke = vi.fn(async (channel: string) => {
    if (channel !== 'window:zoom') throw new Error(`unexpected ${channel}`)
    if (answer instanceof Error) throw answer
    return { factor: answer }
  })
  const client: IpcClient = {
    invoke: <C extends Channel>(channel: C, input: Input<C>) =>
      invoke(channel, input) as Promise<Output<C>>,
    on: () => () => {}
  }
  setIpcClient(client)
}

const toasts = (): string[] => useDialogStore.getState().toasts.map((t) => t.message)

/** A keyboard event as the listener sees it, with every modifier up unless named. */
const chord = (
  key: string,
  mods: Partial<Pick<KeyboardEvent, 'ctrlKey' | 'metaKey' | 'shiftKey' | 'altKey'>> = {}
): Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'shiftKey' | 'altKey'> => ({
  key,
  ctrlKey: false,
  metaKey: false,
  shiftKey: false,
  altKey: false,
  ...mods
})

beforeEach(() => {
  install(1.1)
  useDialogStore.setState({ modals: [], toasts: [] })
})

describe('zoomWindow (F-7.10)', () => {
  it('asks main for the step and announces the factor it applied', async () => {
    await zoomWindow('in')
    expect(invoke).toHaveBeenCalledWith('window:zoom', { step: 'in' })
    expect(toasts()).toEqual(['Zoom 110 %'])
    install(1)
    await zoomWindow('reset')
    expect(invoke).toHaveBeenCalledWith('window:zoom', { step: 'reset' })
    expect(toasts()).toEqual(['Zoom 110 %', 'Zoom 100 %'])
  })

  it('toasts the cause when main could not zoom', async () => {
    install(new Error('no window'))
    await zoomWindow('out')
    expect(toasts()).toEqual(['no window'])
  })

  it('maps each View › Zoom item to its step', () => {
    expect(ZOOM_MENU_STEPS).toEqual({ zoomIn: 'in', zoomOut: 'out', zoomReset: 'reset' })
  })
})

describe('zoomStepFor (F-2.7 chords)', () => {
  it('reads Ctrl+= / Ctrl+- / Ctrl+0, and Ctrl+Shift+= as zoom in', () => {
    expect(zoomStepFor(chord('=', { ctrlKey: true }))).toBe('in')
    expect(zoomStepFor(chord('+', { ctrlKey: true, shiftKey: true }))).toBe('in')
    // The numpad reports `+` without Shift.
    expect(zoomStepFor(chord('+', { ctrlKey: true }))).toBe('in')
    expect(zoomStepFor(chord('-', { ctrlKey: true }))).toBe('out')
    expect(zoomStepFor(chord('0', { ctrlKey: true }))).toBe('reset')
  })

  it('ignores the same keys without Ctrl, with Alt, and every other chord', () => {
    expect(zoomStepFor(chord('='))).toBeNull()
    expect(zoomStepFor(chord('0'))).toBeNull()
    expect(zoomStepFor(chord('-'))).toBeNull()
    // Ctrl+Alt+0 is the editor's Paragraph command (F-3.1), not a zoom reset.
    expect(zoomStepFor(chord('0', { ctrlKey: true, altKey: true }))).toBeNull()
    expect(zoomStepFor(chord('=', { ctrlKey: true, shiftKey: true }))).toBeNull()
    expect(zoomStepFor(chord('k', { ctrlKey: true }))).toBeNull()
  })
})
