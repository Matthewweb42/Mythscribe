import { describe, expect, it } from 'vitest'
import { estimateTokens } from '@shared/ai'
import { anchorFor, anchorHolds, sceneSentences } from '@shared/memory/anchor'
import { checkMemoryInvariants } from '@shared/memory/invariants'
import { locateQuote } from '@shared/memory/quote'
import { readerMayRead } from '@shared/memory/sources'
import { TEST_BOOK, TEST_BOOK_SOURCE, testBookScene } from './book'
import { TEST_BOOK_LABELS } from './labels'
import { TestBookLabels } from './labels.schema'

/**
 * The test book and its labels checked with the same helpers the reader will use (F-16.3): a
 * label that the helpers cannot find is a broken label, caught here before P2a scores anything
 * against it.
 */

const LABELS = TestBookLabels.parse(TEST_BOOK_LABELS)
const RECORD_IDS = new Set(LABELS.records.map((record) => record.id))
const NEVER_READ = TEST_BOOK.filter((scene) => !readerMayRead(scene.source)).map((s) => s.id)

function located(scene: string, p: number, quote: string): boolean {
  return locateQuote(testBookScene(scene).paragraphs, p, quote).ok
}

function words(text: string): number {
  return text.split(/\s+/).filter(Boolean).length
}

