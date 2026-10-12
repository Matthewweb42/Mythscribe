import type { ReadingOrder } from './asOf'
import type { ClaimMode, ClaimState, ClaimVoice, TopicQuoteRole, TopicQuoteState } from './claims'
import { knowsLine, parseHow, type KnowsHow } from './knows'
import type { RecordOrigin } from './records'
import type {
  KnowsCellView,
  KnowsGrid,
  SceneRefView,
  SceneSecrets,
  SceneSecretView,
  SecretView,
  SinceView,
  TensionLine,
  TopicQuoteView
} from './views'

/**
 * Who knows what, computed in code (F-16.22; design §2.5): over the knows claims, the secrets'
 * reveals (`topic_quote`), the author's *Knew before the book* rows, the reading order and the
 * scenes' P2b-D9 flags. Pure: the views of slice 4 and P3's navigator call it.
 *
 * Absence is never a fact (P2b rule 9): nothing here says "doesn't know". A knower with no line is
 * simply not a cell; where a view needs to say so, it says "No scene shows … (checked up to …)"
 * with `checkedUpTo`, composed in the renderer alone.
 */

/** A knows claim as the rules read it (slot `knows`). */
export interface KnowsClaim {
  id: string
  /** The knower. */
  recordId: string | null
  /** The secret. */
  objectId: string | null
  how: string | null
  fromId: string | null
  voice: ClaimVoice
  speakerId: string | null
  mode: ClaimMode
  nodeId: string
  para: number
  state: ClaimState
  created: string
}

/** A reveal of a secret or thread (`topic_quote`). */
export interface TopicQuoteInput {
  id: string
  recordId: string
  nodeId: string
  para: number
  role: TopicQuoteRole
  label: string
  quote: string
  state: TopicQuoteState
}

/** A secret record. */
export interface SecretInput {
  recordId: string
  label: string
  origin: RecordOrigin
}

/** The author's *Knew before the book*. */
export interface KnewBeforeInput {
  secretId: string
  recordId: string
}

/** A scene's P2b-D9 flags (`scene_read`). */
export interface SceneFlags {
  topicsRead: boolean
  settled: boolean
}

const refOf = (reading: ReadingOrder, nodeId: string): SceneRefView => ({
  nodeId,
  ref: reading.refs.get(nodeId) ?? ''
})

/**
 * "Checked up to" (P2b-D9): the last scene of the longest run of readable scenes, from the start
 * of the book in reading order up to `atId` (null: the end of the book; an Idea scene: the
 * readable scene before it), that a reader of knows and threads read whole with nothing finished
 * left unread (`topicsRead` and `settled`). A readable scene with no words yet (`empty`, from the
 * caller's word counts) has nothing to read, so it is checked as it stands (no reading ever writes
 * its flags). Null when the first scene is not ("not checked yet").
 */
export function checkedUpTo(
  reading: ReadingOrder,
  flags: ReadonlyMap<string, SceneFlags>,
  atId: string | null,
  empty: ReadonlySet<string> = new Set()
): SceneRefView | null {
  const at = atId === null ? Infinity : (reading.at.get(atId) ?? -1)
  const scenes = [...reading.order].sort((a, b) => a[1] - b[1])
  let last: SceneRefView | null = null
  for (const [nodeId, order] of scenes) {
    if (order > at) break
    const flag = flags.get(nodeId)
    const checked = flag === undefined ? empty.has(nodeId) : flag.topicsRead && flag.settled
    if (!checked) break
    last = refOf(reading, nodeId)
  }
  return last
}

interface Placed<T> {
  item: T
  order: number
}

/** Items in a readable scene, in reading order (scene, paragraph, then as given). */
function placed<T extends { nodeId: string; para: number }>(
  items: readonly T[],
  reading: ReadingOrder
): Placed<T>[] {
  return items
    .flatMap((item, index) => {
      const order = reading.order.get(item.nodeId)
      return order === undefined ? [] : [{ item, order, index }]
    })
    .sort((a, b) => a.order - b.order || a.item.para - b.item.para || a.index - b.index)
    .map(({ item, order }) => ({ item, order }))
}

/** A secret's lines: knows claims about it with a knower, not waiting. */
const linesOf = (claims: readonly KnowsClaim[], secretId: string): KnowsClaim[] =>
  claims.filter(
    (claim) =>
      claim.objectId === secretId &&
      claim.recordId !== null &&
      claim.state !== 'waiting' &&
      parseHow(claim.how) !== null
  )

