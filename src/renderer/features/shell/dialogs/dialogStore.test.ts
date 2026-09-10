import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { dialogs, toast, useDialogStore } from './dialogStore'

beforeEach(() => {
  useDialogStore.setState({ modals: [], toasts: [] })
})

describe('confirm and prompt', () => {
  it('queues a confirm and resolves it', async () => {
    const promise = dialogs.confirm({ title: 'Delete?', message: 'Gone forever.' })
    const modal = useDialogStore.getState().modals[0]
    expect(modal?.kind).toBe('confirm')
    useDialogStore.getState().resolveConfirm(modal!.id, true)
    await expect(promise).resolves.toBe(true)
    expect(useDialogStore.getState().modals).toHaveLength(0)
  })

  it('queues multiple modals in order', async () => {
    const a = dialogs.confirm({ title: 'A', message: '' })
    const b = dialogs.prompt({ title: 'B' })
    const [first, second] = useDialogStore.getState().modals
    expect(first?.kind).toBe('confirm')
    expect(second?.kind).toBe('prompt')
    useDialogStore.getState().resolveConfirm(first!.id, false)
    useDialogStore.getState().resolvePrompt(second!.id, 'value')
    await expect(a).resolves.toBe(false)
    await expect(b).resolves.toBe('value')
  })

  it('ignores resolution with the wrong kind or unknown id', () => {
    void dialogs.prompt({ title: 'P' })
    const id = useDialogStore.getState().modals[0]!.id
    useDialogStore.getState().resolveConfirm(id, true)
    useDialogStore.getState().resolvePrompt('missing', null)
    expect(useDialogStore.getState().modals).toHaveLength(1)
  })
})

describe('toasts', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('adds a toast and auto-dismisses it after the default duration', () => {
    toast.success('Saved')
    expect(useDialogStore.getState().toasts).toHaveLength(1)
    vi.advanceTimersByTime(2999)
    expect(useDialogStore.getState().toasts).toHaveLength(1)
    vi.advanceTimersByTime(1)
    expect(useDialogStore.getState().toasts).toHaveLength(0)
  })

  it('keeps a toast with duration 0 until dismissed', () => {
    const id = useDialogStore.getState().toast('error', 'Stuck', 0)
    vi.advanceTimersByTime(60_000)
    expect(useDialogStore.getState().toasts).toHaveLength(1)
    useDialogStore.getState().dismissToast(id)
    expect(useDialogStore.getState().toasts).toHaveLength(0)
  })
})
