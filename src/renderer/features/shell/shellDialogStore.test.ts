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
})
