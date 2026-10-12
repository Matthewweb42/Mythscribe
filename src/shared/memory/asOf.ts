import { setsState, type Claim } from './claims'
import { ALL_SLOTS, slotGroup, type Slot } from './slots'

/**
 * What is true as of a scene (F-16.18; design §2.2 "Slots", §2.7): computed in code from the
 * claims, in reading order up to and including the scene (answer 8: "as of" is reading order).
 * Only narration in `now` mode sets state (`setsState`); everything else is "Mara says…",
 * remembered, supposed or dreamt, and shown apart. Absence is never a line: a slot nobody stated
 * is simply not there. Waiting claims are never shown; stale ones are, flagged, so the panel can
 * dim them ("re-checking after you pause").
 */

export type AsOfClaim = Pick<
  Claim,
  | 'id'
  | 'recordId'
  | 'slot'
  | 'value'
  | 'valueKey'
  | 'voice'
  | 'mode'
  | 'speakerId'
  | 'objectId'
  | 'nodeId'
  | 'para'
  | 'state'
  | 'created'
> & {
  /**
   * Where the quote starts in its paragraph (a character offset), so two claims of one paragraph
   * keep the text's order ("her hair was brown … she dyed it red"); null when not known.
   */
  pos: number | null
}

/** The manuscript's reading order (active draft, readable scenes) and each scene's reference. */
export interface ReadingOrder {
  /** Each readable scene's place in reading order. */
  order: ReadonlyMap<string, number>
  /**
   * Each manuscript scene's place for "as of": a readable scene's own `order`; an Idea scene or
   * one left out of compile reads as of the readable scene before it (-1 before the first).
   */
  at: ReadonlyMap<string, number>
  refs: ReadonlyMap<string, string>
}

export interface TrueNowLine {
  recordId: string
  slot: Slot
  objectId: string | null
  value: string
  claimId: string
  /** Lasting values read "since <ref>", transient ones "last stated in <ref>". */
  kind: 'since' | 'lastStated'
  ref: string
  nodeId: string
  stale: boolean
}

interface Placed {
  claim: AsOfClaim
  order: number
}

const slotRank = (slot: Slot): number => {
  const rank = ALL_SLOTS.indexOf(slot)
  return rank === -1 ? ALL_SLOTS.length : rank
}

/** Two claims of one paragraph in the text's order: by quote position, then as stored. */
function inParagraph(a: AsOfClaim, b: AsOfClaim): number {
  if (a.pos !== null && b.pos !== null && a.pos !== b.pos) return a.pos - b.pos
  return a.created.localeCompare(b.created) || a.id.localeCompare(b.id)
}

/**
 * Shown claims of the book in reading order (by scene, then paragraph, then place in the
 * paragraph), with their scene's place.
 */
function placed(claims: readonly AsOfClaim[], reading: ReadingOrder): Placed[] {
  return claims
    .flatMap((claim) => {
      const order = reading.order.get(claim.nodeId)
      if (order === undefined || claim.state === 'waiting' || claim.recordId === null) return []
      return [{ claim, order }]
    })
    .sort(
      (a, b) => a.order - b.order || a.claim.para - b.claim.para || inParagraph(a.claim, b.claim)
    )
}

const groupKey = (claim: AsOfClaim): string =>
  `${claim.recordId ?? ''}|${claim.slot}|${claim.objectId ?? ''}`

const refOf = (reading: ReadingOrder, nodeId: string): string => reading.refs.get(nodeId) ?? ''

/** The latest value of a run and the scene the run started in ("brown since 9.1"). */
function lastRun(run: readonly Placed[]): { latest: Placed; start: Placed } | null {
  const latest = run[run.length - 1]
  if (latest === undefined) return null
  let start = latest
  for (let i = run.length - 2; i >= 0; i -= 1) {
    const entry = run[i]
    if (entry?.claim.valueKey !== latest.claim.valueKey) break
    start = entry
  }
  return { latest, start }
}

/**
 * The True now lines as of scene `atId`: for each record and lasting slot, the latest
 * narration-now value with the scene its run began in; for each transient slot, the latest value
 * with the scene it was last stated in. An Idea scene or one left out of compile reads as of the
 * readable scene before it; empty when `atId` is not a manuscript scene.
 */
export function trueNow(
  claims: readonly AsOfClaim[],
  reading: ReadingOrder,
  atId: string
): TrueNowLine[] {
  const at = reading.at.get(atId)
  if (at === undefined) return []
  const runs = new Map<string, Placed[]>()
  for (const entry of placed(claims, reading)) {
    if (entry.order > at || !setsState(entry.claim)) continue
    const group = slotGroup(entry.claim.slot)
    if (group !== 'lasting' && group !== 'transient') continue
    const key = groupKey(entry.claim)
    runs.set(key, [...(runs.get(key) ?? []), entry])
  }
  const lines: TrueNowLine[] = []
  for (const run of runs.values()) {
    const found = lastRun(run)
    if (found === null) continue
    const { latest, start } = found
    const lasting = slotGroup(latest.claim.slot) === 'lasting'
    const shown = lasting ? start : latest
    lines.push({
      recordId: latest.claim.recordId ?? '',
      slot: latest.claim.slot,
      objectId: latest.claim.objectId,
      value: latest.claim.value,
      claimId: latest.claim.id,
      kind: lasting ? 'since' : 'lastStated',
      ref: refOf(reading, shown.claim.nodeId),
      nodeId: shown.claim.nodeId,
      stale: latest.claim.state === 'stale'
    })
  }
  return lines.sort(
    (a, b) =>
      a.recordId.localeCompare(b.recordId) ||
      slotRank(a.slot) - slotRank(b.slot) ||
      (a.objectId ?? '').localeCompare(b.objectId ?? '')
  )
}

