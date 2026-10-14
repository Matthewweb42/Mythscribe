import { holdsSlotCue, type AskIndex, type InstantShape } from '@shared/memory/askParse'
import type { Claim } from '@shared/memory/claims'
import { gateSentences, readSetOf, unreadSentences } from '@shared/memory/gate'
import { KNOWER_KINDS } from '@shared/memory/knows'
import { pageTextBlocks } from '@shared/memory/pageMarks'
import { queryTerms } from '@shared/searchTerms'
import { slotGroup, type Slot } from '@shared/memory/slots'
import { detailsAgree } from '@shared/memory/typedVsText'
import type { SheetLineView } from '@shared/memory/views'
import type { EvidenceKey, InstantCard } from '@shared/scribe'
import { findingsOf } from '../memory/findings/findingStore'
import { nameScanShared } from '../memory/nameIndexer'
import { getAiSettings } from '../project/settingsStore'
import { getClaim, recordClaims } from '../memory/reading/claimStore'
import { storedKnows } from '../memory/reading/knowsViews'
import { rowTexts } from '../memory/reading/readingFrame'
import { getSceneRead, sceneReadFlags } from '../memory/reading/sceneReadStore'
import { sheetMemory } from '../memory/reading/views'
import { type TreeDb } from '../tree/treeStore'
import { evidenceFrame, frameRecord, type EvidenceFrame } from './evidence'
import { askIndexOf } from './step0'

/**
 * Instant cards (F-16.24; design §2.6, plan P3 §1.3): a question the memory already answers gets
 * its card with no AI call, from a live and uncontested claim as of now. A record's slot ("Mara's
 * eyes?"), "does A know X" (only ever yes: a partial line or none hands over, the card never says
 * no), and "who knows X" (the holders as of now, a partial line among them as the sheet lists it,
 * readers-since and `checkedUpTo`, from which the renderer alone words the scoped absence line,
 * P2b rule 9). Before any card, an unread finished
 * sentence that bears on the question asks for that window to be read first (P3-D4); a stale or
 * contested value hands over to Ms Scribe as a lookup turn with that slot's evidence (P3-D5).
 * Read-only: nothing here writes.
 */

/**
 * Why a question goes to Ms Scribe instead: a stale claim (or a stated age with time passed
 * since), incompatible values, nothing, or not yes.
 */
export type Handover = 'stale' | 'contested' | 'none' | 'no'

export type InstantOutcome =
  { card: InstantCard } | { readFirst: string[] } | { handover: Handover; keys: EvidenceKey[] }

/** The most scenes besides the open one read-first looks at (P3-D4). */
export const READ_FIRST_SCENES = 2

/**
 * Whether a slot's value as of now is contested (P3-D3): any claim of the record and slot as of
 * now is stale (`stale`), or a fixed slot gives another value that neither contains (`contested`;
 * "grey" and "grey-blue" agree). A value later in the book never contests. P4-D25: an open
 * finding on the record and slot (`openFinding`) contests it too, so Ms Scribe answers with both
 * sides instead of a card.
 */
export function contested(
  line: SheetLineView,
  claims: readonly Pick<Claim, 'state'>[],
  openFinding = false
): 'stale' | 'contested' | null {
  if (line.value.stale || claims.some((claim) => claim.state === 'stale')) return 'stale'
  if (openFinding) return 'contested'
  if (slotGroup(line.slot) !== 'fixed') return null
  return line.also.some((other) => !detailsAgree(other.value, line.value.value))
    ? 'contested'
    : null
}

/**
 * The rules whose open findings contest a slot's instant card (P4-D25): C1, C6, and for an age C4
 * and C1 or C6 on the birth year it is computed from.
 */
const CONTESTING_RULES = ['C1', 'C6'] as const

/**
 * Whether an open finding of the active draft names the record and slot (C1 or C6 on that slot;
 * for `age`, C4, or C1 or C6 on `born`, since a disputed birth year disputes the age computed from
 * it), while the Contradiction check is on (off, findings are hidden everywhere, P4-D21).
 */
