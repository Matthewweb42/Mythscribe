import { queryTerms } from '../searchTerms'
import type { ReadingOrder } from './asOf'
import type { ClaimMode, ClaimVoice } from './claims'
import {
  findingKey,
  npKey,
  raisesAlone,
  RULE_ORDER,
  type FindingExtra,
  type FindingRule,
  type FindingSide,
  type FindingVariant
} from './findings'
import { knowsLine, LEARNS, parseHow } from './knows'
import { kinWords } from './literal'
import { groupsOf, type MembershipInput } from './membership'
import {
  datedScene,
  noteKinValue,
  noteSentences,
  noteValue,
  pairsWith,
  type DatedScene,
  type NoteName,
  type NoteParagraph,
  type NoteRecord,
  type NoteSentence
} from './noteValues'
import type { RecordKind } from './records'
import { slotGroup, type Slot } from './slots'
import { stepCounts } from './threadsAsOf'
import { parseStep, stepRank } from './topics'
import { detailsAgree } from './typedVsText'
import { ageYears, bornLine, yearCalendar, yearIn } from './years'

/**
 * Contradiction candidates in code (F-16.27; design §2.4's table, plan P4 §1.3), pure: rules
 * C1–C6 run in the background after every change to what the memory holds; C7 runs on *Check the
 * book* only. Each candidate names its rule, its subject, its slot and two sides (references, never
 * copies of the text). A side that is a claim whose sentence changed since it was read (`stale`)
 * makes the candidate `held`: never judged, shown or closed until the re-read (P4-D13). A
 * candidate that needs a scene not to be a flashback, in a scene whose card says it is one, is
 * `hidden` (C2, C4). Keys on the Dismissed list (*Not a problem*) are dropped. Nothing here reads
 * text: the inputs carry everything (`candidateInputs.ts` in main).
 */

/** A claim as the rules read it: the active draft's, in a readable scene, live or stale, never waiting. */
export interface CandidateClaim {
  id: string
  recordId: string
  slot: Slot
  value: string
  valueKey: string
  objectId: string | null
  how: string | null
  fromId: string | null
  voice: ClaimVoice
  speakerId: string | null
  mode: ClaimMode
  nodeId: string
  para: number
  state: 'live' | 'stale'
  /** The sentence states a change ("she had cut it short"). */
  change: boolean
  created: string
}

/** What a scene's card says once held against the text (read only for the scenes a rule asks about). */
export interface SceneFacts {
  /** Records on the page by a verified quote that still stands. */
  present: ReadonlySet<string>
  /** The card's verified flashback, standing on the text. */
  flashback: boolean
  /** The year the text states, verified and standing, as written ("the spring of 1812"). */
  quotedYear: string | null
}

/** The author's typed details of a scene, as the rules read them. */
export interface TypedScene {
  pov: string | null
  alsoHere: readonly string[]
  year: number | null
}

/** A record as the rules read it. */
export interface CandidateRecord {
  id: string
  kind: RecordKind
  name: string
  names: readonly NoteName[]
}

export interface CandidateInputs {
  reading: ReadingOrder
  claims: readonly CandidateClaim[]
  /** Who each scene's stored card puts on the page (unverified: an appearance, no text read). */
  onPage: ReadonlyMap<string, ReadonlySet<string>>
  typed: ReadonlyMap<string, TypedScene>
  /** One scene's held card (its text is read once, only when a rule asks). */
  scene: (nodeId: string) => SceneFacts
  knewBefore: readonly { secretId: string; recordId: string }[]
  records: ReadonlyMap<string, CandidateRecord>
  /** Canon note paragraphs: records' Pinned pages and canon Research pages. */
  notes: readonly NoteParagraph[]
  /** The readable scenes a dated note line may name. */
  scenes: readonly DatedScene[]
  /** The *Not a problem* keys on the Dismissed list. */
  dismissed: ReadonlySet<string>
}

