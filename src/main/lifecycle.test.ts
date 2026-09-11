import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { installSingleInstance, type FocusableWindow, type SingleInstanceApp } from './lifecycle'

function fakeApp(granted: boolean): EventEmitter & SingleInstanceApp {
  return Object.assign(new EventEmitter(), { requestSingleInstanceLock: () => granted })
}

function fakeWindow(
  minimized: boolean
): FocusableWindow & { restore: () => void; focus: () => void } {
  return { isMinimized: () => minimized, restore: vi.fn(), focus: vi.fn() }
}

describe('installSingleInstance', () => {
  it('holds the lock and focuses the window when a second instance launches', () => {
    const app = fakeApp(true)
    const win = fakeWindow(false)
    expect(installSingleInstance(app, () => win)).toBe(true)
    app.emit('second-instance')
    expect(win.restore).not.toHaveBeenCalled()
    expect(win.focus).toHaveBeenCalledTimes(1)
  })

  it('restores a minimized window before focusing it', () => {
    const app = fakeApp(true)
    const win = fakeWindow(true)
    installSingleInstance(app, () => win)
    app.emit('second-instance')
    expect(win.restore).toHaveBeenCalledTimes(1)
    expect(win.focus).toHaveBeenCalledTimes(1)
  })

  it('does nothing when there is no window yet', () => {
    const app = fakeApp(true)
    installSingleInstance(app, () => null)
    expect(() => app.emit('second-instance')).not.toThrow()
  })

  it('reports a refused lock and registers no listener', () => {
    const app = fakeApp(false)
    expect(installSingleInstance(app, () => fakeWindow(false))).toBe(false)
    expect(app.listenerCount('second-instance')).toBe(0)
  })
})
