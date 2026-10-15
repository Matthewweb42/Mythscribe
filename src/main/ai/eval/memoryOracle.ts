import { sceneSentences } from '@shared/memory/anchor'
import {
  setsState,
  valueKey,
  type Claim,
  type ClaimMode,
  type ClaimVoice
} from '@shared/memory/claims'
import { normalizeForMatch } from '@shared/critique'
import { checkMemoryInvariants, type InvariantInput } from '@shared/memory/invariants'
import { parseHow, type KnowsHow } from '@shared/memory/knows'
import { normName } from '@shared/memory/names'
import { readSlot, slotIsRead } from '@shared/memory/slots'
import { containsValue } from '@shared/memory/reconcile'
import {
  TOPIC_LABEL_SHORT_WORDS,
  parseStep,
  topicLabel,
  type ThreadStep,
  type TopicKind
} from '@shared/memory/topics'
import type { CompletionRequest } from '../providers/types'
import { fakeChatServer, type ChatServer } from './fakeChatServer'
import { liveProviderError } from './liveProvider'
import type { AiRequestDeps } from '../request'
import { activeDraftId } from '../../draft/draftStore'
import { invariantIndexed } from '../../memory/nameIndexer'
import { invariantAliases } from '../../memory/recordStore'
import { draftClaims, invariantClaims, invariantKnows } from '../../memory/reading/claimStore'
import { runReading, type ReadingItemEvent } from '../../memory/reading/pipeline'
import { STEP_VALUE_MAX_WORDS } from '../prompts/reader.v2'
import {
  requestKind,
  rosterIds,
  sentChecks,
  sentParagraphs,
  topicIds,
  type SentCheck
} from '../../memory/reading/readingFixture'
import { sceneTexts } from '../../memory/reading/claimFixture'
import { invariantTopics } from '../../memory/reading/topicStore'
import { TEST_BOOK, type TestBookScene } from '../../memory/testBook/book'
import { TEST_BOOK_LABELS } from '../../memory/testBook/labels'
import type { TestBookProject } from '../../memory/testBook/project'

/**
 * The oracle over the test book (F-16.17, F-16.22; plan P2a §2.7, P2b §3.2), shared by the
 * offline replays of `memory.eval.ts` (facts) and `knows.eval.ts` (who knows what, threads, time),
 * and by their live runs' scoring: a reader that proposes exactly what the labels say, and an
 * honest checker that answers every item as the labels (and, for an adversarial plant, the plant's
 * own truth) say the text shows it. Test support only: nothing in the app imports it.
 *
 * The reader proposes, for the paragraphs a request sends: every claim label (its rejected ones
 * included), every knows line and thread step, and the secrets and threads they need. A topic
 * not yet on the roster is proposed new (`x1`) with the sentence that reveals it here (its
 * defining quote when the scene holds it, else its first line here); a listed one is named by its
 * roster id, except in the scene of its defining quote, where that reveal is proposed again under
 * another label, as a model reading the scene afresh would, and the checker's Same item merges it.
 * So in either reading order every topic is made once, and a defining reveal read after it merges
 * into it.
 *
 * The checker: a fact by its label's quote, slot and value; a knows line by its label (learner,
 * secret, quote), answering the label's how, source, voice and mode; a step by its label; a reveal
 * when its sentences hold one of the topic's labelled sentences (with that sentence's voice and
 * mode; only a labelled topic, named by its label, or a plant's truth); a Same item when both
 * sides are the same labelled topic (by label, else by sentence);
 * an on-page check when a knows label names that learner in those sentences. Everything else is
 * not supported.
 */

/** What the oracle reads of a request: its messages (a fake server's request is enough). */
export type OracleRequest = Pick<CompletionRequest, 'messages'>

export type ClaimLabel = (typeof TEST_BOOK_LABELS.claims)[number]
export type KnowsLabel = (typeof TEST_BOOK_LABELS.knows)[number]
export type StepLabel = (typeof TEST_BOOK_LABELS.threads)[number]
export type RecordLabel = (typeof TEST_BOOK_LABELS.records)[number]

export const nameOf = new Map(TEST_BOOK_LABELS.records.map((record) => [record.id, record.name]))

