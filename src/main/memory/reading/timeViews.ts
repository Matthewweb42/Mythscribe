import type { ReadingOrder } from '@shared/memory/asOf'
import { emptyCardFields, type Card, type Claim } from '@shared/memory/claims'
import { pronounPerson } from '@shared/memory/ladder'
import type { RecordKind, StoryRecordSummary } from '@shared/memory/records'
import { pinnedCanonLines } from '@shared/memory/storyNotes'
import { emptySceneDetails, type SceneDetails } from '@shared/memory/sceneDetails'
import type { HeldCard } from '@shared/memory/reproof'
import { threadsAsOf } from '@shared/memory/threadsAsOf'
import {
  TIMELINE_CARD_FIELDS,
  type AgeView,
  type SceneRefView,
  type SheetAgeView,
  type SheetThreadsView,
  type ThreadMemoryView,
  type ThreadsMemory,
  type TimelineMemory,
  type TimelineRow,
  type TimelineSourceView
} from '@shared/memory/views'
import { checkedUpTo } from '@shared/memory/whoKnows'
import { recordAge, storyYears, type AgeClaim, type StoryYear } from '@shared/memory/years'
import { searchableText } from '@shared/search'
import type { NodeRow } from '../../db/schema'
import { currentDraftId } from '../../draft/draftStore'
import { listNodes, type TreeDb } from '../../tree/treeStore'
import { dismissedKeys } from '../dismissedStore'
import { recordMentionParas } from '../nameIndexer'
import { getRecord, listRecords } from '../recordStore'
import { allSceneDetails } from '../sceneDetailStore'
import { draftCards } from './cardStore'
import { draftClaims, slotClaims } from './claimStore'
import { emptyScenes, quotesWithReadings } from './knowsViews'
import { sceneReadFlags } from './sceneReadStore'
import { listTopics } from './topicStore'
import { heldCard, hereChips, readingOrder, rowTexts } from './readingFrame'

/**
 * Threads, story years and ages as the Book and the sheets show them (F-16.23; plan P2b §5.1,
 * design §2.5 and §2.7 "Years and ages", decision 5): `threadsAsOf`, `storyYears` and `recordAge`
 * over the active draft's stores, read-only, local and free. Like who knows what, the views carry
 * only what was proved plus `checkedUpTo`; "No scene shows this thread yet (checked up to …)" is
 * worded in the renderer alone, and nothing here reaches a prompt. A year is read from the typed
 * details and the held card (the verified `year` and `flashback`, the `elapsed` hint standing on
 * the text).
 *
 * Cost (review of P2b slice 5): these run synchronously in Electron main whenever a scene moved,
 * so a scene's text is read only when its card has a field the view needs (a year, a flashback or
 * a hint; for Here also a POV or someone on the page), only the paragraphs those quotes sit in
 * are hashed (`holdingCard`), and a scene's paragraphs are parsed again only after its content
 * changed (`rowTexts`). `timeViews.perf.test.ts` holds the budget on a 90-scene book.
 */

/** One readable scene as the Timeline reads it, in reading order. */
interface SceneTime {
  nodeId: string
  ref: string
  title: string
  details: SceneDetails
  held: HeldCard | null
}

/** The card fields Here reads (beside who is on the page). */
const HERE_FIELDS = ['pov'] as const

/**
 * The part of a card a view reads: the year fields, and with `here` the POV and who is on the
 * page; null when the card has none of them (its scene's text is then never read).
 */
function cardFor(card: Card, here: boolean): Card | null {
  const fields = emptyCardFields()
  for (const name of here ? [...TIMELINE_CARD_FIELDS, ...HERE_FIELDS] : TIMELINE_CARD_FIELDS) {
    fields[name] = card.fields[name]
  }
  const present = here ? card.present : []
  const empty = Object.values(fields).every((entry) => entry === null) && present.length === 0
  return empty ? null : { ...card, fields, present }
}

/**
 * The readable scenes (not Idea, not left out of compile) in reading order, each with its typed
 * details and the part of its card the view reads (`cardFor`) as it stands on the text in the
 * active draft.
 */
function sceneTimes(
  db: TreeDb,
  reading: ReadingOrder,
  nodes: readonly NodeRow[],
  here: boolean
): SceneTime[] {
  const draftId = currentDraftId(db)
  const cards = new Map(
    (draftId === null ? [] : draftCards(db, draftId)).map((card) => [card.nodeId, card])
  )
  const details = allSceneDetails(db)
  const notRight = dismissedKeys(db, 'notRight')
  const rows = new Map(nodes.map((row) => [row.id, row]))
  return [...reading.order]
    .sort((a, b) => a[1] - b[1])
    .flatMap(([nodeId]) => {
      const row = rows.get(nodeId)
      if (row === undefined) return []
      const stored = cards.get(nodeId)
      const card = stored === undefined ? null : cardFor(stored, here)
      return [
        {
          nodeId,
          ref: reading.refs.get(nodeId) ?? '',
          title: searchableText(row.title).trim() || 'Untitled scene',
          details: details.get(nodeId) ?? emptySceneDetails(),
          held: card === null ? null : heldCard(db, card, true, notRight, rowTexts(row))
        }
      ]
    })
}