/** One value on a sheet, with where it was stated. */
export interface SheetValue {
  claimId: string
  value: string
  ref: string
  nodeId: string
  para: number
  stale: boolean
}

export interface SheetLine {
  slot: Slot
  objectId: string | null
  value: SheetValue
  /** Fixed slots: other values the book gives, side by side ("grey-blue · also 'grey' 2.1"). */
  also: SheetValue[]
  /** Lasting: the scene the value holds since; transient: where it was last stated. */
  since: string | null
}

/** A line in another voice or mode: "Mara says…", remembered, supposed or dreamt. Never state. */
export interface OtherLine {
  claimId: string
  slot: Slot
  objectId: string | null
  value: string
  voice: Claim['voice']
  mode: Claim['mode']
  speakerId: string | null
  ref: string
  nodeId: string
  stale: boolean
}

export interface SheetAsOf {
  fixed: SheetLine[]
  lasting: SheetLine[]
  transient: SheetLine[]
  accumulating: SheetLine[]
  others: OtherLine[]
  /** Lines stated later in the book than the scene the sheet is read as of. */
  later: number
}

const sheetValue = (reading: ReadingOrder, entry: Placed): SheetValue => ({
  claimId: entry.claim.id,
  value: entry.claim.value,
  ref: refOf(reading, entry.claim.nodeId),
  nodeId: entry.claim.nodeId,
  para: entry.claim.para,
  stale: entry.claim.state === 'stale'
})

/**
 * One record's sheet "From the book, as of" scene `atId` (null: the end of the book; an Idea scene
 * or one left out of compile: the readable scene before it; a node that is not a manuscript scene:
 * before the book, so every line counts as later, never silently the end). `claims` are that
 * record's. Fixed: the latest value, with the others the book gives beside it.
 * Lasting: the latest value since its run began. Transient: the latest, last stated in.
 * Accumulating: every value once, in the order the book first gives it. Others: every claim in
 * another voice or mode, in reading order.
 */
export function sheetAsOf(
  claims: readonly AsOfClaim[],
  reading: ReadingOrder,
  atId: string | null
): SheetAsOf {
  const at = atId === null ? Infinity : (reading.at.get(atId) ?? -1)
  const sheet: SheetAsOf = {
    fixed: [],
    lasting: [],
    transient: [],
    accumulating: [],
    others: [],
    later: 0
  }
  const groups = new Map<string, Placed[]>()
  for (const entry of placed(claims, reading)) {
    if (entry.order > at) {
      sheet.later += 1
      continue
    }
    if (!setsState(entry.claim)) {
      const { claim } = entry
      sheet.others.push({
        claimId: claim.id,
        slot: claim.slot,
        objectId: claim.objectId,
        value: claim.value,
        voice: claim.voice,
        mode: claim.mode,
        speakerId: claim.speakerId,
        ref: refOf(reading, claim.nodeId),
        nodeId: claim.nodeId,
        stale: claim.state === 'stale'
      })
      continue
    }
    const key = groupKey(entry.claim)
    groups.set(key, [...(groups.get(key) ?? []), entry])
  }

  for (const run of groups.values()) {
    const found = lastRun(run)
    if (found === null) continue
    const { latest, start } = found
    const { slot, objectId } = latest.claim
    switch (slotGroup(slot)) {
      case 'fixed': {
        const seen = new Set([latest.claim.valueKey])
        const also: SheetValue[] = []
        for (const entry of run) {
          if (seen.has(entry.claim.valueKey)) continue
          seen.add(entry.claim.valueKey)
          also.push(sheetValue(reading, entry))
        }
        sheet.fixed.push({ slot, objectId, value: sheetValue(reading, latest), also, since: null })
        break
      }
      case 'lasting':
        sheet.lasting.push({
          slot,
          objectId,
          value: sheetValue(reading, latest),
          also: [],
          since: refOf(reading, start.claim.nodeId)
        })
        break
      case 'transient':
        sheet.transient.push({
          slot,
          objectId,
          value: sheetValue(reading, latest),
          also: [],
          since: refOf(reading, latest.claim.nodeId)
        })
        break
      case 'accumulating': {
        const seen = new Set<string>()
        for (const entry of run) {
          if (seen.has(entry.claim.valueKey)) continue
          seen.add(entry.claim.valueKey)
          sheet.accumulating.push({
            slot,
            objectId,
            value: sheetValue(reading, entry),
            also: [],
            since: null
          })
        }
        break
      }
      case 'knows':
      case 'thread':
        break
    }
  }
  const bySlot = (a: SheetLine, b: SheetLine): number => slotRank(a.slot) - slotRank(b.slot)
  sheet.fixed.sort(bySlot)
  sheet.lasting.sort(bySlot)
  sheet.transient.sort(bySlot)
  // Accumulating lines keep reading order within a slot.
  sheet.accumulating.sort(bySlot)
  return sheet
}