/** The labelled secrets and threads (the pipeline makes their records as it reads). */
export const TOPIC_LABELS: readonly (RecordLabel & { kind: TopicKind })[] =
  TEST_BOOK_LABELS.records.flatMap((record) =>
    record.kind === 'secret' || record.kind === 'thread' ? [{ ...record, kind: record.kind }] : []
  )

/** A label's slot as the pipeline stores it (`relation:<record>` is `relation` with an object). */
export const slotOf = (label: { slot: string }): string =>
  label.slot.startsWith('relation:') ? 'relation' : label.slot

/** Whether two quotes overlap once normalised (one holds the other). */
export function overlaps(a: string, b: string): boolean {
  const x = normalizeForMatch(a)
  const y = normalizeForMatch(b)
  return x.includes(y) || y.includes(x)
}

/**
 * Whether the reader still reads a claim label's slot (plan `ReaderNarrow.md`, 2026-10-14: traits,
 * history, relations, roles, clothing and objects are refused as `notRead`, whatever is proposed).
 */
export function labelRead(claim: { slot: string }): boolean {
  const slot = readSlot(slotOf(claim))
  return slot !== null && slotIsRead(slot)
}

/**
 * The labelled contradictions the memory can still find: none of whose sides is a claim label in a
 * slot no longer read (plan `ReaderNarrow.md`: the Captain's two fathers are histories, so C7's
 * planted pair is Ms Scribe's to find in the text now, never a stored pair).
 */
export const FINDABLE_CONTRADICTIONS: typeof TEST_BOOK_LABELS.contradictions =
  TEST_BOOK_LABELS.contradictions.filter((finding) =>
    [finding.a, finding.b].every(
      (side) =>
        side === undefined ||
        !TEST_BOOK_LABELS.claims.some(
          (claim) =>
            claim.scene === side.scene &&
            claim.record === finding.record &&
            overlaps(claim.quote, side.quote) &&
            !labelRead(claim)
        )
    )
  )

/** Whether a checker item's text holds a labelled quote (its first 40 characters, normalised). */
const textHolds = (text: string, quote: string): boolean =>
  normalizeForMatch(text).includes(normalizeForMatch(quote).slice(0, 40))

/** The reading order of the test book's readable scenes (scene id → index). */
export const BOOK_ORDER = new Map(
  TEST_BOOK.filter((scene) => scene.source === 'scene').map((scene, i) => [scene.id, i])
)

/** A label as the reader would propose it, ids the request's roster ids. */
export function proposal(
  label: ClaimLabel,
  ids: ReadonlyMap<string, string>
): Record<string, unknown> {
  const relation = label.slot.startsWith('relation:')
  return {
    p: label.p,
    r: ids.get(nameOf.get(label.record) ?? '') ?? null,
    s: relation ? 'relation' : label.slot,
    v: label.value,
    q: label.quote,
    voice: label.voice,
    sp: label.speaker === undefined ? null : (ids.get(nameOf.get(label.speaker) ?? '') ?? null),
    mode: label.mode,
    o: relation
      ? (ids.get(nameOf.get(label.slot.slice('relation:'.length)) ?? '') ?? null)
      : label.object === undefined
        ? null
        : (ids.get(nameOf.get(label.object) ?? '') ?? null),
    chg: label.change ?? false
  }
}

/** Whether a labelled quote stands in the paragraph a request sent under its number. */
function sentHolds(sent: ReadonlyMap<number, string>, p: number, quote: string): boolean {
  const text = sent.get(p)
  return text !== undefined && normalizeForMatch(text).includes(normalizeForMatch(quote))
}

/** The claim labels whose quote the request sent, in the paragraph they name. */
export function sentLabels(request: OracleRequest): ClaimLabel[] {
  const sent = sentParagraphs(request)
  return TEST_BOOK_LABELS.claims.filter((label) => sentHolds(sent, label.p, label.quote))
}

/** The test-book scene a reader request reads (every paragraph it sent stands there). */
export function requestScene(request: OracleRequest): TestBookScene | null {
  const sent = [...sentParagraphs(request)]
  if (sent.length === 0) return null
  return (
    TEST_BOOK.find(
      (scene) =>
        scene.source === 'scene' &&
        sent.every(
          ([p, text]) => normalizeForMatch(scene.paragraphs[p] ?? '') === normalizeForMatch(text)
        )
    ) ?? null
  )
}

