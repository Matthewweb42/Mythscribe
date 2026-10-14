import { describe, expect, it } from 'vitest'
import type { MemoryNotice } from '@shared/memory/views'
import {
  aboutMinutes,
  cloudLine,
  lineText,
  noticeButtons,
  noticeLine,
  otherLineText,
  readAgo,
  readNowMessage,
  rebuildCost,
  staleNote,
  trueNowNote
} from './memoryView'

/** F-16.16, F-16.18, F-16.19: the words of the reading in the renderer. */

describe('memoryView (F-16.18)', () => {
  it('words lines, their notes and why a stale one is dimmed', () => {
    expect(lineText('Eyes', 'grey')).toBe('Eyes: grey')
    expect(lineText('Last seen at', 'the quay')).toBe('Last seen at the quay')
    expect(trueNowNote({ kind: 'since', ref: '12.1' })).toBe('since 12.1')
    expect(trueNowNote({ kind: 'lastStated', ref: '13.4' })).toBe('last stated in 13.4')
    expect(staleNote(null)).toBe('re-checking after you pause')
    expect(staleNote('off')).toBe('reading paused')
  })

  it('words the other voices, never as state', () => {
    const line = { label: 'Alive', value: 'no' }
    expect(otherLineText({ ...line, voice: 'dialogue', mode: 'now' }, 'Tomas')).toBe(
      'Tomas says: Alive: no'
    )
    expect(otherLineText({ ...line, voice: 'thought', mode: 'now' }, null)).toBe(
      'Someone thinks: Alive: no'
    )
    expect(otherLineText({ ...line, voice: 'rumour', mode: 'now' }, null)).toBe('Rumour: Alive: no')
    expect(otherLineText({ ...line, voice: 'narration', mode: 'dream' }, null)).toBe(
      'In a dream: Alive: no'
    )
    expect(otherLineText({ ...line, voice: 'narration', mode: 'memory' }, null)).toBe(
      'Remembered: Alive: no'
    )
    expect(otherLineText({ ...line, voice: 'narration', mode: 'hypothetical' }, null)).toBe(
      'If: Alive: no'
    )
  })

  it('says how long ago the scene was read, and what Read now found', () => {
    const now = new Date('2026-10-12T12:00:00.000Z')
    expect(readAgo(null, now)).toBe('Not read yet')
    expect(readAgo('2026-10-12T11:59:40.000Z', now)).toBe('Read just now')
    expect(readAgo('2026-10-12T11:57:00.000Z', now)).toBe('Read 3 min ago')
    expect(readAgo('2026-10-12T09:00:00.000Z', now)).toBe('Read 3 h ago')
    expect(readAgo('2026-10-10T09:00:00.000Z', now)).toBe('Read on 10 Oct')
    expect(cloudLine({ spentUsd: 0.12, capUsd: 1 })).toBe('Cloud 12¢ of $1')
    const skip = { ok: true as const, read: false, readingId: null, costUsd: 0 }
    expect(readNowMessage({ ...skip, reason: 'upToDate' })).toBe(
      'Nothing new to read in this scene.'
    )
    expect(readNowMessage({ ...skip, reason: 'cosmetic' })).toBe(
      'Nothing new to read in this scene.'
    )
    expect(readNowMessage({ ...skip, reason: 'paused' })).toBe(
      'Reading is paused; see Needs a look.'
    )
    expect(readNowMessage({ ...skip, read: true, reason: null })).toBeNull()
  })

  it('words each notice with its buttons', () => {
    const cases: [MemoryNotice, string, string[]][] = [
      [
        { id: 'backlog', kind: 'backlog', scenes: 37, priceUsd: 0.03 },
        'Read 37 changed scenes: about 3¢',
        ['Read them', 'Later']
      ],
      [
        { id: 'draftUnread', kind: 'draftUnread', draftId: 'd', scenes: 90, priceUsd: 0.12 },
        'This draft has not been read yet: 90 scenes, about 12¢',
        ['Read', 'Later']
      ],
      [
        {
          id: 'backfill:r',
          kind: 'backfill',
          recordId: 'r',
          name: 'Hesk',
          pages: 14,
          priceUsd: 0.004
        },
        'Read 14 scenes for Hesk: about 0.4¢',
        ['Read', 'Not now']
      ],
      [
        { id: 'cloudCap:2026-10', kind: 'cloudCap', month: '2026-10', capUsd: 1 },
        'Background reading reached your $1 Cloud cap for October.',
        ['Allow another $1 this month', 'Change the cap']
      ],
      [
        { id: 'localCutoff', kind: 'localCutoff', model: 'llama' },
        'Story memory paused: the local model llama stopped answering at its limit.',
        ['Keep reading anyway']
      ],
      [
        {
          id: 'detail:sc:place',
          kind: 'detailConflict',
          nodeId: 'sc',
          ref: '14.2',
          field: 'place',
          typed: 'the harbour',
          text: 'the quay',
          textRecordId: null,
          quote: 'at the quay'
        },
        '14.2: the text says the quay; you typed the harbour',
        ['Update my detail', 'Keep mine']
      ],
      [
        {
          id: 'rebuildDone:2026-10-13T09:00:00.000Z',
          kind: 'rebuildDone',
          startedAt: '2026-10-13T09:00:00.000Z',
          lines: 14,
          sheets: 6,
          names: 2,
          findings: 3
        },
        'Rebuild finished: 14 new lines on 6 sheets, 2 names, 3 possible contradictions',
        ['Review', 'Done']
      ],
      [
        {
          id: 'rebuildDone:2026-10-14T09:00:00.000Z',
          kind: 'rebuildDone',
          startedAt: '2026-10-14T09:00:00.000Z',
          lines: 1,
          sheets: 1,
          names: 1,
          findings: 1
        },
        'Rebuild finished: 1 new line on 1 sheet, 1 name, 1 possible contradiction',
        ['Review', 'Done']
      ],
      [
        { id: 'findingsWaiting:2026-10-13', kind: 'findingsWaiting', pairs: 4, priceUsd: 0.002 },
        '4 possible contradictions wait for Check the book: about 0.2¢',
        ['Check the book…', 'Not now']
      ],
      [
        { id: 'findingsWaiting:2026-10-14', kind: 'findingsWaiting', pairs: 1, priceUsd: 0.0005 },
        '1 possible contradiction waits for Check the book: about 0.05¢',
        ['Check the book…', 'Not now']
      ],
      [
        { id: 'underlinePrecision', kind: 'underlinePrecision', counted: 20, notProblems: 8 },
        'Of the last 20 underlined contradictions, 8 were not problems. Show contradictions in the panel only?',
        ['Panel only', 'Keep underlines']
      ],
      [
        {
          id: 'switchoverRebuild',
          kind: 'switchoverRebuild',
          switchedAt: '2026-10-14T09:00:00.000Z',
          scenes: 12,
          priceUsd: 0.02,
          priced: true
        },
        'Rebuild memory has not run since the switch-over: it reads 12 scenes, about 2¢',
        ['Rebuild…', 'Later']
      ],
      [
        {
          id: 'switchoverRebuild',
          kind: 'switchoverRebuild',
          switchedAt: '2026-10-14T09:00:00.000Z',
          scenes: 1,
          priceUsd: 0,
          priced: false
        },
        'Rebuild memory has not run since the switch-over: it reads 1 scene, a cost not yet known',
        ['Rebuild…', 'Later']
      ],
      [
        // A local model prices the rebuild at 0: free, as the final screen says it (never "0¢").
        {
          id: 'switchoverRebuild',
          kind: 'switchoverRebuild',
          switchedAt: '2026-10-14T09:00:00.000Z',
          scenes: 4,
          priceUsd: 0,
          priced: true
        },
        'Rebuild memory has not run since the switch-over: it reads 4 scenes at no cost',
        ['Rebuild…', 'Later']
      ]
    ]
    for (const [notice, line, buttons] of cases) {
      expect(noticeLine(notice)).toBe(line)
      expect(noticeButtons(notice).map((button) => button.label)).toEqual(buttons)
    }
    const health: MemoryNotice = {
      id: 'health:m',
      kind: 'health',
      model: 'm',
      quotes: 0.85,
      verified: 0.9,
      switchable: false
    }
    expect(noticeLine(health)).toContain('85 % of quotes found')
    expect(noticeButtons(health).map((button) => button.label)).toEqual([
      'Keep reading anyway',
      'Details'
    ])
  })

  it('words a rebuild’s cost and where it is paid from in one way, in cents (F-16.19, F-16.31)', () => {
    const own = { source: 'ownKey', priced: true, costUsd: 0.136 } as const
    expect(rebuildCost(own)).toBe('about 14¢ on your own key')
    expect(rebuildCost({ ...own, priced: false })).toBe(
      'a cost not yet known (a model is not in the price table) on your own key'
    )
    expect(rebuildCost({ ...own, source: 'cloud' })).toBe(
      'about 14¢ from your MythScribe Cloud balance'
    )
    expect(rebuildCost({ ...own, source: 'cloud', priced: false })).toBe(
      'a cost not yet known (MythScribe Cloud has no price for a model story memory uses)'
    )
    expect(rebuildCost({ source: 'local', priced: true, costUsd: 0 })).toBe(
      'free on your local model'
    )
    expect(aboutMinutes(1)).toBe('about a minute')
    expect(aboutMinutes(12)).toBe('about 12 minutes')
  })

  it('offers the switch-over’s rebuild through the price dialog, and Later as an answer (F-16.31)', () => {
    const waiting: MemoryNotice = {
      id: 'switchoverRebuild',
      kind: 'switchoverRebuild',
      switchedAt: '2026-10-14T09:00:00.000Z',
      scenes: 90,
      priceUsd: 0.136,
      priced: true
    }
    expect(noticeLine(waiting)).toBe(
      'Rebuild memory has not run since the switch-over: it reads 90 scenes, about 14¢'
    )
    // *Rebuild…* is the renderer's own button (the rebuild dialog at its price, nothing sent
    // here); *Later* is main's answer, which hides the notice until the project opens again.
    expect(noticeButtons(waiting)).toEqual([
      { kind: 'rebuild', label: 'Rebuild…' },
      { kind: 'answer', action: 'later', label: 'Later' }
    ])
  })
})