/** What shows readers a secret: each reveal and counted line, where, and whether it is re-checked. */
interface Evidence {
  nodeId: string
  order: number
  stale: boolean
}

/** A secret's reveals (any role) and counted lines (P2b-D7), in reading order. */
function evidenceOf(
  secretId: string,
  claims: readonly KnowsClaim[],
  quotes: readonly TopicQuoteInput[],
  reading: ReadingOrder
): Evidence[] {
  const reveals = placed(
    quotes.filter((quote) => quote.recordId === secretId),
    reading
  )
  const counted = placed(
    linesOf(claims, secretId).filter((claim) => knowsLine(claim) === 'counts'),
    reading
  )
  return [...reveals, ...counted]
    .sort((a, b) => a.order - b.order || a.item.para - b.item.para)
    .map((entry) => ({
      nodeId: entry.item.nodeId,
      order: entry.order,
      stale: entry.item.state === 'stale'
    }))
}

/** The earliest scene of the evidence; `stale` when every piece of it there is re-checked. */
function sinceOf(evidence: readonly Evidence[], reading: ReadingOrder): SinceView | null {
  const first = evidence[0]
  if (first === undefined) return null
  return {
    ...refOf(reading, first.nodeId),
    stale: !evidence.some((each) => each.order === first.order && !each.stale)
  }
}

/**
 * "Readers have known since" (P2b-D7): the scene of the secret's earliest reveal or earliest
 * counted line (a learning or holding line; suspects and believes otherwise never set it), live
 * or re-checking (QUESTIONS 2026-10-12 #1: an edit never makes a secret vanish for a moment);
 * `stale` when only re-checked evidence stands in that scene (shown dimmed). Null when there is
 * none.
 */
export function readersSince(
  secretId: string,
  claims: readonly KnowsClaim[],
  quotes: readonly TopicQuoteInput[],
  reading: ReadingOrder
): SinceView | null {
  return sinceOf(evidenceOf(secretId, claims, quotes, reading), reading)
}

const quoteView = (quote: TopicQuoteInput, reading: ReadingOrder): TopicQuoteView => ({
  topicQuoteId: quote.id,
  role: quote.role,
  label: quote.label,
  quote: quote.quote,
  nodeId: quote.nodeId,
  ref: reading.refs.get(quote.nodeId) ?? '',
  para: quote.para,
  stale: quote.state === 'stale'
})

/** A topic's reveals as of nothing in particular: its defining one and the merged ones, in order. */
export function topicQuotesOf(
  recordId: string,
  quotes: readonly TopicQuoteInput[],
  reading: ReadingOrder
): { defining: TopicQuoteView | null; merged: TopicQuoteView[] } {
  const own = placed(
    quotes.filter((quote) => quote.recordId === recordId),
    reading
  ).map((entry) => quoteView(entry.item, reading))
  return {
    defining: own.find((quote) => quote.role === 'defining') ?? null,
    merged: own.filter((quote) => quote.role === 'merged')
  }
}

function cellOf(
  claim: KnowsClaim,
  secretId: string,
  reading: ReadingOrder,
  later: boolean
): KnowsCellView {
  const line = knowsLine(claim)
  return {
    knowerId: claim.recordId ?? '',
    secretId,
    how: parseHow(claim.how) ?? 'refers',
    fromId: claim.fromId,
    source: 'claim',
    line,
    claimId: claim.id,
    nodeId: claim.nodeId,
    ref: reading.refs.get(claim.nodeId) ?? '',
    para: claim.para,
    voice: claim.voice,
    mode: claim.mode,
    speakerId: claim.speakerId,
    stale: claim.state === 'stale',
    later
  }
}

const authorCell = (secretId: string, knowerId: string): KnowsCellView => ({
  knowerId,
  secretId,
  how: 'knewBefore' satisfies KnowsHow,
  fromId: null,
  source: 'author',
  line: 'counts',
  claimId: null,
  nodeId: null,
  ref: null,
  para: null,
  voice: null,
  mode: null,
  speakerId: null,
  stale: false,
  later: false
})

export interface KnowsAsOfInput {
  secrets: readonly SecretInput[]
  /** The draft's knows claims (slot `knows`). */
  claims: readonly KnowsClaim[]
  quotes: readonly TopicQuoteInput[]
  knewBefore: readonly KnewBeforeInput[]
  reading: ReadingOrder
  flags: ReadonlyMap<string, SceneFlags>
  /** Readable scenes with no words yet: checked as they stand (`checkedUpTo`). */
  empty?: ReadonlySet<string>
  /** The scene it is read as of; null for the end of the book. */
  atId: string | null
}

