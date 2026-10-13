import { describe, expect, it } from 'vitest'
import { knowsCellFixture, secretViewFixture, topicQuoteFixture } from '../memoryFixture'
import {
  absenceLine,
  cellText,
  holderLine,
  howText,
  knowsLineText,
  moreText,
  noHoldersText,
  noKnowsText,
  noRevealText,
  otherKnowsText,
  readersSinceText,
  revealLines,
  scopeText,
  secretSummary,
  tensionText,
  whoKnowsCardAbsence
} from './knowsView'

/**
 * F-16.22 (plan P2b §4.2): the words of who knows what. The scoped absence line is made here and
 * nowhere else (P2b rule 9); every line is a positive line or that scoped one.
 */

const NAMES: Record<string, string> = { mara: 'Mara', orrin: 'Orrin', tomas: 'Tomas' }
const nameOf = (id: string | null): string => (id === null ? 'Someone' : (NAMES[id] ?? '?'))

describe('who knows what, in words (F-16.22)', () => {
  it('scopes every absence by what was checked, and never states it as a fact', () => {
    expect(absenceLine('Mara', { nodeId: 'sc-1', ref: '1.1' })).toBe(
      'No scene shows Mara learning this (checked up to 1.1)'
    )
    // The sheets' empty states are scoped too.
    expect(noHoldersText({ nodeId: 'sc-2', ref: '1.2' })).toBe(
      'No scene shows anyone learning this (checked up to 1.2)'
    )
    expect(noRevealText({ nodeId: 'sc-2', ref: '1.2' })).toBe(
      'No scene reveals it yet (checked up to 1.2)'
    )
    expect(noKnowsText('Mara', null)).toBe(
      'No scene shows Mara learning a secret (not checked yet)'
    )
    expect(absenceLine('Mara', null)).toBe('No scene shows Mara learning this (not checked yet)')
    expect(scopeText(null)).toBe('(not checked yet)')
    // The chat's instant who-knows card (F-16.24): beside its holders, then with none.
    expect(whoKnowsCardAbsence(2, { nodeId: 'sc-9', ref: '14.2' })).toBe(
      'No other scene shows anyone learning it (checked up to 14.2)'
    )
    expect(whoKnowsCardAbsence(0, { nodeId: 'sc-2', ref: '1.2' })).toBe(
      'No scene shows anyone learning this (checked up to 1.2)'
    )
  })

  it('reads a holder’s line with how, from whom and where; the author’s mark as hers', () => {
    const overheard = knowsCellFixture('orrin', { fromId: 'tomas' })
    expect(holderLine(overheard, nameOf)).toBe('Orrin: overheard from Tomas (1.1)')
    expect(holderLine(knowsCellFixture('tomas', { how: 'knewBefore' }), nameOf)).toBe(
      'Tomas: knew before (1.1)'
    )
    expect(
      holderLine(
        knowsCellFixture('mara', { how: 'knewBefore', source: 'author', claimId: null }),
        nameOf
      )
    ).toBe('Mara: knew before the book (you said)')
    expect(howText(knowsCellFixture('orrin', { how: 'told', fromId: 'tomas' }), nameOf)).toBe(
      'told by Tomas'
    )
    // A source is named only for told, overheard and read.
    expect(howText(knowsCellFixture('orrin', { how: 'deduced', fromId: 'tomas' }), nameOf)).toBe(
      'deduced'
    )
    expect(howText(knowsCellFixture('orrin', { how: 'believesFalse' }), nameOf)).toBe(
      'believes otherwise'
    )
    expect(knowsLineText('the sold map', overheard, nameOf)).toBe(
      'the sold map: overheard from Tomas'
    )
  })

  it('reads a grid cell, a later one and the author’s', () => {
    expect(cellText(knowsCellFixture('orrin', { ref: '9.3' }))).toBe('overheard 9.3')
    expect(cellText(knowsCellFixture('orrin', { how: 'suspects', ref: '7.1' }))).toBe(
      'suspects 7.1'
    )
    expect(cellText(knowsCellFixture('orrin', { later: true, ref: '17.3' }))).toBe(
      'learns later (17.3)'
    )
    expect(cellText(knowsCellFixture('mara', { source: 'author', claimId: null }))).toBe(
      'knew before the book (you)'
    )
  })

  it('reads the tension lines, scoped', () => {
    const since = { nodeId: 'sc-1', ref: '1.1', stale: false }
    expect(
      tensionText(
        {
          kind: 'readersKnow',
          secretId: 's',
          label: 'the sold map',
          since,
          recordId: 'mara',
          stale: false
        },
        nameOf,
        { nodeId: 'sc-2', ref: '1.2' }
      )
    ).toBe(
      'Readers know the sold map (since 1.1); no scene shows Mara (POV) learning it (checked up to 1.2)'
    )
    expect(
      tensionText(
        {
          kind: 'hereKnows',
          secretId: 's',
          label: 'the sold map',
          since,
          holderId: 'orrin',
          recordId: 'mara',
          stale: false
        },
        nameOf,
        null
      )
    ).toBe('Orrin knows the sold map; no scene shows Mara learning it (not checked yet)')
    expect(moreText(9)).toBe('+ 9 more in Book')
  })

  it('reads the lines that never count as what they are', () => {
    const said = knowsCellFixture('orrin', {
      how: 'refers',
      voice: 'dialogue',
      speakerId: 'tomas',
      line: 'other'
    })
    expect(otherKnowsText('the sold map', said, nameOf)).toBe(
      'the sold map: Tomas says it (refers to it)'
    )
    expect(
      otherKnowsText('the sold map', { ...said, voice: 'rumour', speakerId: null }, nameOf)
    ).toBe('the sold map: as rumour (refers to it)')
    expect(
      otherKnowsText('the sold map', { ...said, voice: 'narration', mode: 'dream' }, nameOf)
    ).toBe('the sold map: in a dream (refers to it)')
  })

  it('sums a secret up for its list, and words its reveals for ⓘ', () => {
    const secret = secretViewFixture('s', 'the sold map', {
      readersSince: { nodeId: 'sc-2', ref: '5.2', stale: false },
      cells: [
        knowsCellFixture('orrin'),
        knowsCellFixture('tomas', { how: 'knewBefore' }),
        knowsCellFixture('mara', { how: 'suspects', line: 'partial' }),
        knowsCellFixture('lise', { later: true })
      ]
    })
    expect(secretSummary(secret)).toBe('readers since 5.2 · 2 know')
    expect(secretSummary({ ...secret, readersSince: null, cells: [] })).toBe('not in the book yet')
    // An AI-made secret the grid does not hold: revealed only where the reader no longer reads.
    expect(secretSummary(undefined, true)).toBe(
      'not in the book now (another draft, or an Idea or left-out scene)'
    )
    expect(secretSummary(undefined)).toBe('')
    expect(readersSinceText({ nodeId: 'sc-1', ref: '1.1', stale: false })).toBe('readers since 1.1')
    expect(revealLines(topicQuoteFixture('q'), 'secret')).toEqual([
      'Revealed in 1.1 ¶2',
      'checked by a second AI read',
      expect.stringMatching(/^read on .+; that reading cost .+ \(flash\)$/)
    ])
    expect(
      revealLines(
        topicQuoteFixture('m', {
          role: 'merged',
          label: 'the map sale',
          ref: '1.3',
          reading: null
        }),
        'secret'
      )
    ).toEqual(['also read as “the map sale” in 1.3: merged into this secret'])
  })
})
