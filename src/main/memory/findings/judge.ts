import { quickHash } from '@shared/memory/anchor'
import type { CandidateClaim, CandidateInputs } from '@shared/memory/candidates'
import type { Card, ClaimMode, ClaimVoice } from '@shared/memory/claims'
import {
  type Finding,
  type FindingExtra,
  type FindingRendered,
  type FindingRule,
  type FindingSide,
  type FindingVariant,
  type JudgeVerdict
} from '@shared/memory/findings'
import { gateText } from '@shared/memory/gate'
import type { NameIndex } from '@shared/memory/nameScan'
import { noteSentences, type NoteParagraph } from '@shared/memory/noteValues'
import { parseHow } from '@shared/memory/knows'
import { parseStep } from '@shared/memory/topics'
import { parseSlot, slotLabel } from '@shared/memory/slots'
import { elapsedBreaks, hintWords, yearIn } from '@shared/memory/years'
import { quoteContext } from '@shared/scribeAnswer'
import { searchableText } from '@shared/search'
import { cancelInflight } from '../../ai/inflight'
import {
  JUDGE_HINTS_MAX,
  JUDGE_PROMPT_VERSION,
  buildJudgePrompt,
  judgeBatches,
  judgeItem,
  judgeItemKeyText,
  parseJudgeAnswer,
  type JudgeItem,
  type JudgeOrder,
  type JudgePair,
  type JudgeQuestion,
  type JudgeSide
} from '../../ai/prompts/judge.v1'
import { AiCancelledError } from '../../ai/providers/types'
import { runAiRequest, sha256, type AiRequestDeps } from '../../ai/request'
import type { NodeRow } from '../../db/schema'
import type { TreeDb } from '../../tree/treeStore'
import { dismissedKeys } from '../dismissedStore'
import { nameScanShared } from '../nameIndexer'
import { draftCards } from '../reading/cardStore'
import { heldCard, rowTexts } from '../reading/readingFrame'
import {
  candidateInputs,
  findingsFrame,
  type FindingsFrame,
  type StoredInputs
} from './candidateInputs'
import {
  setVerdicts,
  type FindingAsRendered,
  type PairReader,
  type PairVerdicts
} from './findingStore'
import { cacheVerdict, cachedVerdict, verdictKey } from './verdictCache'

/**
 * The contradiction judge's pairs (F-16.27; plan P4 §2.3): a finding (or a candidate) rendered as
 * `judge.v1` reads it, its verdict-cache keys, and the run that sends a batch in both orders, in two
 * separate requests, and stores each pair-order's verdict on its own.
 *
 * - **Pairs** are rendered against the book as it is now: a claim's quote located in its paragraph
 *   (its sentence ±1), a presence's quote from the scene's held card, a note's sentence ±1 within
 *   its paragraph. A side that is gone drops the pair (the next recompute closes the finding).
 * - **Keys** (`verdict_cache`): the prompt version, the tier, the order and the item as sent with
 *   its number and scene places masked and every name folded to its record token (`gateText`), so a
 *   scene move or a Rename in book costs no new verdict, while a changed word, context sentence,
 *   relative order, voice, mode, flashback, story year or time-skip hint does.
 * - **Stamps** (`pairInputs`, P4 slice 2 review): a cheap hash of everything a pair's rendering
 *   reads (its sides, their scenes' text, cards, typed details and places, the scenes between them,
 *   the notes, the names, the Not right list). The recompute renders a pair again only when its
 *   stamp moved (`readPair`), so a book of unjudged findings costs no rendering per change, and a
 *   pair whose words moved around unchanged sides (a time-skip hint, a story year, a context
 *   sentence) has its verdicts cleared and the cache asked for the new words.
 * - **Runs**: pairs answered in both orders by the cache are settled at no cost; the rest go in
 *   batches (`judgeBatches`: ≤ 10 pairs, ≤ 2,500 tokens), the A,B call then the B,A call, each with
 *   only the pairs that order still lacks. A reply cut off is read to its last whole verdict; the
 *   rest stay unjudged for the next run. Each call's cost is shared out to its pairs' findings.
 *   Verdicts land only on a row that still holds the pair as it was rendered (a recompute while the
 *   call was out re-states it; the verdict stays cached under its own words), and a pair whose row
 *   moved is not sent in its second order.
 */

