import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useDialogStore } from '@renderer/features/shell/dialogs/dialogStore'
import { registerPendingSave, resetPendingSaves } from './pendingSaves'
import { installSaveOnBlur } from './saveOnBlur'

let uninstall: () => void = () => undefined

function setVisibility(state: DocumentVisibilityState): void {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state })
}

beforeEach(() => {
  resetPendingSaves()
  useDialogStore.setState({ modals: [], toasts: [] })
})
afterEach(() => {
  uninstall()
  uninstall = () => undefined
  resetPendingSaves()
  Reflect.deleteProperty(document, 'visibilityState')
})

describe('installSaveOnBlur (F-8.3)', () => {
  it('flushes pending saves when the window loses focus, until uninstalled', async () => {
    const flush = vi.fn(() => Promise.resolve())
    registerPendingSave(flush)
    uninstall = installSaveOnBlur()
    window.dispatchEvent(new Event('blur'))
    expect(flush).toHaveBeenCalledTimes(1)
    uninstall()
    window.dispatchEvent(new Event('blur'))
    expect(flush).toHaveBeenCalledTimes(1)
  })

  it('flushes when the page is hidden, not when it shows again', () => {
    const flush = vi.fn(() => Promise.resolve())
    registerPendingSave(flush)
    uninstall = installSaveOnBlur()
    setVisibility('visible')
    document.dispatchEvent(new Event('visibilitychange'))
    expect(flush).not.toHaveBeenCalled()
    setVisibility('hidden')
    document.dispatchEvent(new Event('visibilitychange'))
    expect(flush).toHaveBeenCalledTimes(1)
  })

  it('toasts a failed save', async () => {
    registerPendingSave(() => Promise.reject(new Error('disk full')))
    uninstall = installSaveOnBlur()
    window.dispatchEvent(new Event('blur'))
    await vi.waitFor(() =>
      expect(useDialogStore.getState().toasts.map((t) => t.message)).toEqual(['disk full'])
    )
  })
})