export function openFindingOn(
  db: TreeDb,
  draftId: string | null,
  recordId: string,
  slot: Slot
): boolean {
  if (draftId === null || !getAiSettings(db).features.judge) return false
  return findingsOf(db, draftId, ['open']).some(
    (finding) =>
      finding.recordId === recordId &&
      ((slot === 'age' && finding.rule === 'C4') ||
        ((finding.slot === slot || (slot === 'age' && finding.slot === 'born')) &&
          (CONTESTING_RULES as readonly string[]).includes(finding.rule)))
  )
}

/** The record ids a gate text's name tokens hold (`⟨a|b⟩`). */
const namedIn = (gate: string): Set<string> =>
  new Set([...gate.matchAll(/⟨([^⟩]*)⟩/gu)].flatMap((match) => (match[1] ?? '').split('|')))

/**
 * The scenes whose unread finished sentences bear on a question (P3-D4): the open scene and at
 * most two earlier scenes the reader left unsettled, where a sentence not in the read set
 * (`unreadSentences`) names the record (when there is one) and holds the cue. `caretPara` is the
 * open scene's caret paragraph: while it has no closing punctuation it is still being written, and
 * is no reason to read.
 */
export function unreadNaming(
  db: TreeDb,
  frame: EvidenceFrame,
  recordId: string | null,
  cue: (sentence: string) => boolean,
  caretPara: number | null = null
): string[] {
  if (frame.draftId === null || frame.nowId === null) return []
  const draftId = frame.draftId
  const now = frame.reading.at.get(frame.nowId) ?? -1
  const unsettled = [...sceneReadFlags(db, draftId).entries()]
    .filter(([nodeId, flags]) => {
      const order = frame.reading.order.get(nodeId)
      return !flags.settled && nodeId !== frame.nowId && order !== undefined && order <= now
    })
    .sort((a, b) => (frame.reading.order.get(b[0]) ?? 0) - (frame.reading.order.get(a[0]) ?? 0))
    .slice(0, READ_FIRST_SCENES)
    .map(([nodeId]) => nodeId)
  const names = nameScanShared(db).index
  const due: string[] = []
  for (const nodeId of [frame.nowId, ...unsettled]) {
    const row = frame.documents.get(nodeId)
    if (row === undefined || !frame.reading.order.has(nodeId)) continue
    const current = gateSentences(rowTexts(row), {
      caretPara: nodeId === frame.nowId ? caretPara : null,
      names
    })
    const read = getSceneRead(db, nodeId, draftId)
    const unread =
      read === null ? current : unreadSentences(current, readSetOf(read.entries, names))
    if (
      unread.some(
        (sentence) =>
          (recordId === null || namedIn(sentence.gate).has(recordId)) && cue(sentence.text)
      )
    ) {
      due.push(nodeId)
    }
  }
  return due
}

/** The order of a claim's scene, or Infinity outside the readable book. */
const orderOf = (frame: EvidenceFrame, nodeId: string): number =>
  frame.reading.order.get(nodeId) ?? Infinity

/**
 * The evidence a slot lookup hands Ms Scribe (P3-D5): the slot's claims as of now, live and stale
 * (their paragraphs as they read now, each worded with its voice and mode), and the record's
 * Pinned paragraphs that bear on the slot (`holdsSlotCue`: "Home: Vell" for where she is).
 */
function slotKeys(
  frame: EvidenceFrame,
  recordId: string,
  slot: Slot,
  claims: readonly Claim[]
): EvidenceKey[] {
  const keys: EvidenceKey[] = claims.map((claim) => ({ kind: 'claim', claimId: claim.id }))
  const pinned = frameRecord(frame, recordId)?.pinned ?? null
  for (const block of pinned === null ? [] : pageTextBlocks(pinned)) {
    if (holdsSlotCue(block.text, slot)) {
      keys.push({ kind: 'passage', source: 'pinned', ownerId: recordId, para: block.index })
    }
  }
  return keys
}

/** The words of a secret's label a sentence may hold to bear on it (names left out). */
const secretWords = (ask: AskIndex, secretId: string): string[] =>
  (ask.topics.find((topic) => topic.recordId === secretId)?.terms ?? []).filter(
    (term) => !term.startsWith('@')
  )

const holdsWords =
  (words: readonly string[]) =>
  (sentence: string): boolean => {
    const terms = new Set(queryTerms(sentence))
    return words.some((word) => terms.has(word))
  }

