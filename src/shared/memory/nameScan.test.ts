import { describe, expect, it } from 'vitest'
import { passageParagraphs, type Paragraph } from '../mentions'
import { dismissedKey } from './dismissed'
import {
  buildNameIndex,
  mentionPhrase,
  scanNames,
  type NameScanContext,
  type ScanAlias,
  type ScanRecord
} from './nameScan'
import { normName } from './names'
import type { CaseRule, RecordKind } from './records'

const doc = (texts: readonly string[]): Paragraph[] =>
  passageParagraphs({
    type: 'doc',
    content: texts.map((text) => ({ type: 'paragraph', content: [{ type: 'text', text }] }))
  })

interface RosterEntry {
  id: string
  kind?: RecordKind
  names: readonly (string | { text: string; shared?: boolean; caseRule?: CaseRule })[]
}

const roster = (
  entries: readonly RosterEntry[]
): { records: ScanRecord[]; aliases: ScanAlias[] } => ({
  records: entries.map((entry) => ({ id: entry.id, kind: entry.kind ?? 'character' })),
  aliases: entries.flatMap((entry) =>
    entry.names.map((name, i) => {
      const alias = typeof name === 'string' ? { text: name } : name
      return {
        id: `${entry.id}:${i}`,
        recordId: entry.id,
        text: alias.text,
        norm: normName(alias.text),
        caseRule: alias.caseRule ?? 'auto',
        shared: alias.shared ?? false
      }
    })
  )
})

const NO_CONTEXT: NameScanContext = { povRecordId: null, notMention: new Set() }

const scan = (
  texts: readonly string[],
  entries: readonly RosterEntry[],
  ctx: NameScanContext = NO_CONTEXT
): ReturnType<typeof scanNames> => {
  const { records, aliases } = roster(entries)
  return scanNames(doc(texts), buildNameIndex(records, aliases), ctx)
}

const named = (mentions: ReturnType<typeof scanNames>): string[] =>
  mentions
    .filter((mention) => !mention.ambiguous)
    .map((mention) => `${mention.recordId}:${mention.text}`)