/** A finding or a candidate: what a pair is rendered from. */
export interface FindingCore {
  rule: FindingRule
  variant: FindingVariant | null
  recordId: string
  slot: string
  a: FindingSide
  b: FindingSide
  extra: FindingExtra | null
}

/** What rendering pairs reads, built once per run (`judgeContext`). */
export interface JudgeContext {
  db: TreeDb
  draftId: string
  inputs: CandidateInputs
  claims: ReadonlyMap<string, CandidateClaim>
  rows: ReadonlyMap<string, NodeRow>
  notes: ReadonlyMap<string, NoteParagraph>
  /** The roster's names, folded to record tokens in the cache keys. */
  names: () => NameIndex
  /** The active draft's stored cards in readable scenes (read once, when a side or a hint asks). */
  cards: () => ReadonlyMap<string, Card>
  /** Readable scenes in reading order. */
  scenes: () => readonly string[]
  notRight: () => ReadonlySet<string>
  /** A scene's stamp: its text, its stored card and its typed year (`pairInputs`). */
  sceneStamp: (nodeId: string) => string
  /**
   * The stamp of the scenes after reading-order place `from` up to and including `to` whose stored
   * card has a time skip that can cross a year (what `between` may quote), in constant time.
   */
  betweenStamp: (from: number, to: number) => string
  /** One side's stamp (`pairInputs`), once per side. */
  sideStamp: (side: FindingSide) => string
  /** The Not right list's stamp (a held card's fields leave out what it dismissed). */
  notRightStamp: () => string
}

const noteKey = (ownerKind: string, ownerId: string, para: number): string =>
  `${ownerKind}:${ownerId}:${para}`

function lazy<T>(make: () => T): () => T {
  let value: { v: T } | null = null
  return () => {
    value ??= { v: make() }
    return value.v
  }
}

/**
 * A scene text's hash, once per text: `rowTexts` answers the very same array while a scene's
 * content is unchanged, so an unchanged scene is never hashed again.
 */
const textHashes = new WeakMap<readonly string[], string>()
function textsHash(texts: readonly string[]): string {
  let hash = textHashes.get(texts)
  if (hash === undefined) {
    hash = sha256(texts.join('\n'))
    textHashes.set(texts, hash)
  }
  return hash
}

/** The judge's context over the active draft `draftId` (the rules' inputs when the caller has them). */
export function judgeContext(
  db: TreeDb,
  draftId: string,
  frame: FindingsFrame = findingsFrame(db),
  inputs: CandidateInputs | StoredInputs = candidateInputs(db, draftId, frame)
): JudgeContext {
  const rows = new Map(frame.nodes.map((row) => [row.id, row]))
  // The cards the rules' inputs read already, when they came from `candidateInputs`.
  const cards = lazy((): ReadonlyMap<string, Card> =>
    'cards' in inputs
      ? inputs.cards
      : new Map(
          draftCards(db, draftId)
            .filter((card) => inputs.reading.order.has(card.nodeId))
            .map((card) => [card.nodeId, card])
        )
  )
  const scenes = lazy(() =>
    [...inputs.reading.order.entries()].sort((x, y) => x[1] - y[1]).map(([id]) => id)
  )
  const notRight = lazy(() => dismissedKeys(db, 'notRight'))
  const stamps = new Map<string, string>()
  const sides = new Map<string, string>()
  const ctx: JudgeContext = {
    db,
    draftId,
    inputs,
    claims: new Map(inputs.claims.map((each) => [each.id, each])),
    rows,
    notes: new Map(
      inputs.notes.map((note) => [noteKey(note.ownerKind, note.ownerId, note.para), note])
    ),
    names: lazy(() => nameScanShared(db).index),
    cards,
    scenes,
    notRight,
    sceneStamp: (nodeId) => {
      let stamp = stamps.get(nodeId)
      if (stamp === undefined) {
        const row = rows.get(nodeId)
        const card = cards().get(nodeId)
        // What a held card rests on (`heldCard`): its fields, who is present, its anchor.
        stamp = quickHash(
          [
            row === undefined ? '∅' : textsHash(rowTexts(row)),
            card === undefined ? '∅' : JSON.stringify([card.fields, card.present, card.anchor]),
            String(inputs.typed.get(nodeId)?.year ?? '')
          ].join('\u0000')
        )
        stamps.set(nodeId, stamp)
      }
      return stamp
    },
    betweenStamp: (from, to) => {
      const sums = breakSums()
      const i = firstAfter(sums.at, from)
      const j = firstAfter(sums.at, to)
      if (j <= i) return ''
      const lo = ((sums.lo[j] ?? 0) - (sums.lo[i] ?? 0)) >>> 0
      const hi = ((sums.hi[j] ?? 0) - (sums.hi[i] ?? 0)) >>> 0
      return `${j - i}.${lo}.${hi}`
    },
    sideStamp: (side) => {
      const ref = sideRef(side)
      let stamp = sides.get(ref)
      if (stamp === undefined) {
        stamp = sideInputs(ctx, side)
        sides.set(ref, stamp)
      }
      return stamp
    },
    notRightStamp: lazy(() => sha256([...notRight()].sort().join('\n')))
  }
  /**
   * The year-crossing time skips' places, with prefix sums of a 53-bit hash of each place and its
   * scene's stamp in two 32-bit halves (a range's sums differ when any scene in it changed).
   */
  const breakSums = lazy(() => {
    const at: number[] = []
    const lo: number[] = [0]
    const hi: number[] = [0]
    scenes().forEach((nodeId, place) => {
      const elapsed = cards().get(nodeId)?.fields.elapsed ?? null
      if (elapsed === null || !elapsedBreaks(elapsed.value)) return
      const hash = parseInt(quickHash(`${place}\u0000${ctx.sceneStamp(nodeId)}`), 16)
      at.push(place)
      lo.push(((lo.at(-1) ?? 0) + (hash >>> 0)) >>> 0)
      hi.push(((hi.at(-1) ?? 0) + Math.floor(hash / 4294967296)) >>> 0)
    })
    return { at, lo, hi }
  })
  return ctx
}