export const wantsCard = (request: OracleRequest): boolean =>
  request.messages.at(-1)?.content.endsWith('Card: yes') === true

/**
 * The oracle's card: a fixed line and gist, the scene's labelled elapsed hint and quoted year
 * when their paragraphs were sent (decision 5 reads them back from the held card), and on the
 * page every character a knows label there has learning or holding a secret (the test book puts
 * each learner on the page or in the point of view, P2b-D8), at that line's sentence; P4 adds
 * the labelled presence lines and the flashback sentence.
 */
export function oracleCard(request: OracleRequest): Record<string, unknown> {
  const sent = sentParagraphs(request)
  const ids = rosterIds(request)
  const present: [string, number, string][] = []
  for (const line of sentKnows(request)) {
    const record = TEST_BOOK_LABELS.records.find((each) => each.id === line.learner)
    const id = ids.get(record?.name ?? '')
    if (record?.kind !== 'character' || id === undefined) continue
    if (!present.some(([other]) => other === id)) present.push([id, line.p, line.quote])
  }
  const scene = requestScene(request)
  // P4: who else the labels put on the page (Hobb at the gate), at their sentence.
  for (const line of TEST_BOOK_LABELS.presence) {
    const id = ids.get(nameOf.get(line.record) ?? '')
    if (line.scene !== scene?.id || id === undefined || !sentHolds(sent, line.p, line.quote))
      continue
    if (!present.some(([other]) => other === id)) present.push([id, line.p, line.quote])
  }
  const year = TEST_BOOK_LABELS.years.find((each) => each.scene === scene?.id)
  const elapsed =
    year?.elapsed !== undefined && sentHolds(sent, year.elapsed.p, year.elapsed.quote)
      ? [year.elapsed.quote, year.elapsed.p, year.elapsed.quote]
      : null
  const quoted =
    year?.quotedYear !== undefined && sentHolds(sent, year.quotedYear.p, year.quotedYear.quote)
      ? [year.quotedYear.value, year.quotedYear.p, year.quotedYear.quote]
      : null
  const flash =
    year?.flashbackQuote !== undefined &&
    sentHolds(sent, year.flashbackQuote.p, year.flashbackQuote.quote)
      ? ['yes', year.flashbackQuote.p, year.flashbackQuote.quote]
      : null
  return {
    line: 'A scene of the test book.',
    gist: 'A scene of the test book, read by the oracle.',
    where: null,
    when: null,
    year: quoted,
    elapsed,
    pov: null,
    flash,
    present,
    mood: null,
    theme: null
  }
}

/** The knows labels whose quote the request sent, in the paragraph they name. */
export function sentKnows(request: OracleRequest): KnowsLabel[] {
  const sent = sentParagraphs(request)
  return TEST_BOOK_LABELS.knows.filter((label) => sentHolds(sent, label.p, label.quote))
}

/** The thread step labels whose quote the request sent, in the paragraph they name. */
export function sentSteps(request: OracleRequest): StepLabel[] {
  const sent = sentParagraphs(request)
  return TEST_BOOK_LABELS.threads.filter((label) => sentHolds(sent, label.p, label.quote))
}

/** Every sentence a labelled topic stands on: its defining quote, its knows lines and steps. */
export function topicQuotes(
  topicId: string
): { quote: string; voice: ClaimVoice; mode: ClaimMode }[] {
  const topic = TOPIC_LABELS.find((each) => each.id === topicId)
  const knows = TEST_BOOK_LABELS.knows
    .filter((label) => label.secret === topicId)
    .map((label) => ({
      quote: label.quote,
      voice: label.voice ?? 'narration',
      mode: 'now' as const
    }))
  const steps = TEST_BOOK_LABELS.threads
    .filter((label) => label.thread === topicId)
    .map((label) => ({
      quote: label.quote,
      voice: label.voice ?? 'narration',
      mode: label.mode ?? 'now'
    }))
  const lines = [...knows, ...steps]
  const defining = topic?.defining
  if (defining === undefined) return lines
  // The defining sentence reads as the line labelled on it, else as narration now.
  const same = lines.find((line) => overlaps(line.quote, defining.quote))
  return [
    { quote: defining.quote, voice: same?.voice ?? 'narration', mode: same?.mode ?? 'now' },
    ...lines
  ]
}

/**
 * The labelled topic a label text names (a name or an alias, as cut for the roster, with a
 * " (secret)" / " (thread)" a clash added); null for none.
 */
