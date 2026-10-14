import { describe, expect, it } from 'vitest'
import type { RebuildEstimate } from '@shared/memory/switchover'
import { heldAsk, laterAsk, offersRebuild, pricedAsk, rebuildAskLine } from './rebuildAsk'

/**
 * F-16.31 part A (Switch-over slice 4, decisions SW-D8 and SW-D9): the final screen's rebuild ask,
 * decided from main's reading status and the price. The words of each ask are pinned in
 * `SwitchoverDialog.test.tsx`; these are the rules.
 */

const ESTIMATE: RebuildEstimate = {
  scenes: 90,
  requests: 260,
  tokensIn: 567_000,
  tokensOut: 70_000,
  costUsd: 0.136,
  priced: true,
  source: 'ownKey',
  fastModel: 'deepseek/deepseek-v4-flash',
  strongModel: 'deepseek/deepseek-v4-pro',
  minutes: 12
}

describe('the switch-over’s rebuild ask (F-16.31)', () => {
  it('waits, without a price, while main says reading cannot run, worded by the switch that stops it', () => {
    expect(heldAsk({ paused: 'off' }, { dial: 0 })).toEqual({ kind: 'aiOff' })
    expect(heldAsk({ paused: 'off' }, { dial: 1 })).toEqual({ kind: 'readingOff' })
    expect(heldAsk({ paused: 'noProvider' }, { dial: 1 })).toEqual({ kind: 'noProvider' })
    // Holds on background reading (the cap, the health gate, today's cap) do not stop the asked
    // rebuild from being priced: main says why when it will not start.
    for (const paused of [null, 'cloudCap', 'health', 'dailyCap', 'localCutoff'] as const) {
      expect(heldAsk({ paused }, { dial: 1 })).toBeNull()
    }
  })

  it('offers the rebuild with a price, never on Cloud without its prices, and says when there is nothing to read', () => {
    expect(pricedAsk(ESTIMATE)).toEqual({
      kind: 'offer',
      estimate: ESTIMATE,
      starting: false,
      refused: null
    })
    // An own key's model missing from the price table may still start (P2a's rule).
    expect(pricedAsk({ ...ESTIMATE, priced: false }).kind).toBe('offer')
    expect(pricedAsk({ ...ESTIMATE, source: 'cloud', priced: false }).kind).toBe('cloudUnpriced')
    expect(pricedAsk({ ...ESTIMATE, source: 'local', costUsd: 0 }).kind).toBe('offer')
    expect(pricedAsk({ ...ESTIMATE, scenes: 0 })).toEqual({ kind: 'nothing' })
  })

  it('offers Rebuild now only on an offer, and Later where the rebuild was offered or waits on a price', () => {
    const offer = pricedAsk(ESTIMATE)
    const unpriced = pricedAsk({ ...ESTIMATE, source: 'cloud', priced: false })
    expect([offer, unpriced, { kind: 'aiOff' } as const, null].map(offersRebuild)).toEqual([
      true,
      false,
      false,
      false
    ])
    expect([offer, unpriced, { kind: 'noProvider' } as const, null].map(laterAsk)).toEqual([
      true,
      true,
      false,
      false
    ])
  })

  it('words a long book in minutes and cents', () => {
    expect(rebuildAskLine(pricedAsk(ESTIMATE))).toBe(
      'Rebuild memory now: the AI reads 90 scenes once, about 14¢ on your own key (about 12 minutes). Your text, Pinned, Ideas and Dismissed stay as they are.'
    )
    expect(rebuildAskLine({ kind: 'reading' })).toBe('Working out what Rebuild memory would cost…')
  })
})