/**
 * Decision 5 over the scenes: the typed year, the held card's verified year (its own scene only)
 * and verified flashback, and its elapsed hint standing on the text (its value and its quote).
 */
function yearsOf(scenes: readonly SceneTime[]): StoryYear[] {
  return storyYears(
    scenes.map((scene) => {
      const year = scene.held?.fields.year ?? null
      const flashback = scene.held?.fields.flashback ?? null
      const elapsed = scene.held?.fields.elapsed ?? null
      return {
        nodeId: scene.nodeId,
        ref: scene.ref,
        typedYear: scene.details.storyYear,
        quotedYear: year?.verified === true ? year.value : null,
        flashback: flashback?.verified === true && flashback.value === 'yes',
        elapsed:
          elapsed === null ? null : { value: elapsed.value, quote: elapsed.quote, para: elapsed.p }
      }
    })
  )
}

/**
 * The card fields a row's year rests on, for ⓘ: the year the text states when it is the row's,
 * the flashback, the hint.
 */
function sourcesOf(scene: SceneTime, year: StoryYear | undefined): TimelineSourceView[] {
  const fields = scene.held?.fields
  if (fields === undefined || year === undefined) return []
  const sources: TimelineSourceView[] = []
  if (year.year.kind === 'quoted' && fields.year !== null) {
    sources.push({ field: 'year', entry: fields.year })
  }
  if (year.flashback && fields.flashback !== null) {
    sources.push({ field: 'flashback', entry: fields.flashback })
  }
  if (year.elapsed !== null && fields.elapsed !== null) {
    sources.push({ field: 'elapsed', entry: fields.elapsed })
  }
  return sources
}

/**
 * Every readable scene's story year over the stored book (decision 5): what the Timeline, the
 * sheets' Age and P3's navigator read.
 */
export function storedYears(
  db: TreeDb,
  reading: ReadingOrder = readingOrder(db),
  nodes: readonly NodeRow[] = listNodes(db)
): StoryYear[] {
  return yearsOf(sceneTimes(db, reading, nodes, false))
}

/** What the age rules read for every record: its `born` and `age` claims and its Pinned page. */
interface AgeSources {
  born: Map<string, AgeClaim[]>
  ages: Map<string, AgeClaim[]>
  pinned: (recordId: string) => string[]
}

const ageClaim = (claim: Claim): AgeClaim => ({
  id: claim.id,
  value: claim.value,
  voice: claim.voice,
  mode: claim.mode,
  state: claim.state,
  nodeId: claim.nodeId,
  para: claim.para
})

/** The active draft's `born` and `age` claims by record, and each record's canon Pinned lines. */
function ageSources(db: TreeDb): AgeSources {
  const draftId = currentDraftId(db)
  const born = new Map<string, AgeClaim[]>()
  const ages = new Map<string, AgeClaim[]>()
  for (const claim of draftId === null ? [] : draftClaims(db, draftId)) {
    if (claim.recordId === null || (claim.slot !== 'born' && claim.slot !== 'age')) continue
    const into = claim.slot === 'born' ? born : ages
    into.set(claim.recordId, [...(into.get(claim.recordId) ?? []), ageClaim(claim)])
  }
  const pinned = new Map<string, string[]>()
  return {
    born,
    ages,
    pinned: (recordId) => {
      const known = pinned.get(recordId)
      if (known !== undefined) return known
      const page = getRecord(db, recordId)
      const lines = page === null ? [] : pinnedCanonLines(page)
      pinned.set(recordId, lines)
      return lines
    }
  }
}

/** One record's age as of a scene (null: the end of the book), from the sources and the years. */
function ageOf(
  sources: AgeSources,
  recordId: string,
  years: readonly StoryYear[],
  reading: ReadingOrder,
  atId: string | null
): AgeView | null {
  return recordAge({
    born: sources.born.get(recordId) ?? [],
    ages: sources.ages.get(recordId) ?? [],
    pinned: sources.pinned(recordId),
    years,
    reading,
    atId
  })
}

/**
 * A character's age as of scene `atId` (null: the end of the book) over the stored book: born year
 * plus the scene's year ("about 19, year from 1.1"), else the last stated age with what changed
 * since, listed and never added up, else the birth year alone; null when the book gives neither.
 */