export function topicByLabel(text: string, kind?: TopicKind): string | null {
  const bare = normName(text.replace(/\s*\((?:secret|thread)[^)]*\)\s*$/u, ''))
  if (bare === '') return null
  const found = TOPIC_LABELS.find(
    (topic) =>
      (kind === undefined || topic.kind === kind) &&
      [topic.name, ...topic.aliases.map((alias) => alias.text)].some(
        (name) =>
          normName(topicLabel(name)) === bare ||
          normName(topicLabel(name, TOPIC_LABEL_SHORT_WORDS)) === bare
      )
  )
  return found?.id ?? null
}

/** The labelled topics a sentence stands for (it holds one of their sentences, or is held by one). */
export function topicsByQuote(text: string, kind?: TopicKind): string[] {
  if (text.trim() === '') return []
  return TOPIC_LABELS.filter(
    (topic) =>
      (kind === undefined || topic.kind === kind) &&
      topicQuotes(topic.id).some((line) => overlaps(line.quote, text))
  ).map((topic) => topic.id)
}

/** A side of a checker item's topic (`s1 the label: “its sentence” (1.2)`), as labelled topics. */
function topicsOfSide(side: string, kind?: TopicKind): string[] {
  const match = /^(?:new |[stx]\d+ )?(.*?)(?:: “(.*)”)?(?: \([^)]*\))?$/u.exec(side.trim())
  const label = match?.[1] ?? ''
  const quote = match?.[2] ?? ''
  const byLabel = topicByLabel(label, kind)
  return byLabel !== null ? [byLabel] : topicsByQuote(quote, kind)
}

/** An adversarial plant's honest answer: what the text shows that no label lists. */
export interface OracleTruth {
  /** A knows line the sentences show (the checker supports it with this voice and mode). */
  knows: readonly {
    learner: string
    secret: string
    quote: string
    how: KnowsHow
    from: string | null
    voice: ClaimVoice
    mode: ClaimMode
  }[]
  /** A topic the sentences reveal (by its planted label), with the voice and mode they give it. */
  reveals: readonly { label: string; quote: string; voice: ClaimVoice; mode: ClaimMode }[]
  /** A learner the sentences show on the page. */
  onPage: readonly { learner: string; quote: string }[]
}

const NO_TRUTH: OracleTruth = { knows: [], reveals: [], onPage: [] }

/** The short id of a named record among a check's candidates (`who` or `From`). */
function idAmong(
  names: readonly string[],
  ids: readonly string[],
  recordLabel: string
): string | null {
  const at = names.indexOf(nameOf.get(recordLabel) ?? '')
  return at === -1 ? null : (ids[at] ?? null)
}

/** A fact item by its label (P2a): quote, slot and value; a reject label only as nobody's. */
function factVerdict(check: SentCheck): Record<string, unknown> {
  const fact = /^(\S+): (.*?)(?: \(of [rn]\d+\))? \([a-z]+(?: by [rn]\d+)?, [a-z]+\)$/.exec(
    check.fact
  )
  const slot = fact?.[1] ?? ''
  const value = fact?.[2] ?? ''
  const label = TEST_BOOK_LABELS.claims.find(
    (candidate) =>
      slotOf(candidate) === slot &&
      textHolds(check.text, candidate.quote) &&
      (containsValue(valueKey(candidate.value), valueKey(value)) ||
        containsValue(valueKey(value), valueKey(candidate.value)))
  )
  if (label === undefined) return { i: check.i, ok: false }
  if (label.expect === 'reject') {
    // A pronoun more than one person fits: supported, but nobody in particular.
    return check.who.length > 1
      ? { i: check.i, ok: true, r: null, voice: label.voice, mode: label.mode }
      : { i: check.i, ok: false }
  }
  return {
    i: check.i,
    ok: true,
    r: idAmong(check.names, check.who, label.record),
    voice: label.voice,
    mode: label.mode
  }
}

