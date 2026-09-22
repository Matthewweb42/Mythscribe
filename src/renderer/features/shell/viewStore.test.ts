import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Channel, Input, Output } from '@shared/ipc/contract'
import { nextZoom, type ViewSettings } from '@shared/zoom'
import { useDialogStore } from '@renderer/features/shell/dialogs/dialogStore'
import { setIpcClient, type IpcClient } from '@renderer/lib/ipc'
import { resetViewStore, useViewStore } from './viewStore'

interface Fake {
  client: IpcClient
  calls: { channel: Channel; input: unknown }[]
  /** What main holds; it steps and answers exactly as the handlers do. */
  view: ViewSettings
  /** Thrown by every channel while set, so the failure path is driven. */
  fail: Error | null
}

function fakeClient(): Fake {
  const fake: Fake = {
    calls: [],
    view: { editorZoom: 1, uiScale: 'medium' },
    fail: null,
    client: {
      async invoke<C extends Channel>(channel: C, input: Input<C>): Promise<Output<C>> {
        fake.calls.push({ channel, input })
        if (fake.fail) throw fake.fail
        switch (channel) {
          case 'view:get':
            return fake.view as Output<C>
          case 'view:zoomDocument': {
            const { step } = input as { step: 'in' | 'out' | 'reset' }
            fake.view = { ...fake.view, editorZoom: nextZoom(fake.view.editorZoom, step) }
            return fake.view as Output<C>
          }
          case 'view:setUiScale': {
            const { scale } = input as { scale: ViewSettings['uiScale'] }
            fake.view = { ...fake.view, uiScale: scale }
            return fake.view as Output<C>
          }
          default:
            throw new Error(`unexpected ${channel}`)
        }
      },
      on: () => () => {}
    }
  }
  return fake
}

let fake: Fake

const toasts = (): string[] => useDialogStore.getState().toasts.map((t) => t.message)

beforeEach(() => {
  fake = fakeClient()
  setIpcClient(fake.client)
  resetViewStore()
  useDialogStore.setState({ modals: [], toasts: [] })
})

afterEach(() => {
  resetViewStore()
})

describe('viewStore (F-7.10)', () => {
  it('starts at the installed defaults and takes the persisted values on load', async () => {
    expect(useViewStore.getState()).toMatchObject({
      editorZoom: 1,
      uiScale: 'medium',
      loaded: false
    })
    fake.view = { editorZoom: 1.25, uiScale: 'large' }
    await useViewStore.getState().load()
    expect(useViewStore.getState()).toMatchObject({
      editorZoom: 1.25,
      uiScale: 'large',
      loaded: true
    })
    expect(fake.calls).toEqual([{ channel: 'view:get', input: undefined }])
  })

  it('steps the document zoom and announces where it landed', async () => {
    await useViewStore.getState().zoomDocument('in')
    expect(fake.calls).toEqual([{ channel: 'view:zoomDocument', input: { step: 'in' } }])
    expect(useViewStore.getState().editorZoom).toBe(1.1)
    await useViewStore.getState().zoomDocument('in')
    expect(useViewStore.getState().editorZoom).toBe(1.25)
    await useViewStore.getState().zoomDocument('reset')
    expect(useViewStore.getState().editorZoom).toBe(1)
    expect(toasts()).toEqual(['Document zoom 110 %', 'Document zoom 125 %', 'Document zoom 100 %'])
  })

  it('sets the interface size without a toast: the window is already resized when main answers', async () => {
    await useViewStore.getState().setUiScale('large')
    expect(fake.calls).toEqual([{ channel: 'view:setUiScale', input: { scale: 'large' } }])
    expect(useViewStore.getState().uiScale).toBe('large')
    expect(toasts()).toEqual([])
  })

  it('keeps the two apart: a zoom leaves the size alone and the other way round', async () => {
    await useViewStore.getState().setUiScale('small')
    await useViewStore.getState().zoomDocument('out')
    expect(useViewStore.getState()).toMatchObject({ editorZoom: 0.9, uiScale: 'small' })
  })

  it('toasts the cause of a failure and changes nothing', async () => {
    fake.fail = new Error('no window')
    await useViewStore.getState().zoomDocument('in')
    await useViewStore.getState().setUiScale('large')
    expect(useViewStore.getState()).toMatchObject({ editorZoom: 1, uiScale: 'medium' })
    expect(toasts()).toEqual(['no window', 'no window'])
  })

  it('drops an answer to a request the reset superseded', async () => {
    const pending = useViewStore.getState().zoomDocument('in')
    resetViewStore()
    await pending
    expect(useViewStore.getState()).toMatchObject({ editorZoom: 1, loaded: false })
  })
})