export interface KnowsAsOf {
  asOf: string | null
  asOfRef: string | null
  checkedUpTo: SceneRefView | null
  /** Every secret, newest reveal first (secrets no scene reveals yet last, by label). */
  secrets: SecretView[]
}

/**
 * Who knows what as of a scene (F-16.22): per secret, readers-since, whether readers know it as
 * of the scene, its reveals, one cell per knower (the author's *Knew before the book* first;
 * else the strongest line as of the scene: counted over partial, the earliest of its kind; else
 * the first later line, flagged `later`), the lines that do not count (dialogue by someone else,
 * rumour, hypotheticals, dreams) apart, and the knew-before marks. A knower with no line is not a
 * cell: absence is never a fact.
 */
export function knowsAsOf(input: KnowsAsOfInput): KnowsAsOf {
  const { reading, atId } = input
  const at = atId === null ? Infinity : (reading.at.get(atId) ?? -1)
  const orderOf = (nodeId: string): number => reading.order.get(nodeId) ?? Infinity
  const secrets = input.secrets.map((secret): SecretView & { sinceOrder: number } => {
    const id = secret.recordId
    const lines = placed(linesOf(input.claims, id), reading)
    const knew = input.knewBefore.filter((row) => row.secretId === id).map((row) => row.recordId)
    const cells = new Map<string, KnowsCellView>()
    for (const knower of knew) cells.set(knower, authorCell(id, knower))
    const pick = (line: 'counts' | 'partial', when: 'asOf' | 'later'): void => {
      for (const entry of lines) {
        const knower = entry.item.recordId ?? ''
        if (cells.has(knower) || knowsLine(entry.item) !== line) continue
        if ((when === 'asOf') !== entry.order <= at) continue
        cells.set(knower, cellOf(entry.item, id, reading, when === 'later'))
      }
    }
    pick('counts', 'asOf')
    pick('partial', 'asOf')
    pick('counts', 'later')
    pick('partial', 'later')
    const others = lines
      .filter((entry) => entry.order <= at && knowsLine(entry.item) === 'other')
      .map((entry) => cellOf(entry.item, id, reading, false))
    const evidence = evidenceOf(id, input.claims, input.quotes, reading)
    const since = sinceOf(evidence, reading)
    const sinceOrder = since === null ? Infinity : orderOf(since.nodeId)
    // The scenes that touch it: a counted or partial line, or a reveal of any role (P2b-D21).
    const touchedIn = [
      ...lines.filter((entry) => knowsLine(entry.item) !== 'other'),
      ...placed(
        input.quotes.filter((quote) => quote.recordId === id),
        reading
      )
    ]
      .sort((a, b) => a.order - b.order)
      .map((entry) => entry.item.nodeId)
    // Cells in the order their knowers first appear in the book (the author's marks first).
    const firstSeen = new Map<string, number>()
    for (const [i, entry] of lines.entries()) {
      const knower = entry.item.recordId ?? ''
      if (!firstSeen.has(knower)) firstSeen.set(knower, i)
    }
    const orderedCells = [...cells.values()].sort(
      (a, b) =>
        (a.source === 'author' ? -1 : (firstSeen.get(a.knowerId) ?? 0)) -
        (b.source === 'author' ? -1 : (firstSeen.get(b.knowerId) ?? 0))
    )
    return {
      recordId: id,
      label: secret.label,
      origin: secret.origin,
      readersSince: since,
      known: since !== null && sinceOrder <= at,
      knownStale:
        since !== null &&
        sinceOrder <= at &&
        !evidence.some((each) => each.order <= at && !each.stale),
      ...topicQuotesOf(id, input.quotes, reading),
      cells: orderedCells,
      others,
      knewBefore: knew,
      touchedIn: [...new Set(touchedIn)],
      sinceOrder
    }
  })
  secrets.sort(
    (a, b) =>
      (a.sinceOrder === Infinity ? 1 : 0) - (b.sinceOrder === Infinity ? 1 : 0) ||
      b.sinceOrder - a.sinceOrder ||
      a.label.localeCompare(b.label)
  )
  return {
    asOf: atId,
    asOfRef: atId === null || !reading.at.has(atId) ? null : (reading.refs.get(atId) ?? null),
    checkedUpTo: checkedUpTo(reading, input.flags, atId, input.empty),
    secrets: secrets.map(({ sinceOrder: _, ...secret }) => secret)
  }
}