/** A knows item by its label (learner, secret, sentence), else by a plant's truth. */
function knowsVerdict(check: SentCheck, truth: OracleTruth): Record<string, unknown> {
  const secrets = topicsOfSide(check.topic, 'secret')
  const fits = (each: { secret: string; learner: string; quote: string }): boolean =>
    secrets.includes(each.secret) &&
    check.names.includes(nameOf.get(each.learner) ?? '') &&
    textHolds(check.text, each.quote)
  // The text runs from the antecedent's sentence to one after the quote, so it may hold another
  // learner's line too: the label with the fact's own how first.
  const asked = parseHow(/^knows, (\w+)/.exec(check.fact)?.[1])
  const labels = TEST_BOOK_LABELS.knows.filter(fits)
  const label = labels.find((each) => each.how === asked) ?? labels[0]
  const line =
    label !== undefined
      ? { ...label, voice: label.voice ?? 'narration', mode: 'now' as ClaimMode }
      : truth.knows.find(fits)
  if (line === undefined) return { i: check.i, ok: false }
  return {
    i: check.i,
    ok: true,
    r: idAmong(check.names, check.who, line.learner),
    voice: line.voice,
    mode: line.mode,
    how: line.how,
    fr: line.from === null ? null : idAmong(check.fromNames, check.from, line.from)
  }
}

/** A step item by its label (thread and sentence). */
function stepVerdict(check: SentCheck): Record<string, unknown> {
  const threads = topicsOfSide(check.topic, 'thread')
  const asked = parseStep(/^(\w+):/.exec(check.fact)?.[1])
  const labels = TEST_BOOK_LABELS.threads.filter(
    (each) => threads.includes(each.thread) && textHolds(check.text, each.quote)
  )
  const label = labels.find((each) => each.how === asked) ?? labels[0]
  if (label === undefined) return { i: check.i, ok: false }
  return {
    i: check.i,
    ok: true,
    r: null,
    voice: label.voice ?? 'narration',
    mode: label.mode ?? 'now',
    how: label.how satisfies ThreadStep
  }
}

/**
 * A Reveals item: a labelled topic (by its label) whose sentences hold one of its labelled
 * sentences, or a plant's truth; a label the book does not have reveals nothing.
 */
function revealsVerdict(check: SentCheck, truth: OracleTruth): Record<string, unknown> {
  const head = /^\S+ (.+) · (?:new )?(secret|thread)$/u.exec(check.topic)
  const label = head?.[1] ?? ''
  const kind = head?.[2] === 'thread' ? 'thread' : 'secret'
  const planted = truth.reveals.find(
    (each) => normName(each.label) === normName(label) && textHolds(check.text, each.quote)
  )
  if (planted !== undefined) {
    return { i: check.i, ok: true, r: null, voice: planted.voice, mode: planted.mode }
  }
  const topic = topicByLabel(label, kind)
  const line =
    topic === null
      ? undefined
      : topicQuotes(topic).find((each) => textHolds(check.text, each.quote))
  return line === undefined
    ? { i: check.i, ok: false }
    : { i: check.i, ok: true, r: null, voice: line.voice, mode: line.mode }
}

/** A Same item: both sides are the same labelled topic (by label, else by sentence). */
function sameVerdict(check: SentCheck): Record<string, unknown> {
  const [fresh = '', listed = ''] = check.topic.split(' | ')
  const left = topicsOfSide(fresh)
  const right = topicsOfSide(listed)
  return { i: check.i, ok: left.some((id) => right.includes(id)), r: null }
}

/** An on-page check: a knows label (or a plant's truth) puts that learner in these sentences. */
function presentVerdict(check: SentCheck, truth: OracleTruth): Record<string, unknown> {
  const name = check.names[0] ?? ''
  const shown =
    TEST_BOOK_LABELS.knows.some(
      (label) => nameOf.get(label.learner) === name && textHolds(check.text, label.quote)
    ) ||
    truth.onPage.some(
      (each) => nameOf.get(each.learner) === name && textHolds(check.text, each.quote)
    ) ||
    TEST_BOOK_LABELS.presence.some(
      (label) => nameOf.get(label.record) === name && textHolds(check.text, label.quote)
    )
  return shown ? { i: check.i, ok: true, r: check.who[0] ?? null } : { i: check.i, ok: false }
}

/**
 * A card item: a flashback the labels mark by its sentence (P4, h16) is confirmed; every other
 * card field (POV, year, not a flashback) is not, as before.
 */
