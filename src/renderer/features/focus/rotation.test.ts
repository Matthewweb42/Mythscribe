import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defaultFocusSettings, type Background } from '@shared/focus'
import { resetBackgroundStore, useBackgroundStore } from './backgroundStore'
import { useBackgroundRotation } from './rotation'

const bg = (id: string): Background => ({
  id,
  name: `${id}.png`,
  url: `mythscribe-asset://backgrounds/${id}.png`
})

describe('useBackgroundRotation (F-6.3)', () => {
  const selected: (string | null)[] = []
  beforeEach(() => {
    vi.useFakeTimers()
    resetBackgroundStore()
    selected.length = 0
    useBackgroundStore.setState({
      backgrounds: [bg('a'), bg('b'), bg('c')],
      settings: {
        ...defaultFocusSettings(),
        backgroundId: 'b',
        rotation: { enabled: true, intervalMinutes: 2 }
      },
      select: (id) => {
        selected.push(id)
        useBackgroundStore.setState((s) => ({
          settings: s.settings ? { ...s.settings, backgroundId: id } : s.settings
        }))
      }
    })
  })
  afterEach(() => {
    resetBackgroundStore()
    vi.useRealTimers()
  })

  it('advances in list order every interval, wrapping at the end', async () => {
    renderHook(() => useBackgroundRotation())
    await act(async () => {
      vi.advanceTimersByTime(2 * 60 * 1000 - 1)
    })
    expect(selected).toEqual([])
    await act(async () => {
      vi.advanceTimersByTime(1)
    })
    expect(selected).toEqual(['c'])
    await act(async () => {
      vi.advanceTimersByTime(2 * 60 * 1000)
    })
    expect(selected).toEqual(['c', 'a'])
  })

  it('does nothing when rotation is off or fewer than two backgrounds exist, and stops on unmount', async () => {
    useBackgroundStore.setState((s) => ({
      settings: s.settings
        ? { ...s.settings, rotation: { enabled: false, intervalMinutes: 1 } }
        : null
    }))
    const off = renderHook(() => useBackgroundRotation())
    await act(async () => {
      vi.advanceTimersByTime(10 * 60 * 1000)
    })
    expect(selected).toEqual([])
    off.unmount()

    useBackgroundStore.setState((s) => ({
      backgrounds: [bg('a')],
      settings: s.settings
        ? { ...s.settings, rotation: { enabled: true, intervalMinutes: 1 } }
        : null
    }))
    const one = renderHook(() => useBackgroundRotation())
    await act(async () => {
      vi.advanceTimersByTime(10 * 60 * 1000)
    })
    expect(selected).toEqual([])
    one.unmount()

    useBackgroundStore.setState({ backgrounds: [bg('a'), bg('b')] })
    const two = renderHook(() => useBackgroundRotation())
    await act(async () => {
      vi.advanceTimersByTime(60 * 1000)
    })
    expect(selected).toEqual(['a'])
    two.unmount()
    await act(async () => {
      vi.advanceTimersByTime(60 * 1000)
    })
    expect(selected).toEqual(['a'])
  })
})