/** The index of the first place in `sorted` greater than `place`. */
function firstAfter(sorted: readonly number[], place: number): number {
  let low = 0
  let high = sorted.length
  while (low < high) {
    const mid = (low + high) >>> 1
    if ((sorted[mid] ?? 0) <= place) low = mid + 1
    else high = mid
  }
  return low
}

/** One side as it stands now: where it is, its words and what it says. */
export interface ResolvedSide {
  kind: FindingSide['kind']
  nodeId: string | null
  para: number
  /** A scene's reference ("1.2"), or a note's owner ("Orrin", a Research page's title). */
  ref: string
  /** A book side's "1.2 ¶3"; a note's "Orrin’s Pinned page" or "Research: Harbour notes". */
  place: string
  /** Reading-order position; null for a note. */
  order: number | null
  quote: string
  /** The paragraph (a note's paragraph) the quote stands in. */
  paragraph: string
  /** The quote's sentence ±`around` within its paragraph. */
  context: string
  value: string
  voice: ClaimVoice | null
  mode: ClaimMode | null
  claim: CandidateClaim | null
  open: { kind: 'scene' | 'record' | 'research'; id: string; para: number | null }
}

const possessive = (name: string): string => (/s$/iu.test(name) ? `${name}’` : `${name}’s`)

/** A record's name (a secret's or thread's label too); empty when it is gone. */
export function recordName(ctx: JudgeContext, id: string): string {
  return ctx.inputs.records.get(id)?.name ?? ''
}

