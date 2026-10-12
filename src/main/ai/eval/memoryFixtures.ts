import { estimateTokens } from '@shared/ai'
import { normalizeForMatch } from '@shared/critique'
import { splitSentences } from '@shared/memory/sentences'
import { outputCap, PAGE_TOKENS } from '@shared/memory/windows'
import { TEST_BOOK, testBookScene, type TestBookScene } from '../../memory/testBook/book'
import { TEST_BOOK_LABELS } from '../../memory/testBook/labels'
import {
  buildReaderPrompt,
  readerRosterLine,
  READER_ANCHORED_TOKENS,
  READER_NEAR_TOKENS,
  READER_PROMPT_VERSION,
  READER_ROSTER_TOKENS,
  type BuildReaderPromptInput
} from '../prompts/reader.v1'
import {
  buildVerifyPrompt,
  VERIFY_BATCH_TOKENS,
  VERIFY_PROMPT_VERSION,
  VERIFY_UNNAMED_MARK,
  verifyBatches,
  type VerifyPromptItem
} from '../prompts/verify.v1'
import type { EvalCase, ReaderEvalLabel } from './fixtures'

/**
 * The story-memory reader's and checker's eval cases (F-16.17; plan P2a §2.7), built from the test
 * book (`memory/testBook`) with the prompts' own builders and roster format, so the token report
 * measures what the pipeline sends: `reader.v1` on a disguised-Austen first read, on each hard-case
 * scene (the pronoun trap, the Captain, a lie, a memory, a negation, a shared surname, a time skip,
 * a dream), on a window, and at its worst (a 2,500-token page with a full roster and every block at
 * its cap); `verify.v1` on a typical batch, its worst batch, and a strong spot check. Live, they
 * score against the labels (`reader`: quotes found, rejected facts never offered as narration-now,
 * recall per slot; `verify`: each verdict against the label's `expect`).
 */

// P2b's records (h13, h14) stay out: the `reader.v1` cases' roster, and so their token rows, are
// as P2a wrote them.
const RECORDS = TEST_BOOK_LABELS.records.filter(
  (record) => record.kind !== 'secret' && record.kind !== 'thread' && record.addedFor === undefined
)

/** The test book's roster as the reader sees it, `r1`… in label order. */
const SHORT = new Map(RECORDS.map((record, i) => [record.id, `r${i + 1}`]))
export const TEST_BOOK_ROSTER: readonly string[] = RECORDS.map((record, i) =>
  readerRosterLine(`r${i + 1}`, {
    name: record.name,
    kind: record.kind,
    nicknames: record.aliases.map((alias) => alias.text).filter((text) => text !== record.name)
  })
)

const short = (id: string | undefined): string => (id === undefined ? '' : (SHORT.get(id) ?? ''))

function typed(scene: TestBookScene): string | null {
  const details = scene.details
  if (details === undefined) return null
  const parts: string[] = []
  if (details.pov !== undefined) parts.push(`POV ${short(details.pov)}`)
  if (details.place !== undefined) parts.push(`place ${short(details.place)}`)
  if (details.time !== undefined) parts.push(`time ${details.time}`)
  if (details.year !== undefined) parts.push(`year ${details.year}`)
  return parts.length === 0 ? null : parts.join(' · ')
}

type TestBookLabel = (typeof TEST_BOOK_LABELS.claims)[number]

const labelsOf = (sceneId: string, paras: ReadonlySet<number>): TestBookLabel[] =>
  TEST_BOOK_LABELS.claims.filter((claim) => claim.scene === sceneId && paras.has(claim.p))

const toLabel = (claim: (typeof TEST_BOOK_LABELS.claims)[number]): ReaderEvalLabel => ({
  slot: claim.slot,
  quote: claim.quote,
  p: claim.p
})

/** A reader case over scene `id` (or its paragraphs `window`), as the pipeline would send it. */
function readerCase(
  name: string,
  note: string,
  id: string,
  options: { window?: number[]; near?: string[]; anchored?: string[]; card?: string } = {}
): EvalCase {
  const scene = testBookScene(id)
  const paras = options.window ?? scene.paragraphs.map((_, p) => p)
  const paragraphs = paras.map((p) => ({ p, text: scene.paragraphs[p] ?? '' }))
  const full = options.window === undefined
  const proseTokens = paragraphs.reduce((sum, paragraph) => sum + estimateTokens(paragraph.text), 0)
  const input: BuildReaderPromptInput = {
    roster: TEST_BOOK_ROSTER,
    position: full
      ? `Scene ${scene.chapter}.1 “${scene.title}”, the whole scene`
      : `Scene ${scene.chapter}.1 “${scene.title}”, the changed paragraphs`,
    typed: typed(scene),
    card: options.card ?? null,
    near: options.near ?? [],
    anchored: options.anchored ?? [],
    paragraphs,
    cardDue: full,
    maxTokens: outputCap({ purpose: full ? 'full' : 'window', proseTokens, cardDue: full })
  }
  const built = buildReaderPrompt(input)
  const sent = new Set(paras)
  const labels = labelsOf(id, sent)
  return {
    version: READER_PROMPT_VERSION,
    name,
    note,
    messages: built.messages,
    maxTokens: built.maxTokens,
    scoring: {
      kind: 'reader',
      paragraphs,
      expected: labels.filter((claim) => claim.expect !== 'reject').map(toLabel),
      rejected: labels
        .filter((claim) => claim.expect === 'reject' && claim.voice === 'narration')
        .map(toLabel)
    }
  }
}

