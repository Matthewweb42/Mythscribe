import { describe, expect, it } from 'vitest'
import type { MemoryNotice } from '@shared/memory/views'
import {
  cloudLine,
  lineText,
  noticeButtons,
  noticeLine,
  otherLineText,
  readAgo,
  readNowMessage,
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
        ['Done']
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
        ['Done']
      ],
      [
        { id: 'findingsWaiting:2026-10-13', kind: 'findingsWaiting', pairs: 4, priceUsd: 0.002 },
        '4 possible contradictions wait for Check the book: about 0.2¢',
        ['Not now']
      ],
      [
        { id: 'findingsWaiting:2026-10-14', kind: 'findingsWaiting', pairs: 1, priceUsd: 0.0005 },
        '1 possible contradiction waits for Check the book: about 0.05¢',
        ['Not now']
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
})