/** One side resolved against the book and the notes as they are now; null when it is gone. */
export function resolveSide(ctx: JudgeContext, side: FindingSide, around = 1): ResolvedSide | null {
  const reading = ctx.inputs.reading
  if (side.kind === 'note') {
    const note = ctx.notes.get(noteKey(side.ownerKind, side.ownerId, side.para))
    if (note === undefined) return null
    const sentences = noteSentences(note)
    const at = sentences.findIndex((each) => each.sentence === side.sentence)
    if (at < 0) return null
    const quote = sentences[at]?.text ?? ''
    const context = sentences
      .slice(Math.max(0, at - around), at + around + 1)
      .map((each) => each.text)
      .join(' ')
    const owner =
      side.ownerKind === 'record'
        ? recordName(ctx, side.ownerId)
        : searchableText(ctx.rows.get(side.ownerId)?.title ?? '').trim() || 'Untitled page'
    if (owner === '') return null
    return {
      kind: 'note',
      nodeId: null,
      para: side.para,
      ref: owner,
      place:
        side.ownerKind === 'record' ? `${possessive(owner)} Pinned page` : `Research: ${owner}`,
      order: null,
      quote,
      paragraph: note.text,
      context,
      value: side.value,
      voice: null,
      mode: null,
      claim: null,
      open: { kind: side.ownerKind, id: side.ownerId, para: side.para }
    }
  }
  const row = ctx.rows.get(side.nodeId)
  const order = reading.order.get(side.nodeId)
  if (row === undefined || order === undefined) return null
  const texts = rowTexts(row)
  const ref = reading.refs.get(side.nodeId) ?? ''
  if (side.kind === 'claim') {
    const claim = ctx.claims.get(side.claimId)
    if (claim?.nodeId !== side.nodeId) return null
    const paragraph = texts[claim.para]
    const context = paragraph === undefined ? null : quoteContext([paragraph], claim.quote, around)
    if (paragraph === undefined || context === null) return null
    return {
      kind: 'claim',
      nodeId: claim.nodeId,
      para: claim.para,
      ref,
      place: `${ref} ¶${claim.para}`,
      order,
      quote: claim.quote,
      paragraph,
      context,
      value: claim.value,
      voice: claim.voice,
      mode: claim.mode,
      claim,
      open: { kind: 'scene', id: claim.nodeId, para: claim.para }
    }
  }
  const card = ctx.cards().get(side.nodeId)
  if (card === undefined) return null
  const present = heldCard(ctx.db, card, true, ctx.notRight(), texts).present.find(
    (each) => each.recordId === side.recordId && each.verified
  )
  const paragraph = present === undefined ? undefined : texts[present.p]
  const context =
    present === undefined || paragraph === undefined
      ? null
      : quoteContext([paragraph], present.quote, around)
  if (present === undefined || paragraph === undefined || context === null) return null
  return {
    kind: 'presence',
    nodeId: side.nodeId,
    para: present.p,
    ref,
    place: `${ref} ¶${present.p}`,
    order,
    quote: present.quote,
    paragraph,
    context,
    value: 'here',
    voice: null,
    mode: null,
    claim: null,
    open: { kind: 'scene', id: side.nodeId, para: present.p }
  }
}

/** A finding's slot as a reader names it ("eyes", "family (to Orrin)", "the sold map"). */
export function slotWords(ctx: JudgeContext, slot: string): string {
  if (slot.startsWith('kinship:')) {
    const object = recordName(ctx, slot.slice('kinship:'.length))
    return object === '' ? 'family' : `family (to ${object})`
  }
  if (slot.startsWith('knows:')) return recordName(ctx, slot.slice('knows:'.length))
  const parsed = parseSlot(slot)
  return parsed === null ? slot : slotLabel(parsed).toLowerCase()
}

/** What a side says, by rule, as the item shows it. */
function says(core: FindingCore, side: ResolvedSide, first: boolean): string {
  switch (core.rule) {
    case 'C2':
      return side.kind === 'presence' ? 'here' : side.value
    case 'C3': {
      const how = parseHow(side.claim?.how ?? null)
      if (first) return how === 'refers' ? 'refers to it' : 'passes it on'
      return how === null ? 'learns it' : `learns it (${how})`
    }
    case 'C4':
      return side.claim?.slot === 'born' || side.kind === 'note'
        ? `born ${side.value}`
        : `age ${side.value}`
    case 'C5': {
      const step = parseStep(side.claim?.how ?? null) ?? (first ? 'resolves' : 'advances')
      return `${step}: ${side.value}`
    }
    default:
      return side.value
  }
}

/** The item's question (P4 §2.2), from the finding and its two sides. */
function question(
  ctx: JudgeContext,
  core: FindingCore,
  a: ResolvedSide,
  b: ResolvedSide
): JudgeQuestion | null {
  const name = recordName(ctx, core.recordId)
  if (name === '') return null
  switch (core.rule) {
    case 'C1':
    case 'C7':
      return { rule: core.rule, name, slot: slotWords(ctx, core.slot) }
    case 'C2':
      return core.variant === 'body'
        ? { rule: 'C2', variant: 'body', name, slot: slotWords(ctx, core.slot) }
        : { rule: 'C2', variant: 'dead', name }
    case 'C3': {
      const secret = slotWords(ctx, core.slot)
      return secret === '' ? null : { rule: 'C3', name, secret }
    }
    case 'C4': {
      if (core.variant === 'falls') return { rule: 'C4', variant: 'falls', name }
      const year = core.extra?.year
      if (year === undefined) return null
      return {
        rule: 'C4',
        variant: 'birth',
        name,
        age: a.value,
        born: b.value,
        year: year.value,
        source: year.source
      }
    }
    case 'C5':
      return { rule: 'C5', thread: name }
    case 'C6':
      return { rule: 'C6', name, slot: slotWords(ctx, core.slot) }
  }
}