export function storedAge(
  db: TreeDb,
  recordId: string,
  atId: string | null,
  reading: ReadingOrder = readingOrder(db),
  nodes: readonly NodeRow[] = listNodes(db)
): AgeView | null {
  return ageOf(ageSources(db), recordId, storedYears(db, reading, nodes), reading, atId)
}

/**
 * The Book's Timeline (`memory:timeline`): one row per readable scene in reading order (Idea
 * scenes and scenes left out of compile are not rows), each with its title, its story year
 * (typed, carried from, stated here, or not known since a hint), whether it is a flashback, its
 * elapsed hint, the typed time and ages: the characters Here (the POV, those on the page, *+ also
 * here*), or, with `recordId`, that record's age in every row. A row with no known age lists none.
 */
export function timelineMemory(db: TreeDb, recordId: string | null): TimelineMemory {
  const nodes = listNodes(db)
  const reading = readingOrder(db, nodes)
  const scenes = sceneTimes(db, reading, nodes, recordId === null)
  const years = yearsOf(scenes)
  const sources = ageSources(db)
  const records = new Map(listRecords(db).map((each) => [each.id, each]))
  const rows = scenes.map((scene, i): TimelineRow => {
    const year = years[i]
    const who =
      recordId !== null
        ? [recordId]
        : hereChips(scene.details, scene.held, records)
            .map((chip) => chip.recordId)
            .filter((id) => records.get(id)?.kind === 'character')
    return {
      nodeId: scene.nodeId,
      ref: scene.ref,
      title: scene.title,
      year: year?.year ?? { kind: 'unknown', hint: null },
      flashback: year?.flashback ?? false,
      elapsed: year?.elapsed ?? null,
      time: scene.details.time.text,
      // A birth year with no year for the row says nothing the row's year does not already say.
      ages: who.flatMap((id) => {
        const age = ageOf(sources, id, years, reading, scene.nodeId)
        return age === null || age.kind === 'bornOnly' ? [] : [{ recordId: id, age }]
      }),
      sources: sourcesOf(scene, year)
    }
  })
  return { recordId, rows }
}

/** Every thread as of a scene, with "checked up to" (P2b-D9), over the active draft. */
interface StoredThreads {
  threads: ThreadMemoryView[]
  checkedUpTo: SceneRefView | null
  /** The step claims by id (their quotes and speakers: whom a first-person step is about). */
  steps: ReadonlyMap<string, Claim>
}

/**
 * Every thread record as of scene `atId` (null: the end of the book): the author's always, an
 * AI-made one while a readable scene of the active draft still holds its reveal or a step (else it
 * is in no view, as a secret no scene reveals is in no grid row); in story order (where it opened,
 * else where it was revealed; the author's threads with neither last, by label).
 */
function storedThreads(
  db: TreeDb,
  atId: string | null,
  reading: ReadingOrder,
  nodes: readonly NodeRow[]
): StoredThreads {
  const draftId = currentDraftId(db)
  const claims = draftId === null ? [] : slotClaims(db, 'thread', draftId)
  const views = threadsAsOf({
    threads: listTopics(db, 'thread').map(({ recordId, label, origin }) => ({
      recordId,
      label,
      origin
    })),
    claims,
    quotes: draftId === null ? [] : quotesWithReadings(db, draftId),
    reading,
    atId
  })
  const orderOf = (thread: ThreadMemoryView): number => {
    const at = thread.opened ?? thread.defining ?? thread.steps[0] ?? null
    return at === null ? Infinity : (reading.order.get(at.nodeId) ?? Infinity)
  }
  const threads = views
    .filter(
      (thread) =>
        thread.origin === 'author' ||
        thread.defining !== null ||
        thread.merged.length > 0 ||
        thread.steps.length > 0 ||
        thread.later > 0
    )
    .sort((a, b) => orderOf(a) - orderOf(b) || a.label.localeCompare(b.label))
  return {
    threads,
    checkedUpTo: checkedUpTo(
      reading,
      draftId === null ? new Map() : sceneReadFlags(db, draftId),
      atId,
      emptyScenes(nodes, reading)
    ),
    steps: new Map(claims.map((claim) => [claim.id, claim]))
  }
}

/** The Book's Threads as of scene `asOf` (`memory:threads`; null: the end of the book). */
export function threadsMemory(db: TreeDb, asOf: string | null): ThreadsMemory {
  const nodes = listNodes(db)
  const reading = readingOrder(db, nodes)
  const { threads, checkedUpTo: checked } = storedThreads(db, asOf, reading, nodes)
  return {
    asOf,
    asOfRef: asOf === null || !reading.at.has(asOf) ? null : (reading.refs.get(asOf) ?? null),
    checkedUpTo: checked,
    threads
  }
}