describe('the test book (F-16.3)', () => {
  it('parses its labels', () => {
    expect(TestBookLabels.safeParse(TEST_BOOK_LABELS).success).toBe(true)
  })

  it('keeps scenes in reading order with unique ids', () => {
    const ids = TEST_BOOK.map((scene) => scene.id)
    expect(new Set(ids).size).toBe(ids.length)
    const chapters = TEST_BOOK.map((scene) => scene.chapter)
    expect(chapters).toEqual([...chapters].sort((a, b) => a - b))
    expect(TEST_BOOK.filter((scene) => scene.id.startsWith('s')).map((s) => s.id)).toEqual(
      TEST_BOOK_SOURCE.adapted
    )
  })

  it('is about 8,000 words: adapted excerpts and original hard cases', () => {
    const count = (prefix: string): number =>
      TEST_BOOK.filter((scene) => scene.id.startsWith(prefix))
        .flatMap((scene) => scene.paragraphs)
        .reduce((sum, paragraph) => sum + words(paragraph), 0)
    expect(count('s')).toBeGreaterThan(5_000)
    expect(count('h')).toBeGreaterThan(2_000)
    expect(count('s') + count('h')).toBeLessThan(9_500)
  })

  it('locates every expected claim’s quote exactly once, in its paragraph', () => {
    for (const claim of LABELS.claims) {
      const result = locateQuote(testBookScene(claim.scene).paragraphs, claim.p, claim.quote)
      expect(result, `${claim.id}: ${claim.quote}`).toMatchObject({ ok: true, p: claim.p })
    }
  })

  it('finds both quotes of every planted contradiction, and every knows line and defining quote', () => {
    for (const finding of LABELS.contradictions) {
      expect(located(finding.a.scene, finding.a.p, finding.a.quote), finding.a.quote).toBe(true)
      expect(located(finding.b.scene, finding.b.p, finding.b.quote), finding.b.quote).toBe(true)
    }
    for (const line of LABELS.knows) {
      expect(located(line.scene, line.p, line.quote), line.quote).toBe(true)
    }
    for (const record of LABELS.records) {
      if (record.defining) {
        const { scene, p, quote } = record.defining
        expect(located(scene, p, quote), quote).toBe(true)
      }
    }
  })

  it('anchors every expected claim on sentences that hold in the book as written', () => {
    for (const claim of LABELS.claims) {
      const paragraphs = testBookScene(claim.scene).paragraphs
      const location = locateQuote(paragraphs, claim.p, claim.quote)
      if (!location.ok) throw new Error(`${claim.id} not located`)
      const sentences = sceneSentences(paragraphs)
      const anchor = anchorFor(sentences, location)
      expect(anchor.length, claim.id).toBeGreaterThan(0)
      expect(anchorHolds(anchor, new Set(sentences.map((sentence) => sentence.hash)))).toBe(true)
    }
  })

  it('has the reader refuse every never-read scene, and labels no claim, knows line or contradiction in one', () => {
    expect(NEVER_READ).toEqual(['h10', 'h11', 'h12'])
    expect(
      TEST_BOOK.filter((scene) => scene.source === 'scene').every((scene) =>
        readerMayRead(scene.source)
      )
    ).toBe(true)
    const labelled = [
      ...LABELS.claims.map((claim) => claim.scene),
      ...LABELS.knows.map((line) => line.scene),
      ...LABELS.contradictions.flatMap((finding) => [finding.a.scene, finding.b.scene])
    ]
    for (const scene of labelled) expect(NEVER_READ).not.toContain(scene)
    // Each never-read scene has a negative saying what must not come out of it.
    for (const scene of NEVER_READ) {
      expect(LABELS.negatives.some((negative) => negative.scene === scene)).toBe(true)
    }
  })

  it('keeps every paragraph under the 2,500-token page of a full read', () => {
    for (const scene of TEST_BOOK) {
      for (const paragraph of scene.paragraphs) {
        expect(estimateTokens(paragraph)).toBeLessThanOrEqual(2_500)
      }
    }
  })

  it('never names the original characters or places', () => {
    const banned =
      /\b(Bennet|Darcy|Bingley|Elizabeth|Netherfield|Longbourn|Wickham|Meryton|Lucas)\b/i
    for (const scene of TEST_BOOK) {
      expect(scene.title).not.toMatch(banned)
      for (const paragraph of scene.paragraphs) expect(paragraph).not.toMatch(banned)
    }
    expect(JSON.stringify(TEST_BOOK_LABELS)).not.toMatch(banned)
  })

  it('points every label at a record that exists', () => {
    const referenced = [
      ...LABELS.claims.flatMap((claim) => [
        claim.record,
        ...(claim.speaker ? [claim.speaker] : [])
      ]),
      ...LABELS.mentions.flatMap((mention) => mention.records),
      ...LABELS.twinCases.flatMap((twin) => (twin.blockedBy ? [twin.blockedBy] : [])),
      ...LABELS.knows.flatMap((line) => [
        line.secret,
        line.learner,
        ...(line.from ? [line.from] : [])
      ]),
      ...LABELS.contradictions.map((finding) => finding.record),
      ...LABELS.negatives.flatMap((negative) => (negative.record ? [negative.record] : [])),
      ...LABELS.records.flatMap((record) => (record.originator ? [record.originator] : [])),
      ...TEST_BOOK.flatMap((scene) => [scene.details?.pov, scene.details?.place]).filter(
        (id): id is string => id !== undefined
      )
    ]
    for (const id of referenced) expect(RECORD_IDS, id).toContain(id)
  })

  it('labels a mention only where one of the record’s aliases is in the scene', () => {
    for (const mention of LABELS.mentions) {
      const text = testBookScene(mention.scene).paragraphs.join('\n').replace(/[‘’]/g, "'")
      for (const id of mention.records) {
        const record = LABELS.records.find((candidate) => candidate.id === id)
        const found = record?.aliases.some((alias) => text.includes(alias.text)) ?? false
        expect(found, `${mention.scene}: ${id}`).toBe(true)
      }
    }
  })

  it('gives no unshared alias to two records (the alias invariant over the labels)', () => {
    const aliases = LABELS.records.flatMap((record) =>
      record.aliases.map((alias) => ({
        recordId: record.id,
        norm: alias.text.toLowerCase().replace(/\./g, ''),
        shared: alias.shared
      }))
    )
    expect(
      checkMemoryInvariants({ claims: [], sceneHashes: new Map(), aliases, citations: [] })
    ).toEqual([])
  })

  it('names a record for every twin case that is blocked by one', () => {
    for (const twin of LABELS.twinCases) {
      if (twin.outcome === 'new') expect(twin.blockedBy).toBeUndefined()
      else if (twin.rule === 'dismissed') expect(LABELS.dismissed).toContain(twin.name)
      else expect(twin.blockedBy).toBeDefined()
    }
  })
})