export interface Candidate {
  rule: FindingRule
  variant: FindingVariant | null
  recordId: string
  slot: string
  a: FindingSide
  b: FindingSide
  extra: FindingExtra | null
  held: boolean
  hidden: boolean
  npKey: string
  key: string
}

/** The lasting body slots C2 compares between appearances (P4-D4). */
export const BODY_SLOTS: readonly Slot[] = ['hair', 'scars']

/** The words that read a value of `alive` as a death (P4-D3: a closed list). */
const DEATH =
  /(?<![\p{L}\p{N}])(?:dead|died|killed|drowned|slain|murdered|perished|buried|hanged|passed\s+away)(?![\p{L}\p{N}])/iu

/** Whether an `alive` value reads as a death. */
export const deathWord = (value: string): boolean => DEATH.test(value)

/** C7's pairs per claim, nearest first (P4-D9). */
export const C7_PAIRS_PER_CLAIM = 5
/** C6's note sentences per claim, its own sheet's first (design §2.4). */
export const C6_SENTENCES_PER_CLAIM = 2

const claimSide = (claim: CandidateClaim): FindingSide => ({
  kind: 'claim',
  claimId: claim.id,
  nodeId: claim.nodeId,
  valueKey: claim.valueKey
})

const noteSide = (
  sentence: NoteSentence,
  value: string,
  datedNodeId: string | null
): FindingSide => ({
  kind: 'note',
  ownerKind: sentence.note.ownerKind,
  ownerId: sentence.note.ownerId,
  page: sentence.note.page,
  para: sentence.note.para,
  sentence: sentence.sentence,
  value,
  datedNodeId
})

function candidate(
  rule: FindingRule,
  variant: FindingVariant | null,
  recordId: string,
  slot: string,
  a: FindingSide,
  b: FindingSide,
  options: { extra?: FindingExtra; held?: boolean; hidden?: boolean } = {}
): Candidate {
  const notProblem = npKey(recordId, slot, a, b)
  return {
    rule,
    variant,
    recordId,
    slot,
    a,
    b,
    extra: options.extra ?? null,
    held: options.held ?? false,
    hidden: options.hidden ?? false,
    npKey: notProblem,
    key: findingKey(rule, variant, notProblem)
  }
}

/** A claim's place in reading order: its scene's order, then its paragraph. */
interface Placed {
  claim: CandidateClaim
  order: number
}

function placedClaims(
  claims: readonly CandidateClaim[],
  reading: ReadingOrder,
  keep: (claim: CandidateClaim) => boolean
): Placed[] {
  return claims
    .flatMap((claim) => {
      const order = reading.order.get(claim.nodeId)
      return order === undefined || !keep(claim) ? [] : [{ claim, order }]
    })
    .sort(byPlace)
}

function byPlace(a: Placed, b: Placed): number {
  return (
    a.order - b.order ||
    a.claim.para - b.claim.para ||
    a.claim.created.localeCompare(b.claim.created) ||
    a.claim.id.localeCompare(b.claim.id)
  )
}

/** Whether `a` stands before `b` in reading order (a later scene, or the same scene's later paragraph). */
const before = (a: Placed, b: Placed): boolean =>
  a.order < b.order || (a.order === b.order && a.claim.para < b.claim.para)