/**
 * Whether an unread sentence naming the record bears on `slot` (P3-D4): any such sentence for a
 * transient slot (where she is, what she wears or carries, how she is hurt: prose moves her
 * without naming the slot, "Mara rode north to Vell"); else one with the slot's words in prose
 * ("died", "eyes", "promoted"; `holdsSlotCue`).
 */
export const bearsOnSlot =
  (slot: Slot) =>
  (sentence: string): boolean =>
    slotGroup(slot) === 'transient' || holdsSlotCue(sentence, slot)

/**
 * The instant answer to a question of `shape` as of now (`nowId`: the open scene, else the latest
 * written): a card, the scenes to read first, or a handover with its evidence. `checkUnread`
 * false skips read-first (after the read ran, so a window it could not read never loops);
 * `caretPara` is the open scene's caret paragraph (an unfinished one is not read first). An age
 * is answered from the age as of now (decision 5): computed from a birth year and the story year
 * is a card; a stated age only when no time has passed since; otherwise Ms Scribe words it.
 */
export function instantCard(
  db: TreeDb,
  shape: InstantShape,
  nowId: string | null,
  options: {
    ask?: AskIndex
    checkUnread?: boolean
    frame?: EvidenceFrame
    caretPara?: number | null
  } = {}
): InstantOutcome {
  const frame = options.frame ?? evidenceFrame(db, nowId)
  const checkUnread = options.checkUnread ?? true
  const caretPara = options.caretPara ?? null
  const asOfRef = nowId === null ? null : (frame.reading.refs.get(nowId) ?? null)
  const now = nowId === null ? Infinity : (frame.reading.at.get(nowId) ?? -1)

  if (shape.kind === 'slot') {
    const record = frameRecord(frame, shape.recordId)
    if (record === null) return { handover: 'none', keys: [] }
    if (checkUnread) {
      const due = unreadNaming(db, frame, shape.recordId, bearsOnSlot(shape.slot), caretPara)
      if (due.length > 0) return { readFirst: due }
    }
    const claims =
      frame.draftId === null
        ? []
        : recordClaims(db, shape.recordId, frame.draftId).filter(
            (claim) =>
              claim.slot === shape.slot &&
              claim.state !== 'waiting' &&
              orderOf(frame, claim.nodeId) <= now
          )
    const keys = slotKeys(frame, shape.recordId, shape.slot, claims)
    // P4-D25: a possible contradiction on the slot is Ms Scribe's to answer, with both sides.
    const disputed = openFindingOn(db, frame.draftId, shape.recordId, shape.slot)
    const sheet = sheetMemory(db, shape.recordId, nowId)
    const age = shape.slot === 'age' ? (sheet.age?.age ?? null) : null
    if (age !== null) {
      const timeline: EvidenceKey = { kind: 'timeline', recordId: shape.recordId }
      if (disputed) return { handover: 'contested', keys: [...keys, timeline] }
      switch (age.kind) {
        case 'computed': {
          // A birth year read from a sentence that changed since is re-checking: no card.
          const born = age.born.claimId === null ? null : getClaim(db, age.born.claimId)
          if (born?.state === 'stale') {
            return {
              handover: 'stale',
              keys: [...keys, { kind: 'claim', claimId: born.id }, timeline]
            }
          }
          return {
            card: {
              kind: 'age',
              recordId: record.id,
              name: record.name,
              age: age.age,
              born: age.born,
              year: age.year,
              asOfRef,
              readFirst: null
            }
          }
        }
        case 'notBorn':
        case 'bornOnly':
          return { handover: 'none', keys: [...keys, timeline] }
        case 'stated':
          // Time has passed since it was stated: never shown as current (decision 5).
          if (age.since.length > 0) return { handover: 'stale', keys: [...keys, timeline] }
          break
      }
    }
    const group = slotGroup(shape.slot)
    const lines =
      group === 'fixed'
        ? sheet.fixed
        : group === 'lasting'
          ? sheet.lasting
          : group === 'transient'
            ? sheet.transient
            : []
    const line = lines.find((each) => each.slot === shape.slot && each.objectId === null)
    if (line === undefined) return { handover: 'none', keys }
    const doubt = contested(line, claims, disputed)
    if (doubt !== null) return { handover: doubt, keys }
    const claim = getClaim(db, line.value.claimId)
    if (claim === null) return { handover: 'none', keys }
    return {
      card: {
        kind: 'slot',
        recordId: record.id,
        name: record.name,
        slot: shape.slot,
        label: line.label,
        value: line.value.value,
        claimId: claim.id,
        quote: claim.quote,
        ref: line.value.ref,
        nodeId: line.value.nodeId,
        para: line.value.para,
        since: group === 'fixed' ? null : (line.since ?? line.value.ref),
        lastStated: group === 'transient',
        asOfRef,
        readFirst: null
      }
    }
  }

  const keys: EvidenceKey[] = [{ kind: 'knows', secretId: shape.secretId }]
  const secretRecord = frameRecord(frame, shape.secretId)
  if (secretRecord?.kind !== 'secret') return { handover: 'none', keys: [] }
  const ask = options.ask ?? askIndexOf(db)
  const words = secretWords(ask, shape.secretId)

  if (shape.kind === 'knows') {
    const knower = frameRecord(frame, shape.knowerId)
    if (knower === null || !KNOWER_KINDS.includes(knower.kind)) return { handover: 'none', keys }
    if (checkUnread && words.length > 0) {
      const due = unreadNaming(db, frame, shape.knowerId, holdsWords(words), caretPara)
      if (due.length > 0) return { readFirst: due }
    }
    const knows = storedKnows(db, nowId, frame.reading, frame.nodes)
    const secret = knows.secrets.find((each) => each.recordId === shape.secretId)
    const cell = secret?.cells.find((each) => each.knowerId === shape.knowerId)
    // Only yes is instant: a partial line, a later one, or none goes to Ms Scribe.
    if (secret === undefined || cell === undefined || cell.later || cell.line !== 'counts') {
      return { handover: 'no', keys }
    }
    if (cell.stale) return { handover: 'stale', keys }
    const claim = cell.claimId === null ? null : getClaim(db, cell.claimId)
    return {
      card: {
        kind: 'knows',
        secretId: secret.recordId,
        secretLabel: secret.label,
        knowerId: knower.id,
        knowerName: knower.name,
        how: cell.how,
        source: cell.source,
        fromName: cell.fromId === null ? null : (frameRecord(frame, cell.fromId)?.name ?? null),
        claimId: claim?.id ?? null,
        quote: claim?.quote ?? null,
        ref: cell.ref,
        nodeId: cell.nodeId,
        para: cell.para,
        asOfRef,
        readFirst: null
      }
    }
  }

  if (checkUnread && words.length > 0) {
    const due = unreadNaming(db, frame, null, holdsWords(words), caretPara)
    if (due.length > 0) return { readFirst: due }
  }
  const knows = storedKnows(db, nowId, frame.reading, frame.nodes)
  const secret = knows.secrets.find((each) => each.recordId === shape.secretId)
  if (secret === undefined) return { handover: 'none', keys }
  // Every holder as of now, as the secret's sheet lists them: a partial line (suspects, believes
  // otherwise) too, which the card draws muted; the scoped absence line covers the rest only.
  const holders = secret.cells.filter((cell) => !cell.later)
  if (holders.some((cell) => cell.stale)) return { handover: 'stale', keys }
  // Readers-since resting on evidence being re-checked is no instant value either (P3-D5).
  if (secret.known && (secret.knownStale || secret.readersSince?.stale === true)) {
    return { handover: 'stale', keys }
  }
  // Nobody shown knowing it and nothing checked yet: Ms Scribe looks instead.
  if (holders.length === 0 && knows.checkedUpTo === null) return { handover: 'none', keys }
  return {
    card: {
      kind: 'whoKnows',
      secretId: secret.recordId,
      label: secret.label,
      // Readers-since only once readers know it as of now: a later reveal is not shown early.
      readersSince:
        secret.readersSince === null || !secret.known
          ? null
          : { nodeId: secret.readersSince.nodeId, ref: secret.readersSince.ref },
      holders,
      checkedUpTo: knows.checkedUpTo,
      asOfRef,
      readFirst: null
    }
  }
}