/** The worst reader request: a 2,500-token page, a full roster, every tail block at its cap. */
function worstReaderCase(): EvalCase {
  const source = TEST_BOOK.filter((scene) => scene.source === 'scene').flatMap(
    (scene) => scene.paragraphs
  )
  const paragraphs: { p: number; text: string }[] = []
  let tokens = 0
  for (const text of source) {
    if (tokens + estimateTokens(text) > PAGE_TOKENS) break
    paragraphs.push({ p: paragraphs.length, text })
    tokens += estimateTokens(text)
  }
  const roster: string[] = [...TEST_BOOK_ROSTER]
  for (
    let i = roster.length;
    estimateTokens([...roster, ''].join('\n')) < READER_ROSTER_TOKENS - 120;
    i += 1
  ) {
    roster.push(
      readerRosterLine(`r${i + 1}`, {
        name: `Townsperson Number ${i}`,
        kind: 'character',
        nicknames: [`Number ${i}`]
      })
    )
  }
  const near = Array.from(
    { length: 40 },
    (_, i) =>
      `r${i + 1} eyes “grey” · hair “dark brown” · role “the steward’s son” · age “two-and-twenty”`
  )
  const anchored = Array.from(
    { length: 30 },
    (_, i) =>
      `c${i + 1} r${i + 1} location “at the long window of the hall” ¶${i % 20}, re-checking`
  )
  const built = buildReaderPrompt({
    roster,
    position: 'Scene 14.1 “Three winters later”, page 1 of 2 (the whole scene)',
    typed: 'POV r4 · place r26 · time January · year 1814',
    card: `${'The guests arrive at the hall, and the old quarrels are not mentioned. '.repeat(4)}· where Thornmere · POV r4`,
    near,
    anchored,
    paragraphs,
    cardDue: true,
    maxTokens: outputCap({ purpose: 'full', proseTokens: tokens, cardDue: true })
  })
  return {
    version: READER_PROMPT_VERSION,
    name: 'maxed',
    note: `the worst input: a ${PAGE_TOKENS}-token page, the roster at its ${READER_ROSTER_TOKENS}-token cap, the known facts at ${READER_NEAR_TOKENS} and the listed ones at ${READER_ANCHORED_TOKENS}, the card due`,
    messages: built.messages,
    maxTokens: built.maxTokens,
    scoring: { kind: 'reader', paragraphs, expected: [], rejected: [] }
  }
}

/** The sentences of a label's quote ±1 in its paragraph (and the one before, for a pronoun). */
function labelText(sceneId: string, p: number, quote: string, around = 1): string {
  const scene = testBookScene(sceneId)
  const all = scene.paragraphs.flatMap((paragraph, at) =>
    splitSentences(paragraph).map((span) => ({ p: at, text: span.text }))
  )
  const needle = normalizeForMatch(quote).slice(0, 20)
  const at = all.findIndex(
    (sentence) => sentence.p === p && normalizeForMatch(sentence.text).includes(needle)
  )
  if (at === -1) throw new Error(`No sentence for “${quote}” in ${sceneId} ¶${p}`)
  return all
    .slice(Math.max(0, at - around), at + around + 1)
    .map((sentence) => sentence.text)
    .join(' ')
}

const LINE = new Map(RECORDS.map((record, i) => [record.id, TEST_BOOK_ROSTER[i] ?? '']))
const who = (...ids: string[]): string[] => ids.map((id) => LINE.get(id) ?? '')

/**
 * A claim item from a label, its candidates `candidates` (the label's record first, or last and
 * marked `VERIFY_UNNAMED_MARK` when `unnamed`: a role the text gives, as the pipeline sends it).
 */
