import { describe, expect, it } from 'vitest'
import { CHECK_NOT_COVERED } from '@shared/memory/views'
import { checkEstimateFixture, checkReportFixture } from '../memoryFixture'
import {
  CHECK_COVERS,
  checkedAgo,
  checkedLine,
  checkEndedLine,
  checkPriceLine,
  checkProgressLine,
  checkSkipsLine,
  checkWorkLine,
  lastCheckedLine,
  nobodyLearnsLine,
  notCheckedExtras
} from './checkView'

/**
 * F-16.30 (plan P4 §4): *Check the book*'s words: the price first (about and at most, free when
 * nothing changed, from the Balance on Cloud), what it does not check, the progress, the report's
 * summaries and the scoped "nobody learns" line.
 */

const NOW = new Date('2026-10-14T12:00:00.000Z')

describe('Check the book’s words', () => {
  it('says when it last ran and what it found', () => {
    expect(lastCheckedLine(null, NOW)).toBe('Not checked yet')
    expect(lastCheckedLine(checkReportFixture({ at: '2026-10-12T11:00:00.000Z' }), NOW)).toBe(
      'Last checked 2 days ago · 1 found'
    )
    expect(checkedAgo('2026-10-14T11:59:40.000Z', NOW)).toBe('just now')
    expect(checkedAgo('2026-10-14T11:57:00.000Z', NOW)).toBe('3 min ago')
    expect(checkedAgo('2026-10-14T09:00:00.000Z', NOW)).toBe('3 h ago')
    expect(checkedAgo('2026-10-13T10:00:00.000Z', NOW)).toBe('yesterday')
    expect(checkedAgo('2026-10-01T10:00:00.000Z', NOW)).toBe('on 1 Oct')
  })

  it('names every rule it runs, the body change and the falling age included', () => {
    expect(CHECK_COVERS).toContain('a lasting change to someone’s body')
    expect(CHECK_COVERS).toContain('a stated age lower than an earlier one')
  })

  it('prices it first: about and at most, free, from the Balance on Cloud', () => {
    expect(checkPriceLine(checkEstimateFixture(), true)).toBe('About 0.04¢, at most 0.06¢')
    expect(checkPriceLine(checkEstimateFixture({ mostUsd: 0.0004 }), true)).toBe('About 0.04¢')
    expect(checkPriceLine(checkEstimateFixture({ cloud: true }), true)).toBe(
      'About 0.04¢, at most 0.06¢, from your Balance'
    )
    expect(checkPriceLine(checkEstimateFixture({ priced: false }), true)).toBe(
      'About 0.04¢, at most 0.06¢ (at least: a model’s price is unknown)'
    )
    expect(checkPriceLine(checkEstimateFixture({ free: true }), true)).toBe(
      'Nothing changed since your last check: free'
    )
    // A first check can be free too (background judging judged every pair): no "last check".
    expect(checkPriceLine(checkEstimateFixture({ free: true }), false)).toBe(
      'Nothing new to judge: free'
    )
    expect(checkWorkLine(checkEstimateFixture())).toBe(
      '2 pairs to look at: no new pairs to judge; up to 2 confirmations by deepseek-v4-pro.'
    )
    expect(
      checkWorkLine(
        checkEstimateFixture({ uncached: 4, fastCalls: 2, confirms: { about: 1, most: 0 } })
      )
    ).toBe(
      '2 pairs to look at: 4 pair-orders judged by deepseek-v4-flash in 2 requests; nothing to confirm.'
    )
    expect(checkWorkLine(checkEstimateFixture({ free: true }))).toBe(
      'Every pair is judged already; nothing is sent.'
    )
  })

  it('names what it does not check, travel times among them, and the scenes not read', () => {
    expect(checkSkipsLine(CHECK_NOT_COVERED, [])).toBe(
      'It does not check travel times and distances, where objects are, anything the book never states.'
    )
    expect(checkSkipsLine(CHECK_NOT_COVERED, [{ ref: '1.3' }, { ref: '2.1' }])).toContain(
      'Not read yet, so not checked: 1.3, 2.1.'
    )
  })

  it('shows its progress and sums up the report', () => {
    const progress = {
      startedAt: 'a',
      finishedAt: null,
      judged: 2,
      toJudge: 6,
      confirmed: 0,
      toConfirm: 2,
      stopped: false,
      reason: null
    }
    expect(checkProgressLine(progress)).toBe('Judging 2 of 6 pairs…')
    expect(checkProgressLine({ ...progress, judged: 6, confirmed: 1 })).toBe(
      'Confirming 1 of 2 with the stronger check…'
    )
    // Ended early with no report: a hold met as it began says why; a Stop says how far it got.
    expect(
      checkEndedLine({ ...progress, stopped: true, reason: 'The contradiction check is off.' })
    ).toBe('The check did not run: The contradiction check is off.')
    expect(checkEndedLine({ ...progress, stopped: true })).toBe(
      'The check was stopped after 2 of 6 pairs.'
    )
    const report = checkReportFixture()
    expect(checkedLine(report)).toBe(
      'Checked: 2 pairs over 2 scenes and your notes; 1 confirmed by a stronger AI read'
    )
    expect(notCheckedExtras(report)).toEqual([])
    expect(
      notCheckedExtras(
        checkReportFixture({
          notChecked: { ...report.notChecked, pastConfirm: 3, unjudged: 1 }
        })
      )
    ).toEqual([
      '3 findings past the 20 confirmations were judged twice by the fast check only.',
      '1 pair was left unjudged when the check ended.'
    ])
  })

  it('scopes a secret nobody learns to what was checked', () => {
    expect(
      nobodyLearnsLine({
        secretId: 's',
        label: 'the sold map',
        readersSince: { nodeId: 'sc-3', ref: '3.2' },
        checkedUpTo: { nodeId: 'sc-14', ref: '14.2' }
      })
    ).toBe(
      '“the sold map”: readers know it from 3.2; no scene shows anyone learning it (checked up to 14.2)'
    )
  })
})