/** A book scene's story year as typed or stated there (never carried). */
function sceneYear(ctx: JudgeContext, nodeId: string): number | null {
  const typed = ctx.inputs.typed.get(nodeId)?.year ?? null
  if (typed !== null) return typed
  const quoted = ctx.inputs.scene(nodeId).quotedYear
  return quoted === null ? null : yearIn(quoted)
}

/**
 * The time-skip sentences between two book scenes (after the earlier, up to and including the
 * later): each scene's elapsed hint that can cross a year (`elapsedBreaks`) and stands on its text,
 * in the book's words (`hintWords`), at most two, nearest the earlier first.
 */
function between(ctx: JudgeContext, from: number, to: number): string[] {
  if (to <= from) return []
  const hints: string[] = []
  const scenes = ctx.scenes()
  for (let at = from + 1; at <= to && hints.length < JUDGE_HINTS_MAX; at += 1) {
    const nodeId = scenes[at]
    const card = nodeId === undefined ? undefined : ctx.cards().get(nodeId)
    const stored = card?.fields.elapsed ?? null
    if (card === undefined || stored === null || !elapsedBreaks(stored.value)) continue
    const row = ctx.rows.get(card.nodeId)
    if (row === undefined) continue
    const held = heldCard(ctx.db, card, true, ctx.notRight(), rowTexts(row)).fields.elapsed
    if (held === null) continue
    hints.push(hintWords({ value: held.value, quote: held.quote, para: held.p }))
  }
  return hints
}

function judgeSide(
  ctx: JudgeContext,
  core: FindingCore,
  side: ResolvedSide,
  first: boolean
): JudgeSide {
  const book = side.nodeId !== null && side.order !== null
  return {
    place: side.place,
    at: book ? { order: side.order ?? 0, para: side.para } : null,
    says: says(core, side, first),
    voice: side.voice,
    mode: side.mode,
    flashback: side.nodeId === null ? false : ctx.inputs.scene(side.nodeId).flashback,
    year: side.nodeId === null ? null : sceneYear(ctx, side.nodeId),
    quote: side.quote,
    text: side.context
  }
}

/**
 * A finding as `judge.v1` reads it, its sides' contexts at ±`around` sentences (1 for a batch, 3
 * for the stronger check); null when a side is gone or nothing names it.
 */
export function judgePair(ctx: JudgeContext, core: FindingCore, around = 1): JudgePair | null {
  const a = resolveSide(ctx, core.a, around)
  const b = resolveSide(ctx, core.b, around)
  if (a === null || b === null) return null
  const asked = question(ctx, core, a, b)
  if (asked === null) return null
  const hints =
    a.order === null || b.order === null
      ? []
      : between(ctx, Math.min(a.order, b.order), Math.max(a.order, b.order))
  return {
    question: asked,
    a: judgeSide(ctx, core, a, true),
    b: judgeSide(ctx, core, b, false),
    between: hints
  }
}

/** A pair ready to send: its item and its verdict-cache key in each order (fast tier). */
export interface PairItem {
  item: JudgeItem
  keys: Record<JudgeOrder, string>
}

/** The verdict-cache key of `item` in `order` on `tier` (names folded, places masked). */
export function pairKey(
  ctx: JudgeContext,
  item: JudgeItem,
  order: JudgeOrder,
  tier: string
): string {
  return verdictKey({
    promptVersion: JUDGE_PROMPT_VERSION,
    tier,
    order,
    item: gateText(judgeItemKeyText(item, order), ctx.names())
  })
}

export function pairItem(ctx: JudgeContext, core: FindingCore): PairItem | null {
  const pair = judgePair(ctx, core)
  if (pair === null) return null
  const item = judgeItem(pair)
  return {
    item,
    keys: { ab: pairKey(ctx, item, 'ab', 'fast'), ba: pairKey(ctx, item, 'ba', 'fast') }
  }
}

