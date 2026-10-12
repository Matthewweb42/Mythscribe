import { describe, expect, it } from 'vitest'
import { passageParagraphs, type Paragraph } from '@shared/mentions'
import { literalProof, sentenceNames } from '@shared/memory/literal'
import { buildNameIndex, scanNames, type ScanAlias } from '@shared/memory/nameScan'
import { normName } from '@shared/memory/names'
import { locateQuote } from '@shared/memory/quote'
import { splitSentences } from '@shared/memory/sentences'
import { parseSlot } from '@shared/memory/slots'
import { TEST_BOOK } from './book'
import { TEST_BOOK_LABELS } from './labels'

/**
 * Literal proof over the test book (F-16.17; plan P2a §1.5): every claim labelled `literal` is
 * proved in code from its scene's sentence and the name scan's names, and no claim labelled
 * `verified` or `reject` is (those go to the verifier, or are never stored).
 */

const doc = (texts: readonly string[]): Paragraph[] =>
  passageParagraphs({
    type: 'doc',
    content: texts.map((text) => ({ type: 'paragraph', content: [{ type: 'text', text }] }))
  })

const RECORDS = TEST_BOOK_LABELS.records
const KINDS = new Map(RECORDS.map((record) => [record.id, record.kind]))
const ALIASES: ScanAlias[] = RECORDS.flatMap((record) =>
  record.aliases.map((alias, i) => ({
    id: `${record.id}:${i}`,
    recordId: record.id,
    text: alias.text,
    norm: normName(alias.text),
    caseRule: alias.text === 'the Captain' ? ('exact' as const) : ('auto' as const),
    shared: alias.shared ?? false
  }))
)
const INDEX = buildNameIndex(
  RECORDS.map((record) => ({ id: record.id, kind: record.kind })),
  ALIASES
)

function prove(id: string): ReturnType<typeof literalProof> {
  const label = TEST_BOOK_LABELS.claims.find((claim) => claim.id === id)
  if (label === undefined) throw new Error(`No claim ${id}`)
  const scene = TEST_BOOK.find((each) => each.id === label.scene)
  if (scene === undefined) throw new Error(`No scene ${label.scene}`)
  const paragraphs = doc(scene.paragraphs)
  const mentions = scanNames(paragraphs, INDEX, {
    povRecordId: scene.details?.pov ?? null,
    notMention: new Set()
  })
  const location = locateQuote(scene.paragraphs, label.p, label.quote)
  if (!location.ok) throw new Error(`Quote of ${id} not found: ${location.reason}`)
  const paragraph = paragraphs[label.p]
  const span = splitSentences(scene.paragraphs[label.p] ?? '')[location.sentences[0] ?? 0]
  const slot = parseSlot(label.slot)
  if (paragraph === undefined || span === undefined || slot === null) {
    throw new Error(`Bad label ${id}`)
  }
  return literalProof(
    {
      recordId: label.record,
      slot,
      value: label.value,
      voice: label.voice,
      mode: label.mode,
      quote: label.quote
    },
    span.text,
    sentenceNames(paragraph, span, mentions, (recordId) => KINDS.get(recordId))
  )
}

describe('literal proof over the test book (F-16.17)', () => {
  const literal = TEST_BOOK_LABELS.claims.filter((claim) => claim.expect === 'literal')
  const others = TEST_BOOK_LABELS.claims.filter((claim) => claim.expect !== 'literal')

  it('has labels of both kinds to check', () => {
    expect(literal.length).toBeGreaterThanOrEqual(8)
    expect(others.length).toBeGreaterThanOrEqual(10)
  })

  it.each(literal.map((claim) => [claim.id, claim.value]))(
    'proves %s in code, its value cut to the quote (%s)',
    (id, value) => {
      const result = prove(id)
      expect(result, id).toEqual({ ok: true, value })
    }
  )

  it.each(others.map((claim) => [claim.id, claim.expect]))(
    'leaves %s (%s) to the verifier',
    (id) => {
      expect(prove(id).ok, id).toBe(false)
    }
  )

  it('says why the hard cases miss', () => {
    expect(prove('captain-not-blue')).toEqual({ ok: false, reason: 'marker', marker: 'negation' })
    expect(prove('harrow-traits')).toMatchObject({ ok: false, reason: 'marker' })
    expect(prove('johanna-dream')).toEqual({ ok: false, reason: 'voiceMode' })
    expect(prove('green-eyes-trap')).toEqual({ ok: false, reason: 'subject' })
    expect(prove('lottie-tallest')).toEqual({ ok: false, reason: 'voiceMode' })
  })
})