function cardVerdict(check: SentCheck): Record<string, unknown> {
  const flashback =
    check.fact.startsWith('this passage is a flashback') &&
    TEST_BOOK_LABELS.years.some(
      (year) =>
        year.flashbackQuote !== undefined && textHolds(check.text, year.flashbackQuote.quote)
    )
  return flashback ? { i: check.i, ok: true, r: null } : { i: check.i, ok: false }
}

/** The honest checker: each item as the labels (and `truth`) say the text shows it. */
export function oracleVerify(request: OracleRequest, truth: OracleTruth = NO_TRUTH): string {
  const verdicts = sentChecks(request).map((check) => {
    switch (check.kind) {
      case 'claim':
        return factVerdict(check)
      case 'knows':
        return knowsVerdict(check, truth)
      case 'step':
        return stepVerdict(check)
      case 'reveals':
        return revealsVerdict(check, truth)
      case 'same':
        return sameVerdict(check)
      case 'present':
        return presentVerdict(check, truth)
      case 'card':
        return cardVerdict(check)
    }
  })
  return JSON.stringify({ v: verdicts })
}

/** A thread step's value as the reader gives it: its sentence, cut to the step's word cap. */
const stepValue = (quote: string): string =>
  quote.split(/\s+/).slice(0, STEP_VALUE_MAX_WORDS).join(' ')

/** The oracle reader's answer as parts, so an adversarial reader can add to it. */
export interface OracleAnswer {
  c: Record<string, unknown>[]
  n: Record<string, unknown>[]
  card: Record<string, unknown> | null
  /** The id each labelled topic goes by in this answer (a roster id or a new `x` id). */
  topicRef: Map<string, string>
}

/** The oracle reader: the labels' facts, knows lines, steps and topics for the paragraphs sent. */
export function oracleAnswer(request: OracleRequest): OracleAnswer {
  const sent = sentParagraphs(request)
  const ids = rosterIds(request)
  const listed = topicIds(request)
  const idOf = (recordLabel: string): string | null =>
    ids.get(nameOf.get(recordLabel) ?? '') ?? null
  const listedOf = (topicId: string): string | null => {
    for (const [label, short] of listed) if (topicByLabel(label) === topicId) return short
    return null
  }
  const knows = sentKnows(request)
  const steps = sentSteps(request)
  // The topics this request touches: by a line here, or by its defining sentence standing here.
  const touched = TOPIC_LABELS.filter(
    (topic) =>
      knows.some((line) => line.secret === topic.id) ||
      steps.some((step) => step.thread === topic.id) ||
      (topic.defining !== undefined && sentHolds(sent, topic.defining.p, topic.defining.quote))
  )
  const n: Record<string, unknown>[] = []
  const topicRef = new Map<string, string>()
  for (const topic of touched) {
    const short = listedOf(topic.id)
    const defining = topic.defining
    const definingHere = defining !== undefined && sentHolds(sent, defining.p, defining.quote)
    if (short !== null && !definingHere) {
      topicRef.set(topic.id, short)
      continue
    }
    const id = `x${n.length + 1}`
    topicRef.set(topic.id, id)
    // Its reveal here: the defining sentence, else its first line here.
    const first = [
      ...knows.filter((line) => line.secret === topic.id),
      ...steps.filter((step) => step.thread === topic.id)
    ].sort((a, b) => a.p - b.p)[0]
    const reveal = definingHere ? defining : first
    if (reveal === undefined) continue
    n.push({
      // A listed one read afresh goes by another of its names (the Same item merges it).
      n: topicLabel(short === null ? topic.name : (topic.aliases[0]?.text ?? topic.name)),
      kind: topic.kind,
      id,
      p: reveal.p,
      q: reveal.quote
    })
  }
  const c = [
    ...sentLabels(request).map((label) => proposal(label, ids)),
    ...knows.map((line) => ({
      p: line.p,
      r: idOf(line.learner),
      s: 'knows',
      o: topicRef.get(line.secret) ?? null,
      how: line.how,
      fr: line.from === null ? null : idOf(line.from),
      v: line.how,
      q: line.quote,
      voice: line.voice ?? 'narration',
      sp: line.speaker === undefined ? null : idOf(line.speaker),
      mode: 'now'
    })),
    ...steps.map((step) => ({
      p: step.p,
      r: topicRef.get(step.thread) ?? null,
      s: 'thread',
      how: step.how,
      v: stepValue(step.quote),
      q: step.quote,
      voice: step.voice ?? 'narration',
      sp: null,
      mode: step.mode ?? 'now'
    }))
  ]
  return { c, n, card: wantsCard(request) ? oracleCard(request) : null, topicRef }
}