/** A side's reference as one string, whatever key order built it. */
function sideRef(side: FindingSide): string {
  switch (side.kind) {
    case 'claim':
      return ['claim', side.claimId, side.nodeId, side.valueKey, side.seen].join('|')
    case 'presence':
      return ['presence', side.nodeId, side.recordId].join('|')
    case 'note':
      return [
        'note',
        side.ownerKind,
        side.ownerId,
        side.page ?? '',
        side.para,
        side.sentence,
        side.value,
        side.datedNodeId ?? ''
      ].join('|')
  }
}

/**
 * A stamp of everything `judgePair` reads of a finding, cheap to compute (no quote is located, no
 * card held, no name folded): the finding's identity and sides, the record's name and the slot's
 * words, each note side's paragraph and owner, each book side's place in reading order, its scene's
 * stamp (text, stored card, typed year) and its claim as stored, the stamps of the scenes between
 * two book sides that may give a time skip, and the Not right list. It over-reaches on purpose
 * (any edit in a side's scene moves it): a moved stamp only costs a rendering, and the verdicts
 * stay while the rendered keys are the same.
 */
export function pairInputs(ctx: JudgeContext, core: FindingCore): string {
  const year = core.extra?.year
  const parts: string[] = [
    core.rule,
    core.variant ?? '',
    core.recordId,
    core.slot,
    recordName(ctx, core.recordId),
    slotWords(ctx, core.slot),
    year === undefined ? '' : [year.value, year.source, year.nodeId].join('|'),
    ctx.sideStamp(core.a),
    ctx.sideStamp(core.b)
  ]
  const orders = [core.a, core.b].flatMap((side) => {
    const order = side.kind === 'note' ? undefined : ctx.inputs.reading.order.get(side.nodeId)
    return order === undefined ? [] : [order]
  })
  if (orders.length === 2) {
    parts.push(ctx.betweenStamp(Math.min(...orders), Math.max(...orders)))
  }
  if (core.a.kind !== 'note' || core.b.kind !== 'note') parts.push(ctx.notRightStamp())
  // Only ever compared with the last stamp of the same pair: a cheap hash is enough.
  return quickHash(parts.join('\u0000'))
}

/**
 * One side's part of a pair's stamp: its reference; a note's paragraph and owner's name; a book
 * side's place in reading order, its scene's stamp and its claim as stored.
 */
function sideInputs(ctx: JudgeContext, side: FindingSide): string {
  const parts = [sideRef(side)]
  if (side.kind === 'note') {
    const note = ctx.notes.get(noteKey(side.ownerKind, side.ownerId, side.para))
    parts.push(
      note === undefined ? '∅' : JSON.stringify(note),
      side.ownerKind === 'record'
        ? recordName(ctx, side.ownerId)
        : (ctx.rows.get(side.ownerId)?.title ?? '')
    )
  } else {
    const order = ctx.inputs.reading.order.get(side.nodeId)
    parts.push(order === undefined ? '∅' : String(order), ctx.sceneStamp(side.nodeId))
    if (side.kind === 'claim') {
      const claim = ctx.claims.get(side.claimId)
      parts.push(claim === undefined ? '∅' : JSON.stringify(claim))
    }
  }
  return quickHash(parts.join('\u0000'))
}

/**
 * A finding's pair as the judge would read it now, against `stored` (what its verdicts were given
 * for): `stored` itself while its stamp holds, else rendered again (the keys kept from `stored`
 * when a side cannot be rendered now, so a held side's verdicts wait for its re-read).
 */
export function readPair(
  ctx: JudgeContext,
  core: FindingCore,
  stored: FindingRendered | null
): FindingRendered {
  const inputs = pairInputs(ctx, core)
  if (stored?.inputs === inputs) return stored
  const pair = pairItem(ctx, core)
  return { inputs, keys: pair?.keys ?? stored?.keys ?? null }
}

/** Both orders' remembered verdicts under a pair's keys; null when neither order is remembered. */
export function cachedPairVerdicts(
  db: TreeDb,
  keys: PairItem['keys'],
  now: Date
): PairVerdicts | null {
  const ab = cachedVerdict(db, keys.ab, now)
  const ba = cachedVerdict(db, keys.ba, now)
  if (ab === null && ba === null) return null
  return { ab: ab?.verdict ?? null, ba: ba?.verdict ?? null, why: whyOf(ab, ba) }
}