function labelItem(
  id: string,
  candidates: string[] = [],
  options: { unnamed?: boolean } = {}
): VerifyPromptItem & { expect: boolean } {
  const label = TEST_BOOK_LABELS.claims.find((claim) => claim.id === id)
  if (label === undefined) throw new Error(`No label ${id}`)
  const by = label.speaker === undefined ? '' : ` by ${short(label.speaker)}`
  return {
    kind: 'claim',
    who:
      options.unnamed === true
        ? [...who(...candidates), `${LINE.get(label.record) ?? ''}${VERIFY_UNNAMED_MARK}`]
        : who(label.record, ...candidates),
    fact: `${label.slot}: ${label.value} (${label.voice}${by}, ${label.mode})`,
    text: labelText(label.scene, label.p, label.quote),
    expect: label.expect !== 'reject'
  }
}

function verifyCase(
  name: string,
  note: string,
  items: readonly (VerifyPromptItem & { expect: boolean })[],
  strong = false
): EvalCase {
  const built = buildVerifyPrompt({ items, strong })
  return {
    version: VERIFY_PROMPT_VERSION,
    name,
    note,
    messages: built.messages,
    maxTokens: built.maxTokens,
    scoring: {
      kind: 'verify',
      expected: (strong ? items.slice(0, 1) : items).map((item) => item.expect)
    }
  }
}

const TYPICAL_BATCH = [
  // "his wife": Mrs. Harrow is named nowhere in reach, so she is offered marked (2026-10-12).
  labelItem('mrs-harrow-temper', ['harrow-mr'], { unnamed: true }),
  labelItem('liesel-disposition', ['varrow']),
  labelItem('captain-not-blue'),
  labelItem('captain-slate'),
  labelItem('dunmore-clergyman'),
  labelItem('green-eyes-trap', ['liesel']),
  labelItem('johanna-dream'),
  {
    kind: 'pov' as const,
    who: who('liesel'),
    fact: `the scene is told from ${short('liesel')}'s point of view`,
    text: labelText('h06', 1, 'In the dream, Johanna was dead'),
    expect: true
  },
  {
    kind: 'present' as const,
    who: who('captain'),
    fact: `${short('captain')} is on the page in this scene (present, not only named or remembered)`,
    text: labelText('h02', 2, 'the Captain had a long white scar across his jaw'),
    expect: true
  }
]

/**
 * The worst batch: the first batch `verifyBatches` makes of the labels' facts, over and over, so
 * it stops at its 2,500-token cap or at the verdicts its output budget holds, whichever comes first.
 */
function worstBatch(): (VerifyPromptItem & { expect: boolean })[] {
  const pool = TEST_BOOK_LABELS.claims.map((claim) => labelItem(claim.id))
  const many = Array.from({ length: 4 }, () => pool).flat()
  return verifyBatches(many)[0] ?? []
}

/** A strong spot check: one verified claim with three sentences either side. */
function strongItem(): VerifyPromptItem & { expect: boolean } {
  const item = labelItem('varrow-eyes-brown')
  return { ...item, text: labelText('h09', 2, "Varrow's brown eyes followed her", 3) }
}

export const MEMORY_EVAL_CASES: readonly EvalCase[] = [
  readerCase(
    'austen',
    'a first read of a disguised-Austen scene (s03, the assembly): rumours, pronouns, a literal eye colour',
    's03'
  ),
  readerCase(
    'pronoun trap',
    'h01: two women in the room and “She had green eyes”; a memory of a mother’s red hair',
    'h01'
  ),
  readerCase(
    'captain',
    'h02: a man known only by the title the author confirmed; a negation; a lie in his own words',
    'h02'
  ),
  readerCase(
    'shared surname',
    'h03: “Harrow” with both Harrows in the room; a death told through a pronoun',
    'h03'
  ),
  readerCase('dream', 'h06: a death in a dream, which must never set state', 'h06'),
  readerCase('time skip', 'h09: three winters later, a stated age, brown eyes against grey', 'h09'),
  readerCase(
    'window',
    'a window read (s03 ¶3–5): the facts known about Varrow and those anchored there go along',
    's03',
    {
      window: [3, 4, 5],
      near: [
        `${short('varrow')} eyes “grey”`,
        `${short('ashby')} traits “good-looking and gentlemanlike”`
      ],
      anchored: [
        `c1 ${short('varrow')} eyes “grey” ¶4`,
        `c2 ${short('varrow')} detail:income “ten thousand a year” ¶4, re-checking`
      ],
      card: `The assembly at Callow Cross: Ashby charms everyone and Varrow offends. · where Callow Cross · POV ${short('liesel')}`
    }
  ),
  worstReaderCase(),
  verifyCase(
    'typical',
    'a batch of the hard cases: two pronouns, a negation, a lie, the pronoun trap, a dream, a card POV, a presence check',
    TYPICAL_BATCH
  ),
  verifyCase(
    'maxed',
    `the worst batch: items up to its ${VERIFY_BATCH_TOKENS}-token cap or its output budget`,
    worstBatch()
  ),
  verifyCase(
    'strong',
    'a strong spot check: one verified claim, three sentences either side, 40 tokens out',
    [strongItem()],
    true
  )
]
