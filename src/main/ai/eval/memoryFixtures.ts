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
import {
  buildReaderV2Prompt,
  READER_V2_ANCHORED_TOKENS,
  READER_V2_NEAR_TOKENS,
  READER_V2_PROMPT_VERSION,
  READER_V2_RECORD_ROSTER_TOKENS,
  READER_V2_TOPIC_LINES_TOKENS,
  READER_V2_TOPICS_TOKENS
} from '../prompts/reader.v2'
import {
  buildVerifyV2Prompt,
  VERIFY_V2_PROMPT_VERSION,
  verifyV2Batches,
  type VerifyV2Item
} from '../prompts/verify.v2'
import { topicLinesTokens, topicRosterLine } from '@shared/memory/topics'
import type { EvalCase, ReaderEvalLabel, ReaderKnowsLabel, ReaderStepLabel } from './fixtures'

/**
 * The story-memory reader's and checker's eval cases (F-16.17; plan P2a §2.7), built from the test
 * book (`memory/testBook`) with the prompts' own builders and roster format, so the token report
 * measures what the pipeline sends: `reader.v1` on a disguised-Austen first read, on each hard-case
 * scene (the pronoun trap, the Captain, a lie, a memory, a negation, a shared surname, a time skip,
 * a dream), on a window, and at its worst (a 2,500-token page with a full roster and every block at
 * its cap); `verify.v1` on a typical batch, its worst batch, and a strong spot check. Live, they
 * score against the labels (`reader`: quotes found, rejected facts never offered as narration-now,
 * recall per slot; `verify`: each verdict against the label's `expect`).
 *
 * P2b (F-16.22, F-16.23; plan P2b §2.5): `reader.v2` on the knows scenes (h04 told and tells, h05
 * overheard, h08 a letter read and a thread advanced, h13 a group learner and a refer, h14 deduced,
 * suspects and believes otherwise, with the rumour and Mr. Harrow as negatives), a window read with
 * topic lines, and its worst input; `verify.v2` on a typical knows batch, a reveals and same-as
 * batch, its worst batch and a strong knows spot check. Live, they score knows lines on learner,
 * secret, how and source, steps on thread and step, and same-as items on their verdict.
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

// ---- P2b: reader.v2 and verify.v2 (F-16.22, F-16.23) -------------------------------------------

/** The v2 roster: every record but the secrets and threads (P2b's own records included). */
const RECORDS_V2 = TEST_BOOK_LABELS.records.filter(
  (record) => record.kind !== 'secret' && record.kind !== 'thread'
)
const SHORT_V2 = new Map(RECORDS_V2.map((record, i) => [record.id, `r${i + 1}`]))
const TEST_BOOK_ROSTER_V2: readonly string[] = RECORDS_V2.map((record, i) =>
  readerRosterLine(`r${i + 1}`, {
    name: record.name,
    kind: record.kind,
    nicknames: record.aliases.map((alias) => alias.text).filter((text) => text !== record.name)
  })
)
const shortV2 = (id: string | undefined): string =>
  id === undefined ? '' : (SHORT_V2.get(id) ?? '')
const LINE_V2 = new Map(RECORDS_V2.map((record, i) => [record.id, TEST_BOOK_ROSTER_V2[i] ?? '']))
const whoV2 = (...ids: string[]): string[] => ids.map((id) => LINE_V2.get(id) ?? '')

/** The secrets' and threads' ids as the topics roster gives them, in the order a book read meets them. */
const TOPIC_SHORT: Readonly<Record<string, string>> = {
  'secret-engagement': 's1',
  'thread-lottie-match': 't1',
  'thread-ashby-return': 't2',
  'secret-debts': 's2'
}
const topicRecord = (id: string): (typeof TEST_BOOK_LABELS.records)[number] => {
  const found = TEST_BOOK_LABELS.records.find((record) => record.id === id)
  if (found === undefined) throw new Error(`No record ${id}`)
  return found
}
/** The topics roster lines of these topics (`s1 Lottie's engagement to Mr. Dunmore · secret`). */
const topicsRoster = (...ids: string[]): string[] =>
  ids.map((id) => {
    const record = topicRecord(id)
    return topicRosterLine(
      TOPIC_SHORT[id] ?? '?',
      record.name,
      record.kind === 'secret' ? 'secret' : 'thread'
    )
  })

