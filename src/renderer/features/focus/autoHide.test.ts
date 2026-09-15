import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HIDE_DELAY_MS, INTRO_MS, createAutoHide, useAutoHide } from './autoHide'

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

describe('createAutoHide (F-6.5)', () => {
  it('starts hidden; the intro shows the bar and hides it when the intro is over', () => {
    const bar = createAutoHide()
    const seen: boolean[] = []
    bar.subscribe(() => seen.push(bar.getSnapshot()))
    expect(bar.getSnapshot()).toBe(false)
    bar.intro()
    expect(bar.getSnapshot()).toBe(true)
    vi.advanceTimersByTime(INTRO_MS - 1)
    expect(bar.getSnapshot()).toBe(true)
    vi.advanceTimersByTime(1)
    expect(bar.getSnapshot()).toBe(false)
    expect(seen).toEqual([true, false])
  })

  it('shows while a hold is on and hides after the delay once every hold has ended', () => {
    const bar = createAutoHide()
    bar.hold('edge', true)
    expect(bar.getSnapshot()).toBe(true)
    bar.hold('bar', true)
    bar.hold('edge', false)
    vi.advanceTimersByTime(HIDE_DELAY_MS * 2)
    expect(bar.getSnapshot()).toBe(true) // still over the bar
    bar.hold('bar', false)
    vi.advanceTimersByTime(HIDE_DELAY_MS - 1)
    expect(bar.getSnapshot()).toBe(true)
    vi.advanceTimersByTime(1)
    expect(bar.getSnapshot()).toBe(false)
  })

  it('a new hold during the delay cancels the pending hide', () => {
    const bar = createAutoHide()
    bar.hold('edge', true)
    bar.hold('edge', false)
    vi.advanceTimersByTime(HIDE_DELAY_MS - 100)
    bar.hold('focus', true)
    vi.advanceTimersByTime(HIDE_DELAY_MS * 2)
    expect(bar.getSnapshot()).toBe(true)
    bar.hold('focus', false)
    vi.advanceTimersByTime(HIDE_DELAY_MS)
    expect(bar.getSnapshot()).toBe(false)
  })

  it('a hold released during the intro hides when the intro ends, not sooner', () => {
    const bar = createAutoHide()
    bar.hold('edge', true)
    bar.intro()
    bar.hold('edge', false)
    vi.advanceTimersByTime(HIDE_DELAY_MS)
    expect(bar.getSnapshot()).toBe(true)
    vi.advanceTimersByTime(INTRO_MS - HIDE_DELAY_MS - 1)
    expect(bar.getSnapshot()).toBe(true)
    vi.advanceTimersByTime(1)
    expect(bar.getSnapshot()).toBe(false)
  })

  it('a hold released late in the intro still gets the full delay', () => {
    const bar = createAutoHide()
    bar.intro()
    vi.advanceTimersByTime(INTRO_MS - 100)
    bar.hold('edge', true)
    vi.advanceTimersByTime(200) // the intro deadline passes while held
    expect(bar.getSnapshot()).toBe(true)
    bar.hold('edge', false)
    vi.advanceTimersByTime(HIDE_DELAY_MS - 1)
    expect(bar.getSnapshot()).toBe(true)
    vi.advanceTimersByTime(1)
    expect(bar.getSnapshot()).toBe(false)
  })

  it('repeating a hold in its current state changes nothing, and dispose drops the timer', () => {
    const bar = createAutoHide()
    const seen: boolean[] = []
    bar.subscribe(() => seen.push(bar.getSnapshot()))
    bar.hold('edge', false)
    expect(seen).toEqual([])
    bar.hold('edge', true)
    bar.hold('edge', true)
    expect(seen).toEqual([true])
    bar.hold('edge', false)
    bar.dispose()
    vi.advanceTimersByTime(HIDE_DELAY_MS * 2)
    expect(bar.getSnapshot()).toBe(true) // never hidden: the timer is gone
  })
})

describe('useAutoHide (F-6.5)', () => {
  it('shows on mount for the intro, follows the holds, and stops its timer on unmount', () => {
    const { result, unmount } = renderHook(() => useAutoHide())
    expect(result.current.visible).toBe(true)
    act(() => {
      vi.advanceTimersByTime(INTRO_MS)
    })
    expect(result.current.visible).toBe(false)
    act(() => result.current.hold('edge', true))
    expect(result.current.visible).toBe(true)
    act(() => result.current.hold('edge', false))
    act(() => {
      vi.advanceTimersByTime(HIDE_DELAY_MS)
    })
    expect(result.current.visible).toBe(false)
    act(() => result.current.hold('bar', true))
    act(() => result.current.hold('bar', false))
    unmount()
    expect(vi.getTimerCount()).toBe(0)
  })
})