/** Whether a cell shows the knower holding the secret as of the scene (counted, or the author's). */
const holds = (cell: KnowsCellView): boolean => !cell.later && cell.line === 'counts'

/**
 * Whether a secret is a row of the grid as of the scene (P2b-D20): readers know it, or the author
 * made it and no scene reveals it yet (her own secret has a place for her knew-before marks).
 */
const isRow = (secret: SecretView): boolean =>
  secret.known || (secret.origin !== 'ai' && secret.readersSince === null)

/**
 * The Book's grid (P2b-D20): rows are the secrets readers know as of the scene (and the author's
 * own not revealed yet), newest first; columns the characters and groups with a line or
 * knew-before as of the scene in any row, plus the POV, by how often each is named (`named`,
 * most first), then first seen; `later` counts the secrets readers learn later.
 */
export function knowsGrid(
  knows: KnowsAsOf,
  options: { pov: string | null; named: ReadonlyMap<string, number> }
): KnowsGrid {
  const rows = knows.secrets.filter(isRow)
  const seen: string[] = []
  for (const secret of rows) {
    for (const cell of [...secret.cells, ...secret.others]) {
      if (!cell.later && !seen.includes(cell.knowerId)) seen.push(cell.knowerId)
    }
  }
  if (options.pov !== null && !seen.includes(options.pov)) seen.push(options.pov)
  const columns = seen
    .map((id, index) => ({ id, index, named: options.named.get(id) ?? 0 }))
    .sort((a, b) => b.named - a.named || a.index - b.index)
    .map((each) => each.id)
  return {
    asOf: knows.asOf,
    asOfRef: knows.asOfRef,
    checkedUpTo: knows.checkedUpTo,
    columns,
    rows,
    later: knows.secrets.filter((secret) => !secret.known && secret.readersSince !== null).length
  }
}

/** The most tension lines This scene shows (P2b-D21). */
export const TENSION_MAX = 3

/**
 * This scene's Who knows what (P2b-D21), from `knowsAsOf` read as of the scene: every secret
 * touched in it (any counted or partial line there, a holder's repeat included, or any reveal
 * there: `touchedIn`), each with the Here characters that have no counted line for it; then at
 * most `TENSION_MAX` tension lines, first "readers know and the POV has none", then "someone Here
 * holds it and another Here has none", newest secret first, each `stale` when it rests on a line
 * or reveal being re-checked; and how many of the grid's other rows "+ N more in Book" opens.
 * `here` is the scene's Here records (the POV among them). Every "has none" is scoped by
 * `checkedUpTo`.
 */
export function sceneSecrets(
  knows: KnowsAsOf,
  sceneId: string,
  here: readonly string[],
  pov: string | null
): SceneSecrets {
  const inScene = (secret: SecretView): boolean => secret.touchedIn.includes(sceneId)
  const holders = (secret: SecretView): Set<string> =>
    new Set(secret.cells.filter(holds).map((cell) => cell.knowerId))
  const touched: SceneSecretView[] = knows.secrets.filter(inScene).map((secret) => {
    const has = holders(secret)
    return { secret, without: here.filter((id) => !has.has(id)) }
  })

  const known = knows.secrets.filter((secret) => secret.known)
  const tension: TensionLine[] = []
  if (pov !== null) {
    for (const secret of known) {
      if (!holders(secret).has(pov)) {
        tension.push({
          kind: 'readersKnow',
          secretId: secret.recordId,
          recordId: pov,
          stale: secret.knownStale
        })
      }
    }
  }
  for (const secret of known) {
    const has = holders(secret)
    const holder = here.find((id) => has.has(id))
    const without = here.find(
      (id) =>
        !has.has(id) &&
        !tension.some(
          (line) =>
            line.kind === 'readersKnow' && line.secretId === secret.recordId && line.recordId === id
        )
    )
    if (holder !== undefined && without !== undefined) {
      const cell = secret.cells.find((each) => each.knowerId === holder)
      tension.push({
        kind: 'hereKnows',
        secretId: secret.recordId,
        holderId: holder,
        recordId: without,
        stale: secret.knownStale || cell?.stale === true
      })
    }
  }
  const shown = new Set(touched.map((each) => each.secret.recordId))
  return {
    touched,
    tension: tension.slice(0, TENSION_MAX),
    more: knows.secrets.filter((secret) => isRow(secret) && !shown.has(secret.recordId)).length,
    checkedUpTo: knows.checkedUpTo
  }
}
