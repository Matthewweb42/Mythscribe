import { describe, expect, it } from 'vitest'
import { WindowState, defaultWindowState, projectToReopen, restorableBounds } from './windowState'

const MIN = { width: 900, height: 600 }
const PRIMARY = { x: 0, y: 0, width: 1920, height: 1040 }
const RIGHT = { x: 1920, y: 0, width: 1280, height: 1000 }

describe('restorableBounds', () => {
  it('is null when nothing was saved', () => {
    expect(restorableBounds(null, [PRIMARY], MIN)).toBeNull()
  })

  it('puts a window back where it was on a display that is still there', () => {
    const saved = { x: 100, y: 50, width: 1200, height: 800 }
    expect(restorableBounds(saved, [PRIMARY], MIN)).toEqual(saved)
    const second = { x: 2000, y: 100, width: 1000, height: 700 }
    expect(restorableBounds(second, [PRIMARY, RIGHT], MIN)).toEqual(second)
  })

  it('drops a window left on a monitor that is gone', () => {
    expect(
      restorableBounds({ x: 2000, y: 100, width: 1000, height: 700 }, [PRIMARY], MIN)
    ).toBeNull()
  })

  it('drops a window dragged almost off-screen or with its title bar above the display', () => {
    expect(
      restorableBounds({ x: 1850, y: 100, width: 1000, height: 700 }, [PRIMARY], MIN)
    ).toBeNull()
    expect(
      restorableBounds({ x: 100, y: -50, width: 1000, height: 700 }, [PRIMARY], MIN)
    ).toBeNull()
  })

  it('never restores below the minimum size', () => {
    expect(restorableBounds({ x: 10, y: 10, width: 400, height: 300 }, [PRIMARY], MIN)).toEqual({
      x: 10,
      y: 10,
      width: 900,
      height: 600
    })
  })
})

describe('projectToReopen', () => {
  const state = { ...defaultWindowState(), lastProject: '/books/Novel.mythscribe' }

  it('answers the last project while the setting is on and the folder is a project', () => {
    expect(projectToReopen(state, () => true)).toBe('/books/Novel.mythscribe')
  })

  it('answers null when the setting is off, nothing was open, or the folder is gone', () => {
    expect(projectToReopen({ ...state, reopenLastProject: false }, () => true)).toBeNull()
    expect(projectToReopen(defaultWindowState(), () => true)).toBeNull()
    expect(projectToReopen(state, () => false)).toBeNull()
  })
})

describe('WindowState', () => {
  it('defaults every field, so an empty object reads as a fresh install', () => {
    expect(WindowState.parse({})).toEqual(defaultWindowState())
  })
})