function typedV2(scene: TestBookScene): string | null {
  const details = scene.details
  if (details === undefined) return null
  const parts: string[] = []
  if (details.pov !== undefined) parts.push(`POV ${shortV2(details.pov)}`)
  if (details.place !== undefined) parts.push(`place ${shortV2(details.place)}`)
  if (details.time !== undefined) parts.push(`time ${details.time}`)
  if (details.year !== undefined) parts.push(`year ${details.year}`)
  return parts.length === 0 ? null : parts.join(' · ')
}

/**
 * A `reader.v2` case over scene `id` (or its paragraphs `window`), with the topics listed by then
 * in book order (`listed`), and the scene's knows and thread labels to score against.
 */
function readerV2Case(
  name: string,
  note: string,
  id: string,
  listed: readonly string[],
  options: {
    window?: number[]
    near?: string[]
    topicLines?: string[]
    anchored?: string[]
    card?: string
    notKnowing?: string[]
  } = {}
): EvalCase {
  const scene = testBookScene(id)
  const paras = options.window ?? scene.paragraphs.map((_, p) => p)
  const paragraphs = paras.map((p) => ({ p, text: scene.paragraphs[p] ?? '' }))
  const full = options.window === undefined
  const proseTokens = paragraphs.reduce((sum, paragraph) => sum + estimateTokens(paragraph.text), 0)
  const built = buildReaderV2Prompt({
    roster: TEST_BOOK_ROSTER_V2,
    topics: topicsRoster(...listed),
    position: full
      ? `Scene ${scene.chapter}.1 “${scene.title}”, the whole scene`
      : `Scene ${scene.chapter}.1 “${scene.title}”, the changed paragraphs`,
    typed: typedV2(scene),
    card: options.card ?? null,
    near: options.near ?? [],
    topicLines: options.topicLines ?? [],
    anchored: options.anchored ?? [],
    paragraphs,
    cardDue: full,
    maxTokens: outputCap({ purpose: full ? 'full' : 'window', proseTokens, cardDue: full })
  })
  const sent = new Set(paras)
  const listedShort = (topic: string): string | null =>
    listed.includes(topic) ? (TOPIC_SHORT[topic] ?? null) : null
  const knows: ReaderKnowsLabel[] = TEST_BOOK_LABELS.knows
    .filter((label) => label.scene === id && sent.has(label.p))
    .map((label) => ({
      learner: shortV2(label.learner),
      secret: listedShort(label.secret),
      how: label.how,
      from: label.from === null ? null : shortV2(label.from),
      p: label.p,
      quote: label.quote
    }))
  const steps: ReaderStepLabel[] = TEST_BOOK_LABELS.threads
    .filter((label) => label.scene === id && sent.has(label.p))
    .map((label) => ({
      thread: listedShort(label.thread),
      how: label.how,
      p: label.p,
      quote: label.quote
    }))
  const labels = labelsOf(id, sent)
  return {
    version: READER_V2_PROMPT_VERSION,
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
        .map(toLabel),
      knows,
      steps,
      notKnowing: (options.notKnowing ?? []).map(shortV2)
    }
  }
}