function groupBy<T>(items: readonly T[], key: (item: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>()
  for (const item of items) {
    const at = key(item)
    const list = groups.get(at)
    if (list === undefined) groups.set(at, [item])
    else list.push(item)
  }
  return groups
}

const stale = (...claims: CandidateClaim[]): boolean =>
  claims.some((claim) => claim.state === 'stale')

/** The slot a fixed claim is grouped and keyed by: kinship per object (`kinship:<objectId>`). */
const fixedSlot = (claim: CandidateClaim): string =>
  claim.slot === 'kinship' && claim.objectId !== null ? `kinship:${claim.objectId}` : claim.slot

/**
 * C1 (P4-D2): per record, fixed slot and (for kinship) object, the values grouped by agreement
 * (`detailsAgree`: equal, or one's words holding the other's); each group's representative is its
 * earliest narration-now claim, else its earliest claim; the anchor is the earliest group with a
 * narration-now representative, and every other group is paired with it (k groups, k−1 pairs). No
 * narration-now value at all: no pair (non-narration claims never raise C1 on their own, P4-D1).
 */
export function candidatesC1(inputs: CandidateInputs): Candidate[] {
  const out: Candidate[] = []
  const fixed = placedClaims(
    inputs.claims,
    inputs.reading,
    (claim) => slotGroup(claim.slot) === 'fixed'
  )
  for (const run of groupBy(
    fixed,
    (entry) => `${entry.claim.recordId}|${fixedSlot(entry.claim)}`
  ).values()) {
    const clusters: Placed[][] = []
    for (const entry of run) {
      const joined = clusters.filter((cluster) =>
        cluster.some((member) => detailsAgree(member.claim.value, entry.claim.value))
      )
      if (joined.length === 0) {
        clusters.push([entry])
        continue
      }
      const [first, ...rest] = joined
      if (first === undefined) continue
      first.push(entry)
      for (const other of rest) {
        first.push(...other)
        clusters.splice(clusters.indexOf(other), 1)
      }
    }
    const reps = clusters
      .map((cluster) => {
        const sorted = [...cluster].sort(byPlace)
        return sorted.find((member) => raisesAlone(member.claim)) ?? sorted[0]
      })
      .filter((rep): rep is Placed => rep !== undefined)
      .sort(byPlace)
    const anchor = reps.find((rep) => raisesAlone(rep.claim))
    if (anchor === undefined) continue
    for (const rep of reps) {
      if (rep === anchor) continue
      const [a, b] = before(rep, anchor) ? [rep, anchor] : [anchor, rep]
      out.push(
        candidate(
          'C1',
          null,
          a.claim.recordId,
          fixedSlot(a.claim),
          claimSide(a.claim),
          claimSide(b.claim),
          {
            held: stale(a.claim, b.claim)
          }
        )
      )
    }
  }
  return out
}

/**
 * C2 `dead` (P4-D3): a narration-now `alive` claim reading as a death (`deathWord`) at scene A, and
 * a later scene B where the record is on the page (a held `present` entry with its verified quote,
 * never a typed POV or *+ also here*), with no narration-now `alive` claim reading as living from A
 * to B; each presence pairs with the latest death before it. B a verified flashback → hidden.
 */
export function candidatesC2Dead(inputs: CandidateInputs): Candidate[] {
  const out: Candidate[] = []
  const alive = placedClaims(
    inputs.claims,
    inputs.reading,
    (claim) => claim.slot === 'alive' && raisesAlone(claim)
  )
  const scenesOf = new Map<string, number[]>()
  for (const [nodeId, records] of inputs.onPage) {
    const order = inputs.reading.order.get(nodeId)
    if (order === undefined) continue
    for (const recordId of records)
      scenesOf.set(recordId, [...(scenesOf.get(recordId) ?? []), order])
  }
  const nodeAt = new Map([...inputs.reading.order].map(([nodeId, order]) => [order, nodeId]))
  for (const [recordId, run] of groupBy(alive, (entry) => entry.claim.recordId)) {
    if (!run.some((entry) => deathWord(entry.claim.value))) continue
    for (const order of [...(scenesOf.get(recordId) ?? [])].sort((x, y) => x - y)) {
      const earlier = run.filter((entry) => entry.order < order)
      const death = [...earlier].reverse().find((entry) => deathWord(entry.claim.value))
      if (death === undefined) continue
      // A living value from the death up to and in the scene cancels it (a resurrection).
      const living = run.some(
        (entry) => !deathWord(entry.claim.value) && before(death, entry) && entry.order <= order
      )
      if (living) continue
      const nodeId = nodeAt.get(order)
      if (nodeId === undefined) continue
      const facts = inputs.scene(nodeId)
      if (!facts.present.has(recordId)) continue
      out.push(
        candidate(
          'C2',
          'dead',
          recordId,
          'alive',
          claimSide(death.claim),
          { kind: 'presence', nodeId, recordId },
          {
            held: stale(death.claim),
            hidden: facts.flashback
          }
        )
      )
    }
  }
  return out
}

/** The scene orders where a record appears (no text read): the stored cards, the typed POV, *+ also here*. */
function appearances(inputs: CandidateInputs, recordId: string): Set<number> {
  const orders = new Set<number>()
  for (const [nodeId, order] of inputs.reading.order) {
    const typed = inputs.typed.get(nodeId)
    if (
      inputs.onPage.get(nodeId)?.has(recordId) === true ||
      typed?.pov === recordId ||
      typed?.alsoHere.includes(recordId) === true
    ) {
      orders.add(order)
    }
  }
  return orders
}

/**
 * C2 `body` (P4-D4): consecutive narration-now claims of one record in a lasting body slot (hair,
 * scars), A then B, whose values disagree, where B is the record's next appearance after A (no scene
 * between them where the record is Here by the stored cards, the typed POV or *+ also here*; or the
 * same scene), and no claim of that slot from A to B states a change. Either scene a verified
 * flashback → hidden.
 */
export function candidatesC2Body(inputs: CandidateInputs): Candidate[] {
  const out: Candidate[] = []
  const body = placedClaims(inputs.claims, inputs.reading, (claim) =>
    BODY_SLOTS.includes(claim.slot)
  )
  for (const run of groupBy(
    body,
    (entry) => `${entry.claim.recordId}|${entry.claim.slot}`
  ).values()) {
    const said = run.filter((entry) => raisesAlone(entry.claim))
    const recordId = run[0]?.claim.recordId ?? ''
    let seen: Set<number> | null = null
    for (let i = 1; i < said.length; i += 1) {
      const a = said[i - 1]
      const b = said[i]
      if (a === undefined || b === undefined) continue
      if (detailsAgree(a.claim.value, b.claim.value)) continue
      seen ??= appearances(inputs, recordId)
      const between = [...seen].some((order) => order > a.order && order < b.order)
      if (between) continue
      const changed = run.some(
        (entry) => entry.claim.change && before(a, entry) && !before(b, entry)
      )
      if (changed) continue
      out.push(
        candidate('C2', 'body', recordId, a.claim.slot, claimSide(a.claim), claimSide(b.claim), {
          held: stale(a.claim, b.claim),
          hidden: inputs.scene(a.claim.nodeId).flashback || inputs.scene(b.claim.nodeId).flashback
        })
      )
    }
  }
  return out
}

/** The membership input the claims, records and Pinned notes give. */
function membershipOf(inputs: CandidateInputs): MembershipInput {
  return {
    claims: inputs.claims,
    records: inputs.records,
    pinned: inputs.notes.filter((note) => note.ownerKind === 'record')
  }
}

/**
 * C3: per secret and knower, the earliest counted line (`knowsLine` = `counts`) is `tells` or
 * `refers`, and a later counted learning line (saw, told, overheard, read, deduced) of the same
 * knower that is not a memory exists (a later scene, or the same scene's later paragraph). Skipped
 * when the author marked them *Knew before the book*, when their earliest line is `knewBefore`, or
 * when a group they belong to (`groupsOf`, P4-D5) knew it at or before that line. Never raised
 * without the later learning line (design Part 6).
 */
export function candidatesC3(inputs: CandidateInputs): Candidate[] {
  const out: Candidate[] = []
  const lines = placedClaims(
    inputs.claims,
    inputs.reading,
    (claim) =>
      claim.slot === 'knows' &&
      claim.objectId !== null &&
      knowsLine({
        how: claim.how,
        voice: claim.voice,
        mode: claim.mode,
        recordId: claim.recordId,
        speakerId: claim.speakerId,
        fromId: claim.fromId
      }) === 'counts'
  )
  const knew = new Set(inputs.knewBefore.map((row) => `${row.secretId}|${row.recordId}`))
  const bySecret = groupBy(lines, (entry) => entry.claim.objectId ?? '')
  let membership: MembershipInput | null = null
  for (const [pair, run] of groupBy(
    lines,
    (entry) => `${entry.claim.objectId ?? ''}|${entry.claim.recordId}`
  )) {
    const first = run[0]
    if (first === undefined) continue
    const how = parseHow(first.claim.how)
    if (how !== 'tells' && how !== 'refers') continue
    if (knew.has(pair)) continue
    const secretId = first.claim.objectId ?? ''
    const learning = run.find((entry) => {
      const each = parseHow(entry.claim.how)
      return (
        each !== null &&
        LEARNS.includes(each) &&
        entry.claim.mode !== 'memory' &&
        before(first, entry)
      )
    })
    if (learning === undefined) continue
    membership ??= membershipOf(inputs)
    const groups = groupsOf(first.claim.recordId, membership)
    const groupKnew = [...groups].some(
      (groupId) =>
        knew.has(`${secretId}|${groupId}`) ||
        (bySecret.get(secretId) ?? []).some(
          (entry) => entry.claim.recordId === groupId && !before(first, entry)
        )
    )
    if (groupKnew) continue
    out.push(
      candidate(
        'C3',
        null,
        first.claim.recordId,
        `knows:${secretId}`,
        claimSide(first.claim),
        claimSide(learning.claim),
        { held: stale(first.claim, learning.claim) }
      )
    )
  }
  return out
}

/** A record's birth year as of an age claim: its latest narration-now `born` claim with one year, else a Pinned "Born:" line. */
interface Birth {
  year: number
  calendar: string
  side: FindingSide
  claim: CandidateClaim | null
}

function birthOf(
  inputs: CandidateInputs,
  births: readonly Placed[],
  age: Placed,
  pinnedBorn: (recordId: string) => Birth | null
): Birth | null {
  const claim = [...births]
    .reverse()
    .find((entry) => entry.order <= age.order && yearIn(entry.claim.value) !== null)
  if (claim !== undefined) {
    return {
      year: yearIn(claim.claim.value) ?? 0,
      calendar: yearCalendar(claim.claim.value),
      side: claimSide(claim.claim),
      claim: claim.claim
    }
  }
  return pinnedBorn(age.claim.recordId)
}

/**
 * C4 `birth` (P4-D6): a narration-now stated age at scene A, the record's birth year as of A (a
 * `born` claim with one year, else a canon Pinned "Born:" line), and A's own year, typed for A or
 * quoted (verified) in A, never carried, in the same calendar; a candidate when the age is more
 * than a year off. A a verified flashback → hidden.
 */
export function candidatesC4Birth(inputs: CandidateInputs): Candidate[] {
  const out: Candidate[] = []
  const ages = placedClaims(
    inputs.claims,
    inputs.reading,
    (claim) => claim.slot === 'age' && raisesAlone(claim) && ageYears(claim.value) !== null
  )
  if (ages.length === 0) return out
  const births = groupBy(
    placedClaims(
      inputs.claims,
      inputs.reading,
      (claim) => claim.slot === 'born' && raisesAlone(claim)
    ),
    (entry) => entry.claim.recordId
  )
  const pinned = new Map<string, Birth | null>()
  const pinnedBorn = (recordId: string): Birth | null => {
    if (pinned.has(recordId)) return pinned.get(recordId) ?? null
    let found: Birth | null = null
    for (const note of inputs.notes) {
      if (note.ownerKind !== 'record' || note.ownerId !== recordId || note.page !== 'pinned')
        continue
      const line = bornLine(note.text)
      if (line === null) continue
      const sentences = noteSentences(note)
      const at = sentences.find((sentence) => bornLine(sentence.text) !== null) ?? sentences[0]
      if (at === undefined) continue
      found = {
        year: line.year,
        calendar: yearCalendar(line.value),
        side: noteSide(at, String(line.year), null),
        claim: null
      }
      break
    }
    pinned.set(recordId, found)
    return found
  }
  for (const age of ages) {
    const stated = ageYears(age.claim.value) ?? 0
    const typed = inputs.typed.get(age.claim.nodeId)?.year ?? null
    let year: { value: number; source: 'typed' | 'quoted'; calendar: string } | null = null
    if (typed !== null) year = { value: typed, source: 'typed', calendar: '' }
    else {
      const quoted = inputs.scene(age.claim.nodeId).quotedYear
      const value = quoted === null ? null : yearIn(quoted)
      if (quoted !== null && value !== null) {
        year = { value, source: 'quoted', calendar: yearCalendar(quoted) }
      }
    }
    if (year === null) continue
    const birth = birthOf(inputs, births.get(age.claim.recordId) ?? [], age, pinnedBorn)
    if (birth?.calendar !== year.calendar) continue
    if (Math.abs(stated - (year.value - birth.year)) <= 1) continue
    out.push(
      candidate('C4', 'birth', age.claim.recordId, 'age', claimSide(age.claim), birth.side, {
        extra: { year: { value: year.value, source: year.source, nodeId: age.claim.nodeId } },
        held: stale(age.claim, ...(birth.claim === null ? [] : [birth.claim])),
        hidden: inputs.scene(age.claim.nodeId).flashback
      })
    )
  }
  return out
}

/**
 * C4 `falls` (C4b): a narration-now stated age lower than the record's stated age before it in
 * reading order, the earlier one outside a flashback; a later age in a flashback → hidden.
 */
export function candidatesC4Falls(inputs: CandidateInputs): Candidate[] {
  const out: Candidate[] = []
  const ages = placedClaims(
    inputs.claims,
    inputs.reading,
    (claim) => claim.slot === 'age' && raisesAlone(claim) && ageYears(claim.value) !== null
  )
  for (const run of groupBy(ages, (entry) => entry.claim.recordId).values()) {
    let last: Placed | null = null
    for (const entry of run) {
      const flashback = inputs.scene(entry.claim.nodeId).flashback
      if (last !== null && (ageYears(entry.claim.value) ?? 0) < (ageYears(last.claim.value) ?? 0)) {
        out.push(
          candidate(
            'C4',
            'falls',
            entry.claim.recordId,
            'age',
            claimSide(last.claim),
            claimSide(entry.claim),
            {
              held: stale(last.claim, entry.claim),
              hidden: flashback
            }
          )
        )
      }
      if (!flashback) last = entry
    }
  }
  return out
}

/**
 * C5 (P4-D7): a thread's counted `resolves` step and a counted `advances` step in a later scene
 * (one scene with both reads as resolved, `stepRank`, so the same scene never pairs), with no
 * `opens` step between them (a thread re-opened is not flagged).
 */
export function candidatesC5(inputs: CandidateInputs): Candidate[] {
  const out: Candidate[] = []
  const steps = placedClaims(
    inputs.claims,
    inputs.reading,
    (claim) => claim.slot === 'thread' && stepCounts(claim) && parseStep(claim.how) !== null
  )
  const rank = (entry: Placed): number => stepRank(parseStep(entry.claim.how) ?? 'opens')
  for (const run of groupBy(steps, (entry) => entry.claim.recordId).values()) {
    const sorted = [...run].sort((a, b) => a.order - b.order || rank(a) - rank(b) || byPlace(a, b))
    for (const step of sorted) {
      if (parseStep(step.claim.how) !== 'advances') continue
      const earlier = sorted.filter((entry) => entry.order < step.order)
      const resolveAt = earlier.map((entry) => parseStep(entry.claim.how)).lastIndexOf('resolves')
      const resolve = resolveAt === -1 ? undefined : earlier[resolveAt]
      if (resolve === undefined) continue
      const reopened = earlier
        .slice(resolveAt + 1)
        .some((entry) => parseStep(entry.claim.how) === 'opens')
      if (reopened) continue
      out.push(
        candidate(
          'C5',
          null,
          step.claim.recordId,
          'thread',
          claimSide(resolve.claim),
          claimSide(step.claim),
          {
            held: stale(resolve.claim, step.claim)
          }
        )
      )
    }
  }
  return out
}

/**
 * C6 (P4-D8): per record, each claim in a fixed slot or kinship (any voice and mode: the note is
 * the canon side) against the canon note sentences that pair with it (`pairsWith`) and whose value
 * code read (`noteValue`; for kinship, `noteKinValue` with the object named) differs; a lasting or
 * transient slot only against dated note lines naming the claim's own scene. At most two note
 * sentences per claim, its own sheet's first, then in page order.
 */
export function candidatesC6(inputs: CandidateInputs): Candidate[] {
  const out: Candidate[] = []
  if (inputs.notes.length === 0) return out
  const sentences = inputs.notes.flatMap(noteSentences)
  const noteRecord = (recordId: string): NoteRecord | null => {
    const record = inputs.records.get(recordId)
    return record === undefined ? null : { id: record.id, names: record.names }
  }
  const pairing = new Map<string, NoteSentence[]>()
  const sentencesFor = (record: NoteRecord, slot: Slot): NoteSentence[] => {
    const key = `${record.id}|${slot}`
    const known = pairing.get(key)
    if (known !== undefined) return known
    const own = (sentence: NoteSentence): boolean =>
      sentence.note.ownerKind === 'record' && sentence.note.ownerId === record.id
    const found = sentences.filter((sentence) => pairsWith(sentence, record, slot))
    const ordered = [...found.filter(own), ...found.filter((sentence) => !own(sentence))]
    pairing.set(key, ordered)
    return ordered
  }
  for (const claim of inputs.claims) {
    const group = slotGroup(claim.slot)
    if (group !== 'fixed' && group !== 'lasting' && group !== 'transient') continue
    if (!inputs.reading.order.has(claim.nodeId)) continue
    const record = noteRecord(claim.recordId)
    if (record === null) continue
    const object =
      claim.slot === 'kinship' && claim.objectId !== null ? noteRecord(claim.objectId) : null
    if (claim.slot === 'kinship' && object === null) continue
    const read: { sentence: NoteSentence; value: string; dated: string | null }[] = []
    for (const sentence of sentencesFor(record, claim.slot)) {
      if (read.length >= C6_SENTENCES_PER_CLAIM) break
      if (object !== null) {
        const kin = noteKinValue(sentence, record, object)
        if (kin !== null) read.push({ sentence, value: kin, dated: null })
        continue
      }
      const value = noteValue(sentence, record, claim.slot)
      if (value === null) continue
      const dated = value.scene === null ? null : datedScene(value.scene, inputs.scenes)
      if (group !== 'fixed' && dated !== claim.nodeId) continue
      read.push({ sentence, value: value.value, dated })
    }
    for (const note of read) {
      const own = object === null ? claim.value : (kinOf(claim.value) ?? '')
      if (own === '' || detailsAgree(own, note.value)) continue
      out.push(
        candidate(
          'C6',
          null,
          claim.recordId,
          fixedSlot(claim),
          claimSide(claim),
          noteSide(note.sentence, note.value, note.dated),
          { held: stale(claim) }
        )
      )
    }
  }
  return out
}

/** A kinship value's kin word ("son of the late steward" → "son"; "the Captain's sister" → "sister"). */
const kinOf = (value: string): string | null => kinWords(value)[0]?.word ?? null

/** The content words of a value (four letters or more), the record's own names left out. */
function contentWords(value: string, names: readonly NoteName[]): Set<string> {
  const own = new Set(names.flatMap((name) => queryTerms(name.text)))
  return new Set(queryTerms(value).filter((term) => term.length >= 4 && !own.has(term)))
}

/**
 * C7 (*Check the book* only, P4-D9): per record and slot, `history` claims and `detail:` claims
 * whose values differ, at least one of them narration in `now` mode, about one object (the same
 * object record) or sharing at least two content words of four letters or more (the record's own
 * names left out); at most five pairs per claim, nearest in reading order first. A pair C1 already
 * makes is left to C1.
 */
export function candidatesC7(inputs: CandidateInputs): Candidate[] {
  const out = new Map<string, Candidate>()
  const pool = placedClaims(
    inputs.claims,
    inputs.reading,
    (claim) => claim.slot === 'history' || claim.slot.startsWith('detail:')
  )
  const c1 = new Set(candidatesC1(inputs).map((each) => each.npKey))
  const taken = new Map<string, number>()
  for (const run of groupBy(
    pool,
    (entry) => `${entry.claim.recordId}|${entry.claim.slot}`
  ).values()) {
    const record = inputs.records.get(run[0]?.claim.recordId ?? '')
    const words = new Map(
      run.map((entry) => [entry, contentWords(entry.claim.value, record?.names ?? [])])
    )
    for (const entry of run) {
      const mine = words.get(entry) ?? new Set<string>()
      const partners = run
        .filter((other) => {
          if (other === entry) return false
          if (!raisesAlone(entry.claim) && !raisesAlone(other.claim)) return false
          if (detailsAgree(entry.claim.value, other.claim.value)) return false
          if (entry.claim.objectId !== null && entry.claim.objectId === other.claim.objectId)
            return true
          const theirs = words.get(other) ?? new Set<string>()
          return [...mine].filter((word) => theirs.has(word)).length >= 2
        })
        .sort(
          (x, y) =>
            Math.abs(x.order - entry.order) - Math.abs(y.order - entry.order) ||
            Math.abs(x.claim.para - entry.claim.para) - Math.abs(y.claim.para - entry.claim.para) ||
            byPlace(x, y)
        )
      for (const other of partners) {
        // At most five pairs a claim, counted on both claims of each pair.
        if ((taken.get(entry.claim.id) ?? 0) >= C7_PAIRS_PER_CLAIM) break
        if ((taken.get(other.claim.id) ?? 0) >= C7_PAIRS_PER_CLAIM) continue
        const [a, b] = before(other, entry) ? [other, entry] : [entry, other]
        const made = candidate(
          'C7',
          null,
          a.claim.recordId,
          a.claim.slot,
          claimSide(a.claim),
          claimSide(b.claim),
          { held: stale(a.claim, b.claim) }
        )
        if (c1.has(made.npKey) || out.has(made.key)) continue
        out.set(made.key, made)
        for (const id of [entry.claim.id, other.claim.id]) taken.set(id, (taken.get(id) ?? 0) + 1)
      }
    }
  }
  return dropDismissed(inputs, [...out.values()])
}

/** Candidates whose *Not a problem* key is not on the Dismissed list, each key once. */
function dropDismissed(inputs: CandidateInputs, candidates: readonly Candidate[]): Candidate[] {
  const seen = new Set<string>()
  return candidates.filter((each) => {
    if (inputs.dismissed.has(each.npKey) || seen.has(each.key)) return false
    seen.add(each.key)
    return true
  })
}

/** The background candidates (C1–C6, in `RULE_ORDER`), Dismissed keys dropped, each key once. */
export function backgroundCandidates(inputs: CandidateInputs): Candidate[] {
  const byRule: Record<Exclude<FindingRule, 'C7'>, () => Candidate[]> = {
    C1: () => candidatesC1(inputs),
    C2: () => [...candidatesC2Dead(inputs), ...candidatesC2Body(inputs)],
    C3: () => candidatesC3(inputs),
    C4: () => [...candidatesC4Birth(inputs), ...candidatesC4Falls(inputs)],
    C5: () => candidatesC5(inputs),
    C6: () => candidatesC6(inputs)
  }
  return dropDismissed(
    inputs,
    RULE_ORDER.flatMap((rule) => (rule === 'C7' ? [] : byRule[rule]()))
  )
}
