import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SHEET_SYNC_DELAY_MS } from '@shared/sheetSync'
import { createSheetSyncScheduler } from './sheetSyncScheduler'

describe('createSheetSyncScheduler (F-9.18)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('waits 30 seconds after the last edit of a sheet', () => {
    const due: string[] = []
    const scheduler = createSheetSyncScheduler({
      delayMs: SHEET_SYNC_DELAY_MS,
      onDue: (id) => due.push(id)
    })
    expect(SHEET_SYNC_DELAY_MS).toBe(30_000)
    scheduler.touch('mara')
    vi.advanceTimersByTime(29_000)
    // Another edit restarts the pause.
    scheduler.touch('mara')
    vi.advanceTimersByTime(29_000)
    expect(due).toEqual([])
    expect(scheduler.waiting()).toEqual(['mara'])
    vi.advanceTimersByTime(1_000)
    expect(due).toEqual(['mara'])
    expect(scheduler.waiting()).toEqual([])
  })

  it('keeps one pause per sheet: editing another sheet does not hold this one back', () => {
    const due: string[] = []
    const scheduler = createSheetSyncScheduler({ delayMs: 30_000, onDue: (id) => due.push(id) })
    scheduler.touch('mara')
    vi.advanceTimersByTime(20_000)
    scheduler.touch('kael')
    vi.advanceTimersByTime(10_000)
    expect(due).toEqual(['mara'])
    vi.advanceTimersByTime(20_000)
    expect(due).toEqual(['mara', 'kael'])
  })

  it('cancel and clear drop pauses without firing', () => {
    const due: string[] = []
    const scheduler = createSheetSyncScheduler({ delayMs: 30_000, onDue: (id) => due.push(id) })
    scheduler.touch('mara')
    scheduler.touch('kael')
    scheduler.cancel('mara')
    expect(scheduler.waiting()).toEqual(['kael'])
    scheduler.clear()
    vi.advanceTimersByTime(60_000)
    expect(due).toEqual([])
  })
})