/** What a sheet shows of threads and time (F-16.23), as of the sheet's scene. */
export interface SheetTime {
  threads: SheetThreadsView | null
  age: SheetAgeView | null
  thread: { thread: ThreadMemoryView; checkedUpTo: SceneRefView | null } | null
}

/**
 * Each scene's POV as Here takes it (`hereChips`: the card's verified POV standing on the text,
 * else the typed one), read only for the scenes asked about.
 */
function scenePovs(
  db: TreeDb,
  nodeIds: ReadonlySet<string>,
  nodes: readonly NodeRow[]
): Map<string, string | null> {
  const povs = new Map<string, string | null>()
  if (nodeIds.size === 0) return povs
  const draftId = currentDraftId(db)
  const details = allSceneDetails(db)
  const records = new Map<string, Pick<StoryRecordSummary, 'kind'>>(
    listRecords(db).map((each) => [each.id, each])
  )
  const cards = new Map(
    (draftId === null ? [] : draftCards(db, draftId)).map((card) => [card.nodeId, card])
  )
  const notRight = dismissedKeys(db, 'notRight')
  for (const row of nodes) {
    if (!nodeIds.has(row.id)) continue
    const stored = cards.get(row.id)
    const pov = stored?.fields.pov ?? null
    const card =
      stored === undefined || pov === null
        ? null
        : { ...stored, fields: { ...emptyCardFields(), pov }, present: [] }
    const held = card === null ? null : heldCard(db, card, true, notRight, rowTexts(row))
    const first = hereChips(details.get(row.id) ?? emptySceneDetails(), held, records)[0]
    povs.set(row.id, first?.why === 'pov' ? first.recordId : null)
  }
  return povs
}

/**
 * Whether a thread step is about `recordId` in the first person (review of P2b slice 5): its
 * quote says "I" (or "we") and it is the narration (or a thought with no speaker) of a scene whose
 * POV is the record, or the record's own dialogue or thought. A first-person book's POV never
 * names herself.
 */
function firstPersonOf(
  claim: Claim | undefined,
  recordId: string,
  pov: string | null | undefined
): boolean {
  if (claim === undefined || pronounPerson(claim.quote) !== 'first') return false
  if (claim.voice === 'narration' || (claim.voice === 'thought' && claim.speakerId === null)) {
    return pov === recordId
  }
  return (claim.voice === 'dialogue' || claim.voice === 'thought') && claim.speakerId === recordId
}

/**
 * A record's threads and age as of scene `atId` for its sheet: a named record's Threads (each
 * thread with a step as of the scene whose paragraph names it for certain, or that is about it in
 * the first person, its steps narrowed to those, its status its own), a character's Age with
 * "checked up to", a thread's own view (status, steps, reveals, "checked up to"). Nothing for a
 * secret.
 */
export function sheetTime(
  db: TreeDb,
  recordId: string,
  kind: RecordKind | null,
  atId: string | null,
  reading: ReadingOrder,
  nodes: readonly NodeRow[]
): SheetTime {
  if (kind === null || kind === 'secret') return { threads: null, age: null, thread: null }
  const stored = storedThreads(db, atId, reading, nodes)
  if (kind === 'thread') {
    const thread = stored.threads.find((each) => each.recordId === recordId) ?? null
    return {
      threads: null,
      age: null,
      thread: thread === null ? null : { thread, checkedUpTo: stored.checkedUpTo }
    }
  }
  const named = recordMentionParas(db, recordId)
  const unnamed = stored.threads.flatMap((thread) =>
    thread.steps.filter((step) => !named.has(`${step.nodeId}|${step.para}`))
  )
  const firstPerson = unnamed.filter(
    (step) => pronounPerson(stored.steps.get(step.claimId)?.quote ?? '') === 'first'
  )
  const povs = scenePovs(db, new Set(firstPerson.map((step) => step.nodeId)), nodes)
  const threads = stored.threads.flatMap((thread) => {
    const steps = thread.steps.filter(
      (step) =>
        named.has(`${step.nodeId}|${step.para}`) ||
        firstPersonOf(stored.steps.get(step.claimId), recordId, povs.get(step.nodeId))
    )
    return steps.length === 0 ? [] : [{ ...thread, steps }]
  })
  return {
    threads: { threads, checkedUpTo: stored.checkedUpTo },
    age:
      kind === 'character'
        ? {
            age: storedAge(db, recordId, atId, reading, nodes),
            checkedUpTo: stored.checkedUpTo
          }
        : null,
    thread: null
  }
}
