import { beforeEach, describe, expect, it } from 'vitest'
import { resetOutlineViewStore, useOutlineViewStore } from './outlineViewStore'

beforeEach(() => {
  resetOutlineViewStore()
})

describe('outlineViewStore', () => {
  it('starts on the stacked view', () => {
    expect(useOutlineViewStore.getState().folderView).toBe('stacked')
  })

  it('switches to the cork board and back', () => {
    useOutlineViewStore.getState().setFolderView('cork')
    expect(useOutlineViewStore.getState().folderView).toBe('cork')
    useOutlineViewStore.getState().setFolderView('stacked')
    expect(useOutlineViewStore.getState().folderView).toBe('stacked')
  })

  it('keeps the same state object when the view does not change', () => {
    const before = useOutlineViewStore.getState()
    before.setFolderView('stacked')
    expect(useOutlineViewStore.getState()).toBe(before)
  })
})