/** An answer as the reader's JSON. */
export const answerText = (answer: Pick<OracleAnswer, 'c' | 'n' | 'card'>): string =>
  JSON.stringify({
    c: answer.c,
    n: answer.n,
    same: [],
    drop: [],
    ...(answer.card === null ? {} : { card: answer.card })
  })

/** The oracle reader's reply. */
export const oracleRead = (request: OracleRequest): string => answerText(oracleAnswer(request))

/**
 * The oracle behind a fake OpenAI-compatible server (`fakeChatServer`), so a live run's whole path
 * (`liveProviderFromEnv`, the SDK, the request path) is exercised offline, nothing spent.
 */
export function oracleChatServer(truth?: OracleTruth): ChatServer {
  return fakeChatServer((messages) => ({
    text:
      requestKind({ messages }) === 'verify'
        ? oracleVerify({ messages }, truth)
        : oracleRead({ messages })
  }))
}

/** The order a replay reads the book in. */
export type ReadOrder = 'book' | 'reverse'

/** The outcome a live run records for the scene a provider error stopped it on. */
export const PROVIDER_ERROR = 'error: '

/**
 * Reads every readable scene of the book in `order` (and the never-read ones, which the pipeline
 * refuses; the inactive draft's h10 is h09's node: read once). A live run passes
 * `providerErrors: 'stop'`: a provider error (a 429, a 402, a 5xx) is recorded as that scene's
 * outcome (`error: <code>: <copy>`) and reading stops, so the run still reports what it read and
 * what it cost; the replays let it throw (no provider error is expected offline).
 */
export async function readBook(
  book: TestBookProject,
  ai: AiRequestDeps,
  options: {
    order?: ReadOrder
    observe?: (event: ReadingItemEvent, sceneId: string) => void
    stopAt?: () => boolean
    providerErrors?: 'throw' | 'stop'
  } = {}
): Promise<Map<string, string>> {
  const outcomes = new Map<string, string>()
  const scenes = TEST_BOOK.filter((scene) => scene.source !== 'inactiveDraft')
  if (options.order === 'reverse') scenes.reverse()
  for (const scene of scenes) {
    if (options.stopAt?.() === true) break
    const nodeId = book.scenes.get(scene.id) ?? ''
    const observe = options.observe
    try {
      const outcome = await runReading(
        book.db,
        { ai },
        {
          nodeId,
          caretPara: null,
          requestId: `eval-${scene.id}`,
          ...(observe === undefined
            ? {}
            : { observe: (event: ReadingItemEvent) => observe(event, scene.id) })
        }
      )
      outcomes.set(scene.id, outcome.read ? 'read' : outcome.reason)
    } catch (err) {
      const said = options.providerErrors === 'stop' ? liveProviderError(err) : null
      if (said === null) throw err
      outcomes.set(scene.id, `${PROVIDER_ERROR}${said}`)
      break
    }
  }
  return outcomes
}

/**
 * The provider error that stopped a live reading, as the report says it ("h07: RATE_LIMIT: …
 * after 6 scenes read"), or null when none did.
 */
export function readingStop(outcomes: ReadonlyMap<string, string>): string | null {
  const stop = [...outcomes].find(([, outcome]) => outcome.startsWith(PROVIDER_ERROR))
  if (stop === undefined) return null
  const read = [...outcomes.values()].filter((outcome) => outcome === 'read').length
  return `${stop[0]}: ${stop[1].slice(PROVIDER_ERROR.length)} after ${read} scenes read`
}

export const liveClaims = (book: TestBookProject): Claim[] =>
  draftClaims(book.db, activeDraftId(book.db)).filter((claim) => claim.state === 'live')

/** P2a's facts: every live claim but the knows lines and thread steps (P2b's, scored apart). */
export const liveFacts = (book: TestBookProject): Claim[] =>
  liveClaims(book).filter((claim) => claim.slot !== 'knows' && claim.slot !== 'thread')

/** The test-book scene a node is (h09's node is h09, not its earlier draft h10). */
export const sceneOf = (book: TestBookProject, nodeId: string): string =>
  [...book.scenes].find(([id, node]) => node === nodeId && id !== 'h10')?.[0] ?? ''