describe('scanNames (F-16.5, identity rules 1–4)', () => {
  const FALSIRE: RosterEntry[] = [
    { id: 'rynna', names: ['Rynna Falsire', 'Rynna', 'Falsire'] },
    { id: 'tomas', names: ['Tomas Vell', 'Tomas'] }
  ]

  it('matches whole capitalised spans only: "Jem Falsire" is not Falsire', () => {
    const found = scan(
      ['Jem Falsire came in. Later Falsire sat down, and Rynna Falsire’s cup was cold.'],
      FALSIRE
    )
    expect(named(found)).toEqual(['rynna:Falsire', 'rynna:Rynna Falsire'])
  })

  it('places each mention at the ProseMirror range of the saved document', () => {
    const texts = ['One line.', 'Then Tomas left.']
    const found = scan(texts, FALSIRE)
    const paragraph = doc(texts)[1]
    expect(found).toEqual([
      {
        recordId: 'tomas',
        para: 1,
        from: (paragraph?.from ?? 0) + 5,
        to: (paragraph?.from ?? 0) + 10,
        text: 'Tomas',
        ambiguous: false,
        spanKey: `1:${(paragraph?.from ?? 0) + 5}`
      }
    ])
  })

  it('reads "Will" and "May" in their exact case when the scene also writes them in lower case', () => {
    const people: RosterEntry[] = [
      { id: 'will', names: ['Will'] },
      { id: 'may', names: ['May'] }
    ]
    // The scene writes "will" as a verb, so "Will" counts only capitalised, and at a sentence
    // start only because Will is also named mid-sentence.
    expect(
      named(scan(['Will you come? I will. Will laughed.', 'She saw Will at the gate.'], people))
    ).toEqual(['will:Will', 'will:Will', 'will:Will'])
    // Only at sentence starts, and the scene writes "may" in lower case: no mention at all.
    expect(named(scan(['May I sit? You may.', 'May we go?'], people))).toEqual([])
    // A name the scene never writes in lower case counts at a sentence start too.
    expect(named(scan(['May smiled.'], people))).toEqual(['may:May'])
  })

  it('matches an exact-case title alias with its "the", and in any case never', () => {
    const captain: RosterEntry[] = [
      { id: 'captain', names: [{ text: 'the Captain', caseRule: 'exact' }] }
    ]
    expect(named(scan(['They called him the Captain. The Captain smiled.'], captain))).toEqual([
      'captain:the Captain',
      'captain:The Captain'
    ])
    expect(named(scan(['The Captain smiled at the captain of the ship.'], captain))).toEqual([])
  })

  it('matches a name typed in lower case on word boundaries in any case', () => {
    const shadow: RosterEntry[] = [{ id: 'shadow', kind: 'group', names: ['the grey men'] }]
    expect(
      named(scan(['The Grey Men came at night; the grey men always do. Greymen do not.'], shadow))
    ).toEqual(['shadow:The Grey Men', 'shadow:the grey men'])
  })

  const HARROWS: RosterEntry[] = [
    { id: 'harrow-mr', names: ['Mr. Harrow', { text: 'Harrow', shared: true }] },
    { id: 'harrow-mrs', names: ['Mrs. Harrow', { text: 'Harrow', shared: true }] }
  ]

  it('resolves a shared alias by a neighbouring paragraph that names one owner', () => {
    const found = scan(['Mrs. Harrow poured the tea.', 'Harrow drank it cold.'], HARROWS)
    expect(named(found)).toEqual(['harrow-mrs:Mrs. Harrow', 'harrow-mrs:Harrow'])
  })

  it('resolves a shared alias by the typed POV', () => {
    const found = scan(['Harrow drank it cold.'], HARROWS, {
      povRecordId: 'harrow-mr',
      notMention: new Set()
    })
    expect(named(found)).toEqual(['harrow-mr:Harrow'])
  })

  it('leaves a shared alias ambiguous when nothing settles it: one row per owner, one span key', () => {
    const found = scan(['Harrow drank it cold.'], HARROWS)
    expect(found.map((mention) => [mention.recordId, mention.ambiguous])).toEqual([
      ['harrow-mr', true],
      ['harrow-mrs', true]
    ])
    expect(new Set(found.map((mention) => mention.spanKey)).size).toBe(1)
    // Both owners named nearby settle nothing either.
    expect(
      scan(['Mr. Harrow and Mrs. Harrow sat down.', 'Harrow spoke.'], HARROWS).filter(
        (mention) => mention.ambiguous
      )
    ).toHaveLength(2)
  })

  it('points a plural at a group, or leaves it ambiguous', () => {
    const family: RosterEntry[] = [
      ...HARROWS,
      { id: 'harrows', kind: 'group', names: ['Harrow', 'the Harrow family'] }
    ]
    // Without a group, "the Harrows" is either Harrow.
    expect(scan(['The Harrows were out.'], HARROWS).every((mention) => mention.ambiguous)).toBe(
      true
    )
    // With a group owning "Harrow", the plural is the group. (Its unshared "Harrow" is a data
    // error the store refuses; here it only shows that the group wins.)
    const found = scan(['We dined with the Harrows.'], family)
    expect(found.filter((mention) => !mention.ambiguous).map((m) => m.recordId)).toEqual([
      'harrows'
    ])
  })

  it('skips a phrase the author marked Not a mention for that record', () => {
    const text = 'Will you come? Will Harrow said nothing. She saw Will.'
    const will: RosterEntry[] = [{ id: 'will', names: ['Will', 'Will Harrow'] }]
    expect(named(scan([text], will))).toHaveLength(3)
    const phrase = mentionPhrase(text, 0, 4)
    expect(phrase).toBe('Will you')
    const notMention = new Set([dismissedKey({ kind: 'notMention', recordId: 'will', phrase })])
    expect(named(scan([text], will, { povRecordId: null, notMention }))).toEqual([
      'will:Will Harrow',
      'will:Will'
    ])
  })

  it('tries a span joined by a link word in its parts, and a sentence opener without it', () => {
    const people: RosterEntry[] = [
      { id: 'varrow', names: ['Mr. Varrow'] },
      { id: 'elsdale', kind: 'place', names: ['Elsdale'] },
      { id: 'jo', names: ['Jo'] },
      { id: 'skye', kind: 'place', names: ['Isle of Skye'] }
    ]
    expect(
      named(scan(['Mr. Varrow of Elsdale bowed. "Dearest Jo, sail to the Isle of Skye."'], people))
    ).toEqual(['varrow:Mr. Varrow', 'elsdale:Elsdale', 'jo:Jo', 'skye:Isle of Skye'])
  })

  it('keeps a span joined by a surname particle whole: "Anne de Vere" is not Vere', () => {
    const people: RosterEntry[] = [
      { id: 'vere', names: ['Rynna Vere', 'Vere'] },
      { id: 'eyck', names: ['Pieter Eyck', 'Eyck'] }
    ]
    expect(
      scan(['Anne de Vere came in.', 'Later, Anne de Vere left. Jan van Eyck painted.'], people)
    ).toEqual([])
    // The bare surname still names its record.
    expect(named(scan(['Vere bowed to Eyck.'], people))).toEqual(['vere:Vere', 'eyck:Eyck'])
  })

  const TOMAS: RosterEntry[] = [{ id: 'tomas', names: ['Tomas Harrow', 'Harrow'] }]

  it('never drops a title at a sentence start: "Mrs. Harrow" is not Harrow there either', () => {
    for (const text of [
      'Mrs. Harrow bowed to him.',
      'Lady Harrow bowed to him.',
      'He bowed to Mrs. Harrow.',
      'He bowed to Lady Harrow.'
    ]) {
      expect(scan([text], TOMAS)).toEqual([])
    }
  })

  it('leaves a name found by dropping a lower-case word at a sentence start ambiguous', () => {
    const found = scan(['The sun rose over the hill.', 'Rose Harrow came down the stairs.'], TOMAS)
    expect(found.map((mention) => [mention.recordId, mention.text, mention.ambiguous])).toEqual([
      ['tomas', 'Harrow', true]
    ])
    expect(scan(['He waited for Rose Harrow by the stairs.'], TOMAS)).toEqual([])
    // A common opener is still dropped for certain.
    expect(named(scan(['Then Harrow came down.'], TOMAS))).toEqual(['tomas:Harrow'])
  })
})
