import { beforeEach, describe, expect, it } from 'vitest'
import { resetShellDialogStore, useShellDialogStore } from './shellDialogStore'

beforeEach(() => {
  resetShellDialogStore()
})

describe('shellDialogStore (F-7.1)', () => {
  it('starts closed, shows one dialog at a time, and closes', () => {
    expect(useShellDialogStore.getState().open).toBeNull()
    useShellDialogStore.getState().show('shortcuts')
    expect(useShellDialogStore.getState().open).toBe('shortcuts')
    useShellDialogStore.getState().show('about')
    expect(useShellDialogStore.getState().open).toBe('about')
    useShellDialogStore.getState().close()
    expect(useShellDialogStore.getState().open).toBeNull()
  })

  it('remembers the Settings tab an opener named, and forgets it on close (F-15.5)', () => {
    expect(useShellDialogStore.getState().settingsTab).toBeNull()
    useShellDialogStore.getState().show('settings', 'account')
    expect(useShellDialogStore.getState().open).toBe('settings')
    expect(useShellDialogStore.getState().settingsTab).toBe('account')
    useShellDialogStore.getState().close()
    expect(useShellDialogStore.getState().settingsTab).toBeNull()
    // An opener that names no tab leaves the dialog on its own first one.
    useShellDialogStore.getState().show('settings', 'account')
    useShellDialogStore.getState().show('settings')
    expect(useShellDialogStore.getState().settingsTab).toBeNull()
  })
})