/** The worst `reader.v2` input: full rosters, a 2,500-token page, every tail block at its cap. */
function worstReaderV2Case(): EvalCase {
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
  const roster: string[] = [...TEST_BOOK_ROSTER_V2]
  for (
    let i = roster.length;
    estimateTokens([...roster, ''].join('\n')) < READER_V2_RECORD_ROSTER_TOKENS - 30;
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
  const topics = topicsRoster(
    'secret-engagement',
    'thread-lottie-match',
    'thread-ashby-return',
    'secret-debts'
  )
  for (let i = topics.length; ; i += 1) {
    const line = topicRosterLine(`s${i + 1}`, `the secret kept at the hall number ${i}`, 'secret')
    if (topicLinesTokens([...topics, line]) > READER_V2_TOPICS_TOKENS) break
    topics.push(line)
  }
  const near = Array.from(
    { length: 30 },
    (_, i) =>
      `r${i + 1} eyes “grey” · hair “dark brown” · role “the steward’s son” · age “two-and-twenty”`
  )
  const topicLines = Array.from(
    { length: 12 },
    (_, i) =>
      `s${i + 1} the secret kept at the hall: r${i + 1} overheard 9.${i + 1} (from r${i + 2}); r${i + 3} knew before 2.1`
  )
  const anchored = Array.from(
    { length: 30 },
    (_, i) =>
      `c${i + 1} r${i + 1} knows s${(i % 4) + 1} overheard from r${i + 2} ¶${i % 20}, re-checking`
  )
  const built = buildReaderV2Prompt({
    roster,
    topics,
    position: 'Scene 14.1 “Three winters later”, page 1 of 2 (the whole scene)',
    typed: 'POV r4 · place r26 · time January · year 1814',
    card: `${'The guests arrive at the hall, and the old quarrels are not mentioned. '.repeat(4)}· where Thornmere · POV r4`,
    near,
    topicLines,
    anchored,
    paragraphs,
    cardDue: true,
    maxTokens: outputCap({ purpose: 'full', proseTokens: tokens, cardDue: true })
  })
  return {
    version: READER_V2_PROMPT_VERSION,
    name: 'maxed',
    note: `the worst input: a ${PAGE_TOKENS}-token page, the record roster at its ${READER_V2_RECORD_ROSTER_TOKENS} and the topics at ${READER_V2_TOPICS_TOKENS}, near ${READER_V2_NEAR_TOKENS}, topic lines ${READER_V2_TOPIC_LINES_TOKENS}, anchored ${READER_V2_ANCHORED_TOKENS}, the card due`,
    messages: built.messages,
    maxTokens: built.maxTokens,
    scoring: { kind: 'reader', paragraphs, expected: [], rejected: [] }
  }
}

/** The sentences of a quote ±`around` in its scene (the v2 label helpers). */
const textOf = (scene: string, p: number, quote: string, around = 1): string =>
  labelText(scene, p, quote, around)

type KnowsLabel = (typeof TEST_BOOK_LABELS.knows)[number]

/** A knows item from a label (or a planted one), with its source candidates and its secret. */
function knowsItem(
  label: Pick<KnowsLabel, 'secret' | 'learner' | 'how' | 'from' | 'scene' | 'p' | 'quote'>,
  options: { from?: string[]; expect?: boolean; around?: number } = {}
): VerifyV2Item & { expect: boolean } {
  const secret = topicRecord(label.secret)
  const defining = secret.defining
  const reveal = defining === undefined ? '' : `: “${defining.quote}”`
  const from = options.from ?? (label.from === null ? [] : [label.from])
  return {
    kind: 'knows',
    who: whoV2(label.learner),
    from: whoV2(...from),
    topic: `${TOPIC_SHORT[label.secret] ?? '?'} ${secret.name}${reveal}`,
    fact: `knows, ${label.how}${label.from === null ? '' : ` from ${shortV2(label.from)}`} (narration, now)`,
    text: textOf(label.scene, label.p, label.quote, options.around ?? 1),
    expect: options.expect ?? true
  }
}

const knowsLabel = (learner: string, secret: string, scene: string): KnowsLabel => {
  const found = TEST_BOOK_LABELS.knows.find(
    (label) => label.learner === learner && label.secret === secret && label.scene === scene
  )
  if (found === undefined) throw new Error(`No knows label ${learner} ${secret} ${scene}`)
  return found
}

function verifyV2Case(
  name: string,
  note: string,
  items: readonly (VerifyV2Item & { expect: boolean | 'notCounted' })[],
  strong = false
): EvalCase {
  const built = buildVerifyV2Prompt({ items, strong })
  return {
    version: VERIFY_V2_PROMPT_VERSION,
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

const TYPICAL_V2_BATCH: (VerifyV2Item & { expect: boolean })[] = [
  knowsItem(knowsLabel('liesel', 'secret-engagement', 'h05'), { from: ['lottie', 'bel'] }),
  knowsItem(knowsLabel('johanna', 'secret-engagement', 'h08'), { from: ['lottie', 'bel'] }),
  knowsItem(knowsLabel('regiment', 'secret-engagement', 'h13')),
  knowsItem(knowsLabel('harrow-mrs', 'secret-debts', 'h14'), { from: ['captain', 'bel'] }),
  // Mr. Harrow notices nothing: no knows line for him (a negative).
  knowsItem(
    {
      secret: 'secret-debts',
      learner: 'harrow-mr',
      how: 'deduced',
      from: null,
      scene: 'h14',
      p: 4,
      quote: 'noticed nothing at all'
    },
    { from: ['captain'], expect: false }
  ),
  {
    kind: 'step',
    who: [],
    topic: `t1 Lottie's match: “Lottie is to marry Mr. Dunmore”`,
    fact: 'resolves: Lottie is married (narration, now)',
    text: textOf('h09', 3, 'Lottie was eighteen now, and married'),
    expect: true
  },
  // A supposed return opens nothing: stated as now, it is not supported.
  {
    kind: 'step',
    who: [],
    topic: `t2 Ashby's return: “he said that he was coming back to Thornmere”`,
    fact: `opens: Ashby comes back (dialogue by ${shortV2('liesel')}, now)`,
    text: textOf('h07', 6, 'If Mr. Ashby came back tomorrow'),
    expect: false
  },
  {
    kind: 'present',
    who: whoV2('clara'),
    fact: `${shortV2('clara')} is on the page in this scene (present, not only named or remembered)`,
    text: textOf('h04', 3, 'Then why do you tell me'),
    expect: true
  }
]

/** h14's town talk of the Captain's losses at cards: a secret only rumoured (P2b-D7). */
const H14_RUMOUR = 'it was said that the Captain had lost an estate at cards'

const REVEALS_SAME_BATCH: (VerifyV2Item & { expect: boolean | 'notCounted' })[] = [
  {
    kind: 'reveals',
    who: [],
    topic: "x1 Lottie's engagement · new secret",
    fact: '',
    text: textOf('h05', 2, 'Mr. Dunmore and I are engaged'),
    expect: true
  },
  {
    kind: 'same',
    who: [],
    topic:
      "x1 Lottie's engagement: “Mr. Dunmore and I are engaged” (10.1) | s1 the secret engagement: “Lottie is to marry Mr. Dunmore” (9.1)",
    fact: '',
    text: '',
    expect: true
  },
  {
    kind: 'reveals',
    who: [],
    topic: "x2 the Captain's debts · new secret",
    fact: '',
    text: textOf('h14', 7, 'The Captain owed Mr. Varrow money'),
    expect: true
  },
  {
    kind: 'same',
    who: [],
    topic:
      "x2 the Captain's debts: “The Captain owed Mr. Varrow money” (18.1) | s1 the secret engagement: “Lottie is to marry Mr. Dunmore” (9.1)",
    fact: '',
    text: '',
    expect: false
  },
  {
    kind: 'reveals',
    who: [],
    topic: 'x3 the wrong press · new secret',
    fact: '',
    text: textOf('h05', 7, 'put the linen away in the wrong press'),
    expect: false
  },
  {
    kind: 'reveals',
    who: [],
    topic: "x4 the Captain's lost estate · new secret",
    fact: '',
    text: textOf(
      'h14',
      testBookScene('h14').paragraphs.findIndex((text) => text.includes(H14_RUMOUR)),
      H14_RUMOUR
    ),
    expect: 'notCounted'
  }
]

/** The worst `verify.v2` batch: knows items until the batch's input or output cap. */
function worstV2Batch(): (VerifyV2Item & { expect: boolean })[] {
  const pool = TEST_BOOK_LABELS.knows.map((label) =>
    knowsItem(label, { from: label.from === null ? ['bel', 'lottie'] : [label.from, 'bel'] })
  )
  const many = Array.from({ length: 4 }, () => pool).flat()
  return verifyV2Batches(many)[0] ?? []
}

/** A strong knows spot check: Johanna reads the letter, three sentences either side. */
const strongKnowsItem = (): VerifyV2Item & { expect: boolean } =>
  knowsItem(knowsLabel('johanna', 'secret-engagement', 'h08'), {
    from: ['lottie', 'bel'],
    around: 3
  })

export const MEMORY_V2_EVAL_CASES: readonly EvalCase[] = [
  readerV2Case(
    'h04 tells',
    'h04: Bel tells Clara of the engagement (told, tells); a thread opens in dialogue; nothing is listed yet',
    'h04',
    []
  ),
  readerV2Case(
    'h05 overheard',
    'h05: Lottie tells Bel, and Lise overhears every word behind the door; the secret and the match are listed',
    'h05',
    ['secret-engagement', 'thread-lottie-match']
  ),
  readerV2Case(
    'h08 read',
    'h08: Johanna reads it in a letter (from Lottie); the match advances; Ashby’s return opens',
    'h08',
    ['secret-engagement', 'thread-lottie-match']
  ),
  readerV2Case(
    'h13 group',
    'h13: the whole regiment knows (a group learner), Mrs. Pocock refers to it, Clara knew before; Ashby’s return only remembered',
    'h13',
    ['secret-engagement', 'thread-lottie-match', 'thread-ashby-return']
  ),
  readerV2Case(
    'h14 deduced',
    'h14: a new secret (the debts): deduced, suspects, believes otherwise; the cards rumour and Mr. Harrow at the table never know',
    'h14',
    ['secret-engagement', 'thread-lottie-match', 'thread-ashby-return'],
    { notKnowing: ['harrow-mr'] }
  ),
  readerV2Case(
    'window',
    'a window read (h05 ¶4–6): the topic lines of the engagement, and the knows line anchored there',
    'h05',
    ['secret-engagement', 'thread-lottie-match'],
    {
      window: [4, 5, 6],
      near: [`${shortV2('lottie')} age “not yet sixteen”`],
      topicLines: [
        `s1 Lottie's engagement to Mr. Dunmore: ${shortV2('clara')} told 9.1 (from ${shortV2('bel')}); ${shortV2('bel')} tells 9.1`
      ],
      anchored: [
        `c1 ${shortV2('liesel')} knows s1 overheard from ${shortV2('lottie')} ¶5`,
        `c2 t1 thread opens “Lottie is to marry Mr. Dunmore” ¶2, re-checking`
      ],
      card: `Lise overhears Lottie tell Bel of the engagement. · where Wexley · POV ${shortV2('liesel')}`
    }
  ),
  worstReaderV2Case(),
  verifyV2Case(
    'typical',
    'a knows batch: overheard, read (a letter), a group, believes otherwise, Mr. Harrow who never knows, a resolve, a supposed opening, a presence',
    TYPICAL_V2_BATCH
  ),
  verifyV2Case(
    'reveals and same',
    'reveals and same-as items: “Lottie’s engagement” against “the secret engagement” (same), the debts against it (not), a sentence revealing nothing, a secret only rumoured (h14)',
    REVEALS_SAME_BATCH
  ),
  verifyV2Case(
    'maxed',
    `the worst batch: knows items up to its ${VERIFY_BATCH_TOKENS}-token cap or its output budget`,
    worstV2Batch()
  ),
  verifyV2Case(
    'strong',
    'a strong knows spot check: Johanna reads the letter, three sentences either side, 48 tokens out',
    [strongKnowsItem()],
    true
  )
]
