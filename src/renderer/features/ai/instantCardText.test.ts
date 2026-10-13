import { describe, expect, it } from 'vitest'
import type { InstantCard } from '@shared/scribe'
import {
  AGE_CARD_LABEL,
  AGE_READ_CARD_LABEL,
  AUTHOR_CARD_LABEL,
  INSTANT_CARD_LABEL,
  MIXED_CARD_LABEL,
  instantCardLabel,
  instantCardLine,
  instantCardText
} from './instantCardText'

/**
 * F-16.24 (plan P3 §4.3, §5): an instant card as the chat turn's text, which later requests carry
 * as history: positive lines only, never the scoped absence line or "checked up to".
 */

const names: Record<string, string> = { r1: 'Orrin', r2: 'Tomas' }
const nameOf = (id: string | null): string => (id === null ? '' : (names[id] ?? 'someone'))

const slot: InstantCard = {
  kind: 'slot',
  recordId: 'm',
  name: 'Mara',
  slot: 'eyes',
  label: 'Eyes',
  value: 'grey',
  claimId: 'c1',
  quote: 'her grey eyes',
  ref: '1.1',
  nodeId: 'n1',
  para: 0,
  since: null,
  lastStated: false,
  asOfRef: '1.2',
  readFirst: null
}

describe('instantCardText (F-16.24)', () => {
  it('words a value with where the book says it: fixed, lasting since, transient last stated', () => {
    expect(instantCardLine(slot, nameOf)).toBe('Mara · Eyes: grey (1.1)')
    expect(
      instantCardLine(
        { ...slot, slot: 'role', label: 'Role', value: 'captain', since: '12.1' },
        nameOf
      )
    ).toBe('Mara · Role: captain (since 12.1)')
    expect(
      instantCardLine(
        {
          ...slot,
          slot: 'location',
          label: 'Location',
          value: 'the quay',
          since: '13.4',
          lastStated: true
        },
        nameOf
      )
    ).toBe('Mara · Location: the quay (last stated in 13.4)')
  })

  it('words a computed age, a yes, and who knows a secret (scoped, never a bare absence)', () => {
    expect(
      instantCardLine(
        {
          kind: 'age',
          recordId: 'm',
          name: 'Mara',
          age: 19,
          born: { year: 1795, source: 'text', claimId: 'b', nodeId: 'n1', ref: '1.1' },
          year: { kind: 'typed', value: 1814, from: { nodeId: 'n2', ref: '1.2' } },
          asOfRef: '1.2',
          readFirst: null
        },
        nameOf
      )
    ).toBe('Mara · Age: about 19 (born 1795; year 1814 from 1.2)')
    const knows: InstantCard = {
      kind: 'knows',
      secretId: 's',
      secretLabel: 'the sold map',
      knowerId: 'r1',
      knowerName: 'Orrin',
      how: 'overheard',
      source: 'claim',
      fromName: 'Tomas',
      claimId: 'k',
      quote: 'Orrin overheard Tomas',
      ref: '1.1',
      nodeId: 'n1',
      para: 2,
      asOfRef: '1.2',
      readFirst: null
    }
    expect(instantCardLine(knows, nameOf)).toBe('Yes: Orrin overheard it from Tomas (1.1)')
    expect(instantCardLine({ ...knows, how: 'told' }, nameOf)).toBe(
      'Yes: Orrin was told it by Tomas (1.1)'
    )
    expect(instantCardLine({ ...knows, source: 'author', fromName: null, ref: null }, nameOf)).toBe(
      'Yes: Orrin knew it before the book'
    )
    const who: InstantCard = {
      kind: 'whoKnows',
      secretId: 's',
      label: 'the sold map',
      readersSince: { nodeId: 'n1', ref: '1.1' },
      holders: [
        {
          knowerId: 'r1',
          secretId: 's',
          how: 'overheard',
          fromId: 'r2',
          source: 'claim',
          line: 'counts',
          claimId: 'k',
          nodeId: 'n1',
          ref: '1.1',
          para: 2,
          voice: 'narration',
          mode: 'now',
          speakerId: null,
          stale: false,
          later: false
        }
      ],
      checkedUpTo: { nodeId: 'n2', ref: '1.2' },
      asOfRef: '1.2',
      readFirst: null
    }
    expect(instantCardLine(who, nameOf)).toBe(
      'Who knows the sold map: Orrin: overheard from Tomas (1.1) · readers since 1.1'
    )
    // No holder: no "Who knows" heading with nothing under it, which reads as nobody.
    expect(instantCardLine({ ...who, holders: [] }, nameOf)).toBe(
      'the sold map: readers since 1.1'
    )
    expect(instantCardLine({ ...who, holders: [], readersSince: null }, nameOf)).toBe(
      'the sold map'
    )
    // The turn's text goes out as history: no absence and no "checked up to" (P2b rule 9).
    for (const card of [who, { ...who, holders: [] }, { ...who, holders: [], readersSince: null }]) {
      const text = instantCardText(card, nameOf)
      expect(text).not.toMatch(/no scene shows|no other scene|checked up to|not checked|who knows the sold map\n/i)
    }
  })

  it('marks a computed age and the author’s own mark apart from an AI-read value', () => {
    expect(instantCardLabel(slot)).toBe(INSTANT_CARD_LABEL)
    expect(
      instantCardLabel({
        kind: 'age',
        recordId: 'm',
        name: 'Mara',
        age: 19,
        born: { year: 1795, source: 'text', claimId: 'b', nodeId: 'n1', ref: '1.1' },
        year: { kind: 'typed', value: 1814, from: { nodeId: 'n2', ref: '1.2' } },
        asOfRef: '1.2',
        readFirst: null
      })
    ).toBe(AGE_READ_CARD_LABEL)
    // The author's Pinned birth year and a typed story year: nothing in it was AI-read.
    expect(
      instantCardLabel({
        kind: 'age',
        recordId: 'm',
        name: 'Mara',
        age: 19,
        born: { year: 1795, source: 'pinned', claimId: null, nodeId: null, ref: null },
        year: { kind: 'typed', value: 1814, from: { nodeId: 'n2', ref: '1.2' } },
        asOfRef: '1.2',
        readFirst: null
      })
    ).toBe(AGE_CARD_LABEL)
    expect(
      instantCardLabel({
        kind: 'knows',
        secretId: 's',
        secretLabel: 'the sold map',
        knowerId: 'r2',
        knowerName: 'Tomas',
        how: 'knewBefore',
        source: 'author',
        fromName: null,
        claimId: null,
        quote: null,
        ref: null,
        nodeId: null,
        para: null,
        asOfRef: '1.2',
        readFirst: null
      })
    ).toBe(AUTHOR_CARD_LABEL)
  })

  it('marks who knows a secret by its holders: the author’s marks alone, read by AI, or both', () => {
    const cell = (knowerId: string, source: 'claim' | 'author') => ({
      knowerId,
      secretId: 's',
      how: source === 'author' ? ('knewBefore' as const) : ('overheard' as const),
      fromId: null,
      source,
      line: 'counts' as const,
      claimId: source === 'author' ? null : 'k',
      nodeId: source === 'author' ? null : 'n1',
      ref: source === 'author' ? null : '1.1',
      para: source === 'author' ? null : 0,
      voice: null,
      mode: null,
      speakerId: null,
      stale: false,
      later: false
    })
    const who: InstantCard = {
      kind: 'whoKnows',
      secretId: 's',
      label: 'the sold map',
      readersSince: null,
      holders: [cell('r2', 'author')],
      checkedUpTo: { nodeId: 'n2', ref: '1.2' },
      asOfRef: '1.2',
      readFirst: null
    }
    expect(instantCardLabel(who)).toBe(AUTHOR_CARD_LABEL)
    expect(instantCardLabel({ ...who, holders: [cell('r2', 'author'), cell('r1', 'claim')] })).toBe(
      MIXED_CARD_LABEL
    )
    // Readers-since is read by AI too.
    expect(instantCardLabel({ ...who, readersSince: { nodeId: 'n1', ref: '1.1' } })).toBe(
      MIXED_CARD_LABEL
    )
    expect(instantCardLabel({ ...who, holders: [cell('r1', 'claim')] })).toBe(INSTANT_CARD_LABEL)
  })

  it('marks the turn’s text as read by AI from the book, with no AI call now (design §2.6)', () => {
    expect(INSTANT_CARD_LABEL).toBe('Read by AI from your book · quote checked · no AI call now')
    expect(instantCardText(slot, nameOf)).toBe(`Mara · Eyes: grey (1.1)\n\n${INSTANT_CARD_LABEL}`)
  })
})