/** The stored claim a label names (by scene, record, slot and quote), when there is one. */
export function storedFor(
  book: TestBookProject,
  claims: readonly Claim[],
  wanted: ClaimLabel
): Claim | undefined {
  const recordId = book.records.get(wanted.record)
  return claims.find(
    (claim) =>
      sceneOf(book, claim.nodeId) === wanted.scene &&
      claim.recordId === recordId &&
      claim.slot === slotOf(wanted) &&
      overlaps(claim.quote, wanted.quote)
  )
}

/**
 * The memory invariants over the whole project (P2b's knows, topics and name index included),
 * (P3) the citations of Ms Scribe's answers, so one citing a card is caught, and (P4) the
 * findings with the *Not a problem* keys.
 */
export function invariants(
  book: TestBookProject,
  citations: InvariantInput['citations'] = [],
  findings: Pick<InvariantInput, 'findings' | 'dismissedFindings'> = {}
): ReturnType<typeof checkMemoryInvariants> {
  const scenes = new Map(
    [...new Set(book.scenes.values())].map((node) => [
      node,
      new Set(sceneSentences(sceneTexts(book.db, node)).map((sentence) => sentence.hash))
    ])
  )
  return checkMemoryInvariants({
    claims: invariantClaims(book.db),
    sceneHashes: scenes,
    aliases: invariantAliases(book.db),
    citations,
    knows: invariantKnows(book.db),
    topics: invariantTopics(book.db),
    indexed: invariantIndexed(book.db),
    ...findings
  })
}

/**
 * Nothing from the scenes that are never read: the Idea scene, the cut scene, the inactive draft.
 * A claim in the active draft counts as the inactive draft's only when its quote stands in h10's
 * text and nowhere in a readable scene's: h09 and h10 share sentences ("Lise came back to
 * Thornmere"), so the live run of 2026-10-14 counted two of h09's own facts as strays.
 */
export function neverRead(book: TestBookProject): Claim[] {
  const idea = book.scenes.get('h11')
  const cut = book.scenes.get('h12')
  const earlier = TEST_BOOK.find((scene) => scene.id === 'h10')?.paragraphs ?? []
  const readable = TEST_BOOK.filter((scene) => scene.source === 'scene').flatMap(
    (scene) => scene.paragraphs
  )
  const standsIn = (paragraphs: readonly string[], quote: string): boolean =>
    paragraphs.some((paragraph) => normalizeForMatch(paragraph).includes(normalizeForMatch(quote)))
  const all = [
    ...draftClaims(book.db, activeDraftId(book.db)),
    ...draftClaims(book.db, book.inactiveDraftId)
  ]
  return all.filter(
    (claim) =>
      claim.nodeId === idea ||
      claim.nodeId === cut ||
      claim.draftId === book.inactiveDraftId ||
      (standsIn(earlier, claim.quote) && !standsIn(readable, claim.quote))
  )
}

/**
 * Negatives stored live: a claim or a state the labels say must not come out of a scene. A claim
 * the labels expect proved (the Captain's slate-grey eyes beside the negated blue) is no negative.
 */
export function negativesStored(book: TestBookProject, claims: readonly Claim[]): string[] {
  const proved = TEST_BOOK_LABELS.claims.filter((label) => label.expect !== 'reject')
  const labelled = (claim: Claim): boolean =>
    proved.some(
      (label) =>
        label.scene === sceneOf(book, claim.nodeId) &&
        book.records.get(label.record) === claim.recordId &&
        slotOf(label) === claim.slot &&
        overlaps(label.quote, claim.quote)
    )
  return TEST_BOOK_LABELS.negatives.flatMap((negative) => {
    if (negative.kind !== 'claim' && negative.kind !== 'state') return []
    if (negative.record === undefined) return []
    const recordId = book.records.get(negative.record)
    const hits = claims.filter(
      (claim) =>
        sceneOf(book, claim.nodeId) === negative.scene &&
        claim.recordId === recordId &&
        (negative.slot === undefined || claim.slot === negative.slot) &&
        (negative.kind === 'claim' || setsState(claim)) &&
        !labelled(claim)
    )
    return hits.map(
      (claim) => `${negative.scene} ${negative.record} ${claim.slot} “${claim.value}”`
    )
  })
}