/** The recompute's reader of pairs (`upsertFindings`), over one context. */
export function pairReader(ctx: JudgeContext, now: Date): PairReader {
  return {
    read: (candidate, stored) => readPair(ctx, candidate, stored),
    cached: (keys) => cachedPairVerdicts(ctx.db, keys, now)
  }
}

const whyOf = (
  ab: { verdict: JudgeVerdict; why: string | null } | null,
  ba: { verdict: JudgeVerdict; why: string | null } | null
): string | null => (ab?.verdict === 'c' ? ab.why : null) ?? (ba?.verdict === 'c' ? ba.why : null)

export interface JudgeRunInput {
  /** The findings to judge, in priority order (only unjudged ones are worth sending). */
  findings: readonly Finding[]
  /** Pairs at most that may go to the judge (cache hits are free and not counted). */
  maxPairs: number
  /** The caller's id for `ai:cancel`; each call registers under `<requestId>:j<n>`. */
  requestId: string
  signal?: AbortSignal
  /** Each call's reported cost as it returns. */
  onSpend?: (usd: number) => void
  now: () => Date
}

export interface JudgeRunResult {
  /** A request left. */
  requested: boolean
  /** Pairs sent to the judge in a call that answered (in either order), each counted once. */
  sent: number
  /** Findings whose verdicts were stored (from the cache or the judge). */
  judged: Finding[]
  /** Of those, findings whose state moved (an unjudged pair now open, unclear or fine). */
  settled: Finding[]
  /** Pair-orders sent and not answered (cut off or dropped by the judge). */
  unanswered: number
  /** Unjudged findings left for a later run (past `maxPairs`). */
  left: number
  /** Findings not sent because a side is gone (the next recompute closes them). */
  dropped: number
  /** Pairs whose row a recompute re-stated while their call was out (their verdicts stay cached). */
  moved: number
  costUsd: number
}

/** A run that has done nothing yet; `judgeFindings` fills it as its calls return. */
export function emptyJudgeRun(): JudgeRunResult {
  return {
    requested: false,
    sent: 0,
    judged: [],
    settled: [],
    unanswered: 0,
    left: 0,
    dropped: 0,
    moved: 0,
    costUsd: 0
  }
}

interface Pending {
  finding: Finding
  pair: PairItem
  /** What this run judges: the pair's stamp and keys now. */
  rendered: FindingRendered
  /** The row as this run last saw or wrote it; null once a recompute re-stated it. */
  at: FindingAsRendered | null
  ab: { verdict: JudgeVerdict; why: string | null } | null
  ba: { verdict: JudgeVerdict; why: string | null } | null
}

/** Whether a reply answers every one of the first `sent` items (only such a reply is cached). */
const answersAll = (text: string, sent: number): boolean => {
  const rulings = parseJudgeAnswer(text)
  for (let i = 1; i <= sent; i += 1) if (!rulings.has(i)) return false
  return true
}

/**
 * Judges `findings`: pairs both orders of which the cache remembers are settled at no cost; up to
 * `maxPairs` others go in batches, the A,B call then the B,A call (each with the pairs that order
 * lacks, and none whose row moved meanwhile), every answered pair-order cached, every finding's
 * verdicts, rendering and cost share stored as its calls return (a Stop keeps what was judged).
 * `result` is filled as the run goes, so a caller still holds what was done when it throws:
 * `AiCancelledError` on a Stop, and a provider failure as the request path raised it.
 */
