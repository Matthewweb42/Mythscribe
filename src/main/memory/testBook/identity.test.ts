import { describe, expect, it } from 'vitest'
import { passageParagraphs, type Paragraph } from '@shared/mentions'
import { buildNameIndex, scanNames, type ScanAlias } from '@shared/memory/nameScan'
import { normName } from '@shared/memory/names'
import { twinGate, type TwinRule } from '@shared/memory/twinGate'
import { TEST_BOOK } from './book'
import { TEST_BOOK_LABELS } from './labels'

/**
 * P1's identity rules over the test book (F-16.4, F-16.5; plan P1 §1.5): the name scan against
 * every scene's mention labels, and the twin gate against every twin case.
 */

const doc = (texts: readonly string[]): Paragraph[] =>
  passageParagraphs({
    type: 'doc',
    content: texts.map((text) => ({ type: 'paragraph', content: [{ type: 'text', text }] }))
  })

const RECORDS = TEST_BOOK_LABELS.records
const ALIASES: ScanAlias[] = RECORDS.flatMap((record) =>
  record.aliases.map((alias, i) => ({
    id: `${record.id}:${i}`,
    recordId: record.id,
    text: alias.text,
    norm: normName(alias.text),
    // The author confirmed the title alone as a name (identity rule 2): exact case.
    caseRule: alias.text === 'the Captain' ? ('exact' as const) : ('auto' as const),
    shared: alias.shared ?? false
  }))
)
const INDEX = buildNameIndex(
  RECORDS.map((record) => ({ id: record.id, kind: record.kind })),
  ALIASES
)

const scene = (id: string): (typeof TEST_BOOK)[number] => {
  const found = TEST_BOOK.find((candidate) => candidate.id === id)
  if (found === undefined) throw new Error(`No scene ${id}`)
  return found
}

describe('the name scan over the test book (identity rules 1–4)', () => {
  it('names exactly the labelled records in every labelled scene', () => {
    for (const label of TEST_BOOK_LABELS.mentions) {
      const { paragraphs, details } = scene(label.scene)
      const found = scanNames(doc(paragraphs), INDEX, {
        povRecordId: details?.pov ?? null,
        notMention: new Set()
      })
      const ids = [...new Set(found.filter((m) => !m.ambiguous).map((m) => m.recordId))]
      expect(ids.sort(), label.scene).toEqual([...label.records].sort())
    }
  })

  it('settles the lone shared "Harrow" of h03 from its neighbouring paragraphs', () => {
    const found = scanNames(doc(scene('h03').paragraphs), INDEX, {
      povRecordId: null,
      notMention: new Set()
    })
    const harrow = found.filter((mention) => mention.text === 'Harrow')
    expect(harrow).toHaveLength(1)
    expect(harrow[0]?.ambiguous).toBe(false)
  })
})

describe('the twin gate over the test book', () => {
  const roster = RECORDS.map((record) => ({
    id: record.id,
    names: [record.name, ...record.aliases.map((alias) => alias.text)]
  }))
  /** The labels' rule names, in the gate's words. */
  const RULE: Record<string, TwinRule> = {
    alias: 'alias',
    wordSubset: 'subset',
    prefix: 'prefix',
    edit: 'edit',
    dismissed: 'dismissed'
  }

  it('blocks or clears every twin case as labelled, against the record and by the rule labelled', () => {
    for (const twin of TEST_BOOK_LABELS.twinCases) {
      const result = twinGate(twin.name, roster, TEST_BOOK_LABELS.dismissed)
      if (twin.outcome === 'new') {
        expect(result, twin.name).toEqual({ outcome: 'clear' })
        continue
      }
      expect(result.outcome, twin.name).toBe('blocked')
      if (result.outcome !== 'blocked') continue
      expect(result.rule, twin.name).toBe(RULE[twin.rule ?? ''])
      expect(result.recordId, twin.name).toBe(twin.blockedBy ?? null)
    }
  })
})
