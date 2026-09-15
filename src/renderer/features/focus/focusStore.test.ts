import { beforeEach, describe, expect, it } from 'vitest'
import type { Channel, EventName, EventPayload, Input, Output } from '@shared/ipc/contract'
import { useDialogStore } from '@renderer/features/shell/dialogs/dialogStore'
import { IpcRequestError, setIpcClient, type IpcClient } from '@renderer/lib/ipc'
import { escapeFocusMode, resetFocusStore, useFocusStore } from './focusStore'

/** Main→renderer event listeners captured by `install()`, keyed by event name. */
const listeners = new Map<string, (payload: never) => void>()

/**
 * A fake main whose window answers `window:setFullScreen` with `answer(on)` (the real one
 * reports what the window manager did, which may differ from the request).
 */
function install(
  answer: (on: boolean) => boolean | Error = (on) => on
): Input<'window:setFullScreen'>[] {
  const calls: Input<'window:setFullScreen'>[] = []
  const client: IpcClient = {
    async invoke<C extends Channel>(channel: C, input: Input<C>): Promise<Output<C>> {
      if (channel !== 'window:setFullScreen') throw new Error(`unexpected ${channel}`)
      const request = input as Input<'window:setFullScreen'>
      calls.push(request)
      const on = answer(request.on)
      if (on instanceof Error) throw on
      return { on } as Output<C>
    },
    on: <E extends EventName>(event: E, listener: (payload: EventPayload<E>) => void) => {
      listeners.set(event, listener)
      return () => {
        listeners.delete(event)
      }
    }
  }
  setIpcClient(client)
  return calls
}

const fire = (on: boolean): void => {
  const listener = listeners.get('window:fullScreenChanged')
  if (!listener) throw new Error('not subscribed')
  listener({ on } as never)
}
const toasts = (): string[] => useDialogStore.getState().toasts.map((t) => t.message)

beforeEach(() => {
  listeners.clear()
  resetFocusStore()
  useDialogStore.setState({ modals: [], toasts: [] })
})

describe('focusStore (F-6.1)', () => {
  it('enter, exit, and toggle ask main and take the state it answers', async () => {
    const calls = install()
    const store = useFocusStore.getState()
    await store.enter()
    expect(useFocusStore.getState().active).toBe(true)
    await store.exit()
    expect(useFocusStore.getState().active).toBe(false)
    await store.toggle()
    expect(useFocusStore.getState().active).toBe(true)
    await store.toggle()
    expect(useFocusStore.getState().active).toBe(false)
    expect(calls).toEqual([{ on: true }, { on: false }, { on: true }, { on: false }])
  })

  it('stays windowed when the window manager refuses fullscreen', async () => {
    install(() => false)
    await useFocusStore.getState().enter()
    expect(useFocusStore.getState().active).toBe(false)
  })

  it('mirrors the window events once subscribed, and stops after the unsubscribe', () => {
    install()
    const off = useFocusStore.getState().subscribe()
    fire(true)
    expect(useFocusStore.getState().active).toBe(true)
    fire(false)
    expect(useFocusStore.getState().active).toBe(false)
    off()
    expect(listeners.has('window:fullScreenChanged')).toBe(false)
  })

  it('subscribes once for repeated calls', () => {
    install()
    const first = useFocusStore.getState().subscribe()
    const captured = listeners.get('window:fullScreenChanged')
    useFocusStore.getState().subscribe()
    expect(listeners.get('window:fullScreenChanged')).toBe(captured)
    first()
    expect(listeners.size).toBe(0)
  })

  it('toasts a refused call and leaves the state as it was', async () => {
    install(() => new IpcRequestError({ code: 'INTERNAL', message: 'No window' }))
    await useFocusStore.getState().enter()
    expect(useFocusStore.getState().active).toBe(false)
    expect(toasts()).toEqual(['No window'])
    useFocusStore.setState({ active: true })
    await useFocusStore.getState().exit()
    expect(useFocusStore.getState().active).toBe(true)
  })

  it('escapeFocusMode leaves only when active and says whether it used the key', async () => {
    const calls = install()
    expect(escapeFocusMode()).toBe(false)
    expect(calls).toEqual([])
    await useFocusStore.getState().enter()
    expect(escapeFocusMode()).toBe(true)
    await Promise.resolve()
    await Promise.resolve()
    expect(calls).toEqual([{ on: true }, { on: false }])
    expect(useFocusStore.getState().active).toBe(false)
  })

  it('resets to windowed with the panels closed and drops the subscription', () => {
    install()
    useFocusStore.getState().subscribe()
    useFocusStore.setState({ active: true, panels: { notes: true, assistant: true } })
    resetFocusStore()
    expect(useFocusStore.getState().active).toBe(false)
    expect(useFocusStore.getState().panels).toEqual({ notes: false, assistant: false })
    expect(listeners.size).toBe(0)
  })
})

describe('focusStore panels (F-6.5)', () => {
  it('starts with both panels closed and toggles each on its own', async () => {
    install()
    await useFocusStore.getState().enter()
    expect(useFocusStore.getState().panels).toEqual({ notes: false, assistant: false })
    useFocusStore.getState().togglePanel('notes')
    expect(useFocusStore.getState().panels).toEqual({ notes: true, assistant: false })
    useFocusStore.getState().togglePanel('assistant')
    expect(useFocusStore.getState().panels).toEqual({ notes: true, assistant: true })
    useFocusStore.getState().togglePanel('notes')
    expect(useFocusStore.getState().panels).toEqual({ notes: false, assistant: true })
  })

  it('closes both panels on exit, so the next entry starts with the editor alone', async () => {
    install()
    await useFocusStore.getState().enter()
    useFocusStore.getState().togglePanel('notes')
    useFocusStore.getState().togglePanel('assistant')
    await useFocusStore.getState().exit()
    expect(useFocusStore.getState().panels).toEqual({ notes: false, assistant: false })
    await useFocusStore.getState().enter()
    expect(useFocusStore.getState().panels).toEqual({ notes: false, assistant: false })
  })

  it('closes both panels when the window leaves fullscreen on its own', () => {
    install()
    useFocusStore.getState().subscribe()
    fire(true)
    useFocusStore.getState().togglePanel('notes')
    fire(false)
    expect(useFocusStore.getState().active).toBe(false)
    expect(useFocusStore.getState().panels).toEqual({ notes: false, assistant: false })
  })

  it('keeps the panels when a refused exit leaves focus mode active', async () => {
    install((on) => (on ? true : new IpcRequestError({ code: 'INTERNAL', message: 'No window' })))
    await useFocusStore.getState().enter()
    useFocusStore.getState().togglePanel('assistant')
    await useFocusStore.getState().exit()
    expect(useFocusStore.getState().active).toBe(true)
    expect(useFocusStore.getState().panels).toEqual({ notes: false, assistant: true })
  })
})