export async function judgeFindings(
  ctx: JudgeContext,
  deps: { ai: AiRequestDeps },
  input: JudgeRunInput,
  result: JudgeRunResult = emptyJudgeRun()
): Promise<JudgeRunResult> {
  const toSend: Pending[] = []
  for (const finding of input.findings) {
    const pair = pairItem(ctx, finding)
    if (pair === null) {
      result.dropped += 1
      continue
    }
    const at = input.now()
    const ab = cachedVerdict(ctx.db, pair.keys.ab, at)
    const ba = cachedVerdict(ctx.db, pair.keys.ba, at)
    const pending: Pending = {
      finding,
      pair,
      rendered: { inputs: pairInputs(ctx, finding), keys: pair.keys },
      at: { a: finding.a, b: finding.b, extra: finding.extra, rendered: finding.rendered },
      ab,
      ba
    }
    if (ab !== null && ba !== null) {
      store(ctx, pending, 0, input.now(), result)
      continue
    }
    if (toSend.length >= input.maxPairs) {
      result.left += 1
      continue
    }
    toSend.push(pending)
  }
  if (toSend.length === 0) return result

  const sentIds = new Set<string>()
  let calls = 0
  let inFlight: string | null = null
  const onAbort = (): void => {
    if (inFlight !== null) cancelInflight(inFlight)
  }
  input.signal?.addEventListener('abort', onAbort, { once: true })
  try {
    for (const batch of judgeBatches(toSend.map((each) => ({ ...each, item: each.pair.item })))) {
      for (const order of ['ab', 'ba'] as const) {
        // The pending entry itself: the A,B call's verdicts and a moved row show on it.
        const lacking = batch
          .map((each) => toSend.find((candidate) => candidate.finding.id === each.finding.id))
          .filter(
            (each): each is Pending =>
              each !== undefined && each.at !== null && each[order] === null
          )
        if (lacking.length === 0) continue
        if (input.signal?.aborted === true) throw new AiCancelledError('Judging was stopped.')
        const prompt = buildJudgePrompt(
          lacking.map((each) => each.pair.item),
          order
        )
        calls += 1
        inFlight = `${input.requestId}:j${calls}`
        const reply = await runAiRequest(deps.ai, {
          feature: 'judge',
          tier: 'fast',
          messages: prompt.messages,
          maxTokens: prompt.maxTokens,
          json: true,
          contextHash: sha256(JSON.stringify(prompt.messages)),
          promptVersion: JUDGE_PROMPT_VERSION,
          requestId: inFlight,
          // A reply that leaves a pair unanswered is not kept: the same call next time asks again.
          cacheIf: (text) => answersAll(text, prompt.sent)
        })
        inFlight = null
        result.requested ||= !reply.cached
        result.costUsd += reply.costUsd
        input.onSpend?.(reply.costUsd)
        const rulings = parseJudgeAnswer(reply.text)
        const sent = lacking.slice(0, prompt.sent)
        for (const each of sent) sentIds.add(each.finding.id)
        result.sent = sentIds.size
        const share = sent.length === 0 ? 0 : reply.costUsd / sent.length
        const now = input.now()
        result.unanswered += lacking.length - prompt.sent
        for (const [i, pending] of sent.entries()) {
          const ruling = rulings.get(i + 1)
          if (ruling === undefined) {
            result.unanswered += 1
            store(ctx, pending, share, now, result)
            continue
          }
          pending[order] = { verdict: ruling.r, why: ruling.w }
          cacheVerdict(
            ctx.db,
            {
              key: pending.pair.keys[order],
              verdict: ruling.r,
              why: ruling.w,
              tier: 'fast',
              promptVersion: JUDGE_PROMPT_VERSION,
              model: reply.model,
              costUsd: share
            },
            now
          )
          store(ctx, pending, share, now, result)
        }
      }
    }
  } finally {
    input.signal?.removeEventListener('abort', onAbort)
  }
  return result
}

/**
 * Stores a pending pair's verdicts as they stand, with this call's cost share and what they were
 * given for, onto its row only while the row still holds the pair as rendered (else the pair is
 * marked moved: nothing more is written or sent for it in this run).
 */
function store(
  ctx: JudgeContext,
  pending: Pending,
  share: number,
  now: Date,
  result: JudgeRunResult
): void {
  if (pending.at === null) return
  const written = setVerdicts(ctx.db, pending.finding.id, {
    ab: pending.ab?.verdict ?? null,
    ba: pending.ba?.verdict ?? null,
    why: whyOf(pending.ab, pending.ba),
    costUsd: share,
    now,
    rendered: pending.rendered,
    expect: pending.at
  })
  if (written === null) {
    pending.at = null
    result.moved += 1
    return
  }
  pending.at = { ...pending.at, rendered: pending.rendered }
  const id = pending.finding.id
  if (pending.ab === null && pending.ba === null) return
  if (!result.judged.some((each) => each.id === id)) result.judged.push(pending.finding)
  if (written.before !== written.after && !result.settled.some((each) => each.id === id)) {
    result.settled.push(pending.finding)
  }
}
