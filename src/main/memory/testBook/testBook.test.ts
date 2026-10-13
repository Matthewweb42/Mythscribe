import { describe, expect, it } from 'vitest'
import { estimateTokens } from '@shared/ai'
import { normalizeForMatch } from '@shared/critique'
import { anchorFor, anchorHolds, sceneSentences } from '@shared/memory/anchor'
import { checkMemoryInvariants } from '@shared/memory/invariants'
import { PARTIAL, knowsLine } from '@shared/memory/knows'
import { locateQuote } from '@shared/memory/quote'
import { readerMayRead } from '@shared/memory/sources'
import type { ReadingOrder } from '@shared/memory/asOf'
import {
  changesSince,
  recordAge,
  sinceNodeId,
  storyYears,
  type AgeClaim
} from '@shared/memory/years'
import { TEST_BOOK, TEST_BOOK_SOURCE, testBookScene } from './book'
import { TEST_BOOK_LABELS } from './labels'
import { QUESTION_KINDS, TestBookLabels } from './labels.schema'
import { editedParagraphs } from './project'

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
    for (const step of LABELS.threads) {
      expect(located(step.scene, step.p, step.quote), step.quote).toBe(true)
    }
    for (const year of LABELS.years) {
      if (year.elapsed) {
        expect(located(year.scene, year.elapsed.p, year.elapsed.quote), year.scene).toBe(true)
      }
      if (year.quotedYear) {
        expect(located(year.scene, year.quotedYear.p, year.quotedYear.quote), year.scene).toBe(true)
      }
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
      ...LABELS.threads.map((step) => step.scene),
      ...LABELS.years.map((year) => year.scene),
      ...LABELS.ages.map((age) => age.scene),
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

  it('never names the original characters or places, nor opens with the novel’s first line', () => {
    const banned =
      /\b(Bennet|Darcy|Bingley|Elizabeth|Eliza|Lizzy|Jane|Kitty|Lydia|Charlotte|Collins|Hurst|Netherfield|Longbourn|Wickham|Meryton|Lucas|Pemberley|Derbyshire|Hertfordshire|London|Brighton|St\.? James's)\b|universally acknowledged/i
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
      ...LABELS.threads.map((step) => step.thread),
      ...LABELS.ages.map((age) => age.record),
      ...LABELS.negatives.flatMap((negative) => (negative.secret ? [negative.secret] : [])),
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

  it('labels knows lines with a knower and a secret of the right kinds (P2b)', () => {
    const kind = new Map(LABELS.records.map((record) => [record.id, record.kind]))
    for (const line of LABELS.knows) {
      expect(kind.get(line.secret), line.quote).toBe('secret')
      expect(['character', 'group'], line.quote).toContain(kind.get(line.learner))
      // Only told, overheard and read keep a source (P2b-D6).
      if (line.from !== null) expect(['told', 'overheard', 'read']).toContain(line.how)
      // As the text gives it, every learning or holding line counts and the rest are partial
      // (P2b-D7): a dialogue line is the learner's own words or its source's.
      if (line.voice === 'dialogue') expect(line.speaker, line.quote).toBeDefined()
      expect(
        knowsLine({
          how: line.how,
          voice: line.voice,
          mode: 'now',
          recordId: line.learner,
          speakerId: line.speaker ?? null,
          fromId: line.from
        }),
        line.quote
      ).toBe(PARTIAL.includes(line.how) ? 'partial' : 'counts')
    }
    for (const step of LABELS.threads) expect(kind.get(step.thread), step.quote).toBe('thread')
    for (const record of LABELS.records) {
      if (record.kind === 'secret' || record.kind === 'thread') {
        expect(record.defining, record.id).toBeDefined()
      }
    }
  })
})

/** The test book's readable scenes in reading order, as the app reads them as of a scene. */
const READABLE = TEST_BOOK.filter((scene) => readerMayRead(scene.source))
const READING: ReadingOrder = {
  order: new Map(READABLE.map((scene, i) => [scene.id, i])),
  at: new Map(READABLE.map((scene, i) => [scene.id, i])),
  refs: new Map(READABLE.map((scene) => [scene.id, scene.id]))
}

/** Decision 5 over the book's typed years and the labelled card fields. */
function bookYears(): ReturnType<typeof storyYears> {
  return storyYears(
    READABLE.map((scene) => {
      const label = LABELS.years.find((year) => year.scene === scene.id)
      return {
        nodeId: scene.id,
        ref: scene.id,
        typedYear: scene.details?.year ?? null,
        quotedYear: label?.quotedYear?.value ?? null,
        flashback: label?.flashback ?? false,
        elapsed:
          label?.elapsed === undefined
            ? null
            : { value: label.elapsed.quote, quote: label.elapsed.quote, para: label.elapsed.p }
      }
    })
  )
}

describe('the test book’s years and ages (P2b, decision 5)', () => {
  it('labels every readable scene’s year, and storyYears agrees', () => {
    expect(LABELS.years.map((year) => year.scene)).toEqual(READABLE.map((scene) => scene.id))
    for (const [i, computed] of bookYears().entries()) {
      const label = LABELS.years[i]
      if (label === undefined) throw new Error('missing label')
      const { year } = computed
      if (year.kind === 'unknown') {
        expect([label.source, label.year, year.hint?.nodeId], label.scene).toEqual([
          'unknown',
          null,
          label.hint
        ])
      } else {
        expect([year.kind, year.value], label.scene).toEqual([label.source, label.year])
        if (year.kind === 'carried') expect(year.from.nodeId, label.scene).toBe(label.from)
      }
    }
  })

  it('gives each labelled age as decision 5 computes it: hints listed, never added up', () => {
    const years = bookYears()
    const claims = (record: string, slot: 'age' | 'born'): AgeClaim[] =>
      LABELS.claims
        .filter(
          (claim) => claim.record === record && claim.slot === slot && claim.expect !== 'reject'
        )
        .map((claim) => ({
          id: claim.id,
          value: claim.value,
          voice: claim.voice,
          mode: claim.mode,
          state: 'live',
          nodeId: claim.scene,
          para: claim.p
        }))
    for (const label of LABELS.ages) {
      const age = recordAge({
        born: claims(label.record, 'born'),
        ages: claims(label.record, 'age'),
        pinned: [],
        years,
        reading: READING,
        atId: label.scene
      })
      const expected = label.expect
      if (expected.kind === 'stated') {
        expect(age, `${label.record} as of ${label.scene}`).toMatchObject({
          kind: 'stated',
          claimId: expected.claim
        })
        // The scenes where something changed since (a hint, a typed year), each once.
        expect(age?.kind === 'stated' ? [...new Set(age.since.map(sinceNodeId))] : null).toEqual(
          expected.since
        )
      } else {
        expect(age).toMatchObject({ kind: 'computed', age: expected.age })
      }
    }
    // Johanna's "two-and-twenty" in h08 is never moved on by the winters, the typed 1814 and
    // the year since: they are listed, never added up.
    expect(
      changesSince(years, 'h08', 'h14').map((entry) =>
        entry.kind === 'hint' ? entry.hint.text : entry.value
      )
    ).toEqual(['Three winters later', 1814, 'A year later'])
  })
})

/** How many times `quote` occurs in `text`, both normalized (straight quotes, single spaces). */
function occurrences(text: string, quote: string): number {
  const haystack = normalizeForMatch(text).toLowerCase()
  const needle = normalizeForMatch(quote).toLowerCase()
  if (needle === '') return 0
  let count = 0
  for (let at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, at + 1)) {
    count += 1
  }
  return count
}

describe('the test book’s questions for Ms Scribe (P3, plan §6.1)', () => {
  const records = new Map(LABELS.records.map((record) => [record.id, record]))
  const readable = new Set(
    TEST_BOOK.filter((scene) => scene.source === 'scene').map((scene) => scene.id)
  )
  /** A scene's text as the questions find it: with any labelled late edit made. */
  const sceneText = (id: string): string => {
    const edit = LABELS.questions.find((question) => question.edit?.scene === id)?.edit
    return (edit === undefined ? testBookScene(id).paragraphs : editedParagraphs(edit)).join('\n')
  }

  it('asks every kind, about 24 questions, each worded once', () => {
    expect(new Set(LABELS.questions.map((question) => question.kind))).toEqual(
      new Set(QUESTION_KINDS)
    )
    expect(LABELS.questions.length).toBeGreaterThanOrEqual(24)
    const ids = LABELS.questions.map((question) => question.id)
    expect(new Set(ids).size).toBe(ids.length)
    // The oracle and the live run's scoring find a question by its words.
    const texts = LABELS.questions.map((question) => question.question)
    expect(new Set(texts).size).toBe(texts.length)
  })

  it('opens every question on a readable scene, and its cited scene holds the quote once', () => {
    for (const question of LABELS.questions) {
      expect(readable, question.id).toContain(question.asOf)
      const { scene, quoteHas, label } = question.expected
      if (scene !== undefined) {
        expect(readable, question.id).toContain(scene)
        expect(quoteHas, question.id).toBeDefined()
        expect(occurrences(sceneText(scene), quoteHas ?? ''), question.id).toBe(1)
      }
      if (label !== undefined) {
        // A page's line: the record's Pinned (your notes) or Ideas (your idea).
        const page = LABELS.pages.find(
          (each) =>
            each.record === question.record && each.page === (label === 'idea' ? 'ideas' : 'pinned')
        )
        expect(page, question.id).toBeDefined()
        expect(occurrences(page?.lines.join('\n') ?? '', quoteHas ?? ''), question.id).toBe(1)
      }
      for (const also of question.expected.also ?? []) {
        const scenes = [...readable].filter((id) => occurrences(sceneText(id), also) === 1)
        expect(scenes.length, `${question.id}: ${also}`).toBe(1)
      }
    }
  })

  it('labels each kind with what it is scored on', () => {
    for (const question of LABELS.questions) {
      const { expected } = question
      const at = question.id
      switch (question.kind) {
        case 'slot':
        case 'knows':
        case 'whoKnows':
          expect(expected.instant, at).toBe(true)
          break
        case 'lookupStale':
          expect(expected.lookup, at).toBe(true)
          expect(expected.scene, at).toBeDefined()
          break
        case 'open':
        case 'ordinal':
          expect(question.terms?.length, at).toBeGreaterThan(0)
          expect(expected.quoteHas, at).toBeDefined()
          break
        case 'absence':
        case 'notFound':
          expect(question.terms?.length, at).toBeGreaterThan(0)
          expect(expected.scene, at).toBeUndefined()
          expect(expected.notFound ?? false, at).toBe(question.kind === 'notFound')
          break
        case 'idea':
          expect(expected.label, at).toBe('idea')
          break
        case 'route':
          expect(expected.action, at).toBeDefined()
          if (expected.action === 'editPass') {
            expect([expected.pass, expected.target], at).not.toContain(undefined)
          }
          break
        case 'pin':
          expect(question.record, at).toBeDefined()
          // A Plan run offers no sheet line; Ask places it.
          expect(expected.place === undefined, at).toBe(question.plan === true)
          expect(question.question.toLowerCase(), at).toContain(expected.pinText?.toLowerCase())
          break
      }
      if (question.record !== undefined) expect(records.has(question.record), at).toBe(true)
      if (question.edit !== undefined) {
        const paragraph = testBookScene(question.edit.scene).paragraphs[question.edit.p] ?? ''
        expect(occurrences(paragraph, question.edit.from), at).toBe(1)
      }
    }
  })

  it('writes its pages on records that exist, a Pinned note and two Ideas', () => {
    for (const page of LABELS.pages) expect(records.has(page.record), page.record).toBe(true)
    expect(LABELS.pages.map((page) => page.page).sort()).toEqual(['ideas', 'ideas', 'pinned'])
  })
})
