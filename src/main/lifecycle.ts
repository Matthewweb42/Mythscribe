/**
 * The parts of Electron's `app` the lock needs. Structural (not `Pick<App>`) because `App['on']`
 * returns the polymorphic `this`, which no fake can satisfy under test.
 */
export interface SingleInstanceApp {
  requestSingleInstanceLock(): boolean
  on(event: 'second-instance', listener: () => void): unknown
}

/** The parts of a BrowserWindow a second launch needs: bring the existing window to the front. */
export interface FocusableWindow {
  isMinimized(): boolean
  restore(): void
  focus(): void
}

/**
 * Only one MythScribe runs at a time (F-1.4: one project open at a time). A second launch hands
 * off to the running instance, which restores and focuses its window. Returns whether this
 * process holds the lock; the caller quits when it does not.
 */
export function installSingleInstance(
  app: SingleInstanceApp,
  getWindow: () => FocusableWindow | null
): boolean {
  const locked = app.requestSingleInstanceLock()
  if (!locked) return false
  app.on('second-instance', () => {
    const win = getWindow()
    if (!win) return
    if (win.isMinimized()) win.restore()
    win.focus()
  })
  return true
}
