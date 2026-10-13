import { and, asc, eq } from 'drizzle-orm'
import type { AgentStep } from '@shared/agent'
import { namesInQuestion, type AskIndex } from '@shared/memory/askParse'
import { markedParagraphs, pageTextBlocks } from '@shared/memory/pageMarks'
import { normName } from '@shared/memory/names'
import type { PassageSource } from '@shared/memory/passages'
import type { StoryRecord, StoryRecordSummary } from '@shared/memory/records'
import { meaningOf, type MemorySource } from '@shared/memory/sources'
import { isNamedKind } from '@shared/memory/topics'
import {
  NAVIGATION_TERMS_MAX,
  NAVIGATOR_MENU_HITS,
  type EvidenceKey,
  type SearchScope
} from '@shared/scribe'
import { searchableText } from '@shared/search'
import type { TiptapNodeT } from '@shared/tiptap'
import { nameMention, sceneDetail } from '../db/schema'
import type { AgentProject } from '../ai/agentTools'
import { nowIndex, readingIndex } from '../ai/agentRefs'
import { NAVIGATOR_READS_MAX, type NavigatorCall } from '../ai/prompts/navigator.v1'
import { hereTest, promptCard } from '../memory/reading/cardContext'
import { rowTexts } from '../memory/reading/readingFrame'
import { sheetMemory } from '../memory/reading/views'
import { sceneStatuses, searchMemoryPassages } from '../memory/passageIndexer'
import { listRecords } from '../memory/recordStore'
import { researchDocOf } from '../research/researchStore'
import { isUnderResearch } from '../research/researchTree'
import { estimateTokens } from '@shared/ai'
import { frameRecord, parseDoc, type EvidenceFrame } from './evidence'
import { resolveNeed } from './selfRoute'
import {
  type EvidenceMenu,
  knowsLineText,
  ORDINAL_OTHER_HITS,
  orderedSceneSearch,
  OTHER_SOURCES,
  recordDigest,
  type MenuItem,
  type Step0
} from './step0'

/**
 * Ms Scribe's navigator tools (F-16.25; plan P3 §4.2, P3-D6): what `navigator.v1` can call, each
 * adding items to the evidence menu (new E ids, never prose) and a step label for the chat. `search`
 * is the passage index (`memory_passage_fts`, porter stemming) with the navigator's own synonyms,
 * every source but cards; on a first/last/ever/never/how-many/knows question it searches every
 * scene up to now in reading order (P3-D8) and records the scope. `cards` reads scene cards (maps,
 * never citable); `read` a scene or a part of one, a record's Pinned or Ideas, or a Research page
 * (F-16.8: Ms Scribe reads Research from P3); `state` a record's live values, what it knows, its
 * threads and age, its Pinned lines and where the book names it; `knows` a secret's holders or what
 * a person knows (positive lines only: absence is never a line, P2b rule 9); `timeline` the story
 * years or an age; `ideas` the author's Ideas; `outline` and `todos`. Every paragraph a call returns
 * joins the search-miss baseline. Read-only and local.
 *
 * The story-memory read helpers of `agent.v8`'s v2 tools live here too (P3-D18: one
 * implementation): the record a name points at, the scenes that name it, whether a scene is real,
 * and a record's state as `lookup` shows it (`agentToolsV2.ts` renders them for agent.v8 until the
 * switch-over).
 */

/** The marks the v6 rules read: `[canon]` the story as written, `[plan]`, `[idea]` never real. */
export type V2Mark = '[canon]' | '[plan]' | '[idea]'

/** What a labelled passage reads as for agent.v8, by where it is (design §2.2). */
export function passageMark(label: MemorySource): V2Mark {
  const meaning = meaningOf(label, { order: 0, openOrder: 0 })
  // A card line (F-16.18) is a map, never the book: the search leaves cards out unless asked
  // (`DEFAULT_PASSAGE_SOURCES`), and one that reaches here is never marked as canon.
  if (meaning === 'plan' || meaning === 'map') return '[plan]'
  if (meaning === 'never') return '[idea]'
  return '[canon]'
}

/** The run's records, read once. */
export function recordsOf(project: AgentProject): StoryRecordSummary[] {
  project.records ??= listRecords(project.db)
  return project.records
}

/** A name's words, as a whole-word match reads them. */
const wordsOf = (text: string): string[] =>
  text.split(/[^\p{L}\p{N}'’]+/u).filter((word) => word !== '')

/** Whether `part`'s words are words of `whole`, next to each other ("voss" in "mara voss"). */
function holdsWords(whole: string, part: string): boolean {
  const all = wordsOf(whole)
  const want = wordsOf(part)
  if (want.length === 0) return false
  for (let at = 0; at + want.length <= all.length; at++) {
    if (want.every((word, i) => all[at + i] === word)) return true
  }
  return false
}

/**
 * The record a name points at: one whose name or nickname is the name (after `normName`), else
 * the only one whose name holds it. `words` (the navigator's tools, which read names a model
 * wrote) takes only a whole-word part of a name or nickname, so "Ann" is never "Joanna"; agent.v8's
 * v2 tools keep the loose fallback until F-16.31.
 */
export function recordByNameV2(
  project: AgentProject,
  name: unknown,
  partial: 'any' | 'words' = 'any'
): StoryRecordSummary | undefined {
  if (typeof name !== 'string') return undefined
  const norm = normName(name)
  if (norm === '') return undefined
  const records = recordsOf(project)
  const exact = records.filter((each) => each.aliases.some((alias) => alias.norm === norm))
  if (exact.length === 1) return exact[0]
  const main = exact.find((each) => normName(each.name) === norm)
  if (main !== undefined) return main
  const holds =
    partial === 'words'
      ? records.filter((each) =>
          [normName(each.name), ...each.aliases.map((alias) => alias.norm)].some((whole) =>
            holdsWords(whole, norm)
          )
        )
      : records.filter((each) => normName(each.name).includes(norm))
  return holds.length === 1 ? holds[0] : undefined
}

/** Whether a scene is an Idea scene or one left out of compile (design §2.2: never real). */
export function unrealScenes(project: AgentProject): (nodeId: string) => boolean {
  const statuses = sceneStatuses(project.db)
  return (nodeId) => statuses.idea.has(nodeId) || statuses.excluded.has(nodeId)
}

/**
 * The scenes of the run that name a record for certain, in reading order, with the paragraphs;
 * `real` is false for an Idea scene or one left out of compile (design §2.2: never real).
 */
export function scenesNaming(
  project: AgentProject,
  recordId: string
): { nodeId: string; paras: number[]; real: boolean }[] {
  const rows = project.db
    .select({ nodeId: nameMention.nodeId, para: nameMention.para })
    .from(nameMention)
    .where(and(eq(nameMention.recordId, recordId), eq(nameMention.ambiguous, false)))
    .orderBy(asc(nameMention.para))
    .all()
  const byScene = new Map<string, number[]>()
  for (const row of rows) {
    if (!project.refOf.has(row.nodeId)) continue
    const paras = byScene.get(row.nodeId) ?? []
    if (!paras.includes(row.para)) paras.push(row.para)
    byScene.set(row.nodeId, paras)
  }
  const statuses = sceneStatuses(project.db)
  return [...byScene.entries()]
    .map(([nodeId, paras]) => ({
      nodeId,
      paras,
      real: !statuses.idea.has(nodeId) && !statuses.excluded.has(nodeId)
    }))
    .filter((each) => readingIndex(project, each.nodeId) < project.time.order.length)
    .sort((a, b) => readingIndex(project, a.nodeId) - readingIndex(project, b.nodeId))
}

/** A scene a record is the typed POV of, with its typed place, time and year. */
export interface PovScene {
  nodeId: string
  place: string
  time: string
  year: number | null
}

/**
 * A record as `lookup` (agent.v8) and `state` (navigator.v1) read it: its other names; its Pinned
 * paragraphs (Not canon ones marked) and Ideas, by page index; the scenes it is the typed POV of;
 * where the book names it (real scenes, and Idea or cut ones apart); the last scene up to now where
 * it is Here and the last that only names it (each with its card). Read-only.
 */
export interface RecordState {
  record: StoryRecord
  others: string[]
  pinned: { index: number; text: string; notCanon: boolean }[]
  ideas: { index: number; text: string }[]
  pov: PovScene[]
  named: { nodeId: string; paras: number[] }[]
  /** How many of `named` are up to now. */
  upToNow: number
  unreal: string[]
  seen: string | null
  lastNamed: string | null
}

function pageParagraphs(
  page: TiptapNodeT | null
): { index: number; text: string; notCanon: boolean }[] {
  if (page === null) return []
  return pageTextBlocks(page)
    .map(({ index, text, notCanon }) => ({ index, text: text.trim(), notCanon }))
    .filter((paragraph) => paragraph.text !== '')
}

export function recordState(project: AgentProject, record: StoryRecord): RecordState {
  const names = new Map(recordsOf(project).map((each) => [each.id, each.name]))
  const pov = project.db
    .select()
    .from(sceneDetail)
    .where(eq(sceneDetail.povRecordId, record.id))
    .all()
    .filter((row) => project.refOf.has(row.nodeId))
    .sort((a, b) => readingIndex(project, a.nodeId) - readingIndex(project, b.nodeId))
    .map((row) => ({
      nodeId: row.nodeId,
      place:
        row.placeRecordId === null ? row.placeText.trim() : (names.get(row.placeRecordId) ?? ''),
      time: row.timeText.trim(),
      year: row.storyYear
    }))
  const naming = scenesNaming(project, record.id)
  const named = naming.filter((each) => each.real)
  const now = nowIndex(project)
  const before = [...named].reverse().filter((each) => readingIndex(project, each.nodeId) <= now)
  const isHere = hereTest(project.db)
  const seen = before.find((each) => isHere(each.nodeId, record.id))?.nodeId ?? null
  const lastNamed = before[0]?.nodeId ?? null
  return {
    record,
    others: record.aliases.filter((alias) => !alias.isMain).map((alias) => alias.text),
    pinned: pageParagraphs(record.pinned),
    ideas: pageParagraphs(record.ideas).map(({ index, text }) => ({ index, text })),
    pov,
    named: named.map(({ nodeId, paras }) => ({ nodeId, paras })),
    upToNow: before.length,
    unreal: naming.filter((each) => !each.real).map((each) => each.nodeId),
    seen,
    lastNamed: lastNamed === seen ? null : lastNamed
  }
}

// ---- The navigator's tools --------------------------------------------------------------------

/** The most items one call adds (a read of a page, a person's secrets, the cards of a range). */
export const NAVIGATOR_TOOL_ITEMS = 8
/** A scene read's paragraphs, at most this many tokens from where it starts. */
export const NAVIGATOR_READ_TOKENS = 1_500
/** The longest step label (`AgentStep.label`). */
const LABEL_MAX = 120

/** What one navigation reads the book with, built once per message. */
export interface NavigatorWorld {
  project: AgentProject
  frame: EvidenceFrame
  ask: AskIndex
  step0: Pick<Step0, 'nowId' | 'cues' | 'ordinal' | 'latest' | 'groups'>
  menu: EvidenceMenu
  /** Every word the navigator searched for, in order. */
  terms: string[]
  /** The scope of its every-earlier-scene search, when it ran one. */
  scope: SearchScope | null
  reads: number
}

/** What one call did: the chat's step, the items it added, and a note for the next step. */
export interface ToolRun {
  step: AgentStep
  added: MenuItem[]
  note: string | null
}

const clip = (text: string): string =>
  text.length > LABEL_MAX ? `${text.slice(0, LABEL_MAX - 1).trimEnd()}…` : text

const added = (items: readonly (MenuItem | null)[]): MenuItem[] =>
  items.filter((item): item is MenuItem => item !== null)

/**
 * Adds candidates in order until `cap` were new: one already on the menu (or gone now) is skipped,
 * and none past the cap reaches the menu, so every E id a call makes is one the navigator is shown.
 */
function addUpTo<T>(
  candidates: readonly T[],
  cap: number,
  add: (each: T) => MenuItem | null
): MenuItem[] {
  const out: MenuItem[] = []
  for (const each of candidates) {
    if (out.length >= cap) break
    const item = add(each)
    if (item !== null) out.push(item)
  }
  return out
}

/** The Research document a title names, or undefined. */
function researchByTitle(world: NavigatorWorld, title: string): string | undefined {
  const want = title
    .trim()
    .toLowerCase()
    .replace(/^["“'‘]|["”'’]$/gu, '')
  return world.frame.nodes.find(
    (row) =>
      row.kind === 'document' &&
      searchableText(row.title).trim().toLowerCase() === want &&
      isUnderResearch(world.frame.db, row)
  )?.id
}

/** A record a tool names, with its pages; null when the name is no record. */
function recordNamed(world: NavigatorWorld, name: string): StoryRecord | null {
  const summary = recordByNameV2(world.project, name, 'words')
  return summary === undefined ? null : frameRecord(world.frame, summary.id)
}

/** The secret a `knows` call names: by its label or name, else by half its words (`namesInQuestion`). */
function secretNamed(world: NavigatorWorld, text: string): string | null {
  const direct = recordNamed(world, text)
  if (direct?.kind === 'secret') return direct.id
  const topic = namesInQuestion(text, world.ask).topics.find((each) => each.kind === 'secret')
  return topic?.recordId ?? null
}

const nameOf =
  (world: NavigatorWorld) =>
  (id: string | null): string =>
    id === null ? '' : (frameRecord(world.frame, id)?.name ?? '')

/**
 * `search`: the words (the navigator's synonyms and word forms), best first by bm25 over every
 * source but cards; on a question Step 0 found asks for every earlier scene, every scene up to
 * now (or the whole book) in reading order with the other sources' best beside them, and the
 * scope recorded (P3-D8).
 */
function search(world: NavigatorWorld, terms: string[]): ToolRun {
  world.terms = [...new Set([...world.terms, ...terms])].slice(0, NAVIGATION_TERMS_MAX)
  const step: AgentStep = { tool: 'search', label: clip(`Searching '${terms.join(', ')}'…`) }
  const { db, nodes } = world.frame
  if (world.step0.ordinal) {
    const found = orderedSceneSearch(db, world.frame, {
      search: terms,
      terms: world.terms,
      groups: world.step0.groups,
      wholeBook: world.step0.cues.wholeBook,
      latest: world.step0.latest
    })
    world.scope = found.scope
    world.menu.addHits(found.matched)
    const others = searchMemoryPassages(db, terms.join(' '), {
      sources: OTHER_SOURCES,
      limit: ORDINAL_OTHER_HITS,
      nodes
    })
    const items = added([...found.hits, ...others].map((hit) => world.menu.addHit(hit)))
    return { step, added: items, note: items.length === 0 ? nothingNew(terms) : null }
  }
  const hits = searchMemoryPassages(db, terms.join(' '), { limit: NAVIGATOR_MENU_HITS, nodes })
  const items = added(hits.map((hit) => world.menu.addHit(hit)))
  return { step, added: items, note: items.length === 0 ? nothingNew(terms) : null }
}

const nothingNew = (terms: readonly string[]): string =>
  `No new passage matches ${terms.join(', ')}.`

/** The readable scenes a range, a scene, a chapter or a title names (`resolveNeed`). */
function scenesNamed(world: NavigatorWorld, text: string): string[] {
  return resolveNeed(world.frame, text)?.nodeIds ?? []
}

/** `cards`: the scene cards of a range, a chapter or a scene, or of the scenes naming a record. */
function cards(world: NavigatorWorld, arg: string): ToolRun {
  let nodeIds = scenesNamed(world, arg)
  if (nodeIds.length === 0) {
    const record = recordByNameV2(world.project, arg, 'words')
    if (record !== undefined) {
      nodeIds = scenesNaming(world.project, record.id)
        .filter((each) => each.real)
        .map((each) => each.nodeId)
    }
  }
  const items = addUpTo(nodeIds, NAVIGATOR_TOOL_ITEMS, (nodeId) =>
    world.menu.addKey({ kind: 'card', nodeId })
  )
  const step: AgentStep = {
    tool: 'cards',
    label: `Reading ${items.length} scene card${items.length === 1 ? '' : 's'}…`
  }
  const note =
    nodeIds.length === 0
      ? `"${arg}" names no scene or record.`
      : items.length === 0
        ? `No new card for "${arg}" (a scene not read yet has none).`
        : null
  return { step, added: items, note }
}

/** A read's argument: a scene part ("7.4 ¶3-8"), a record's page, or anything else. */
const PARA_RANGE = /^(.+?)\s*¶\s*(\d{1,4})(?:\s*[-–]\s*(\d{1,4}))?$/u
const RECORD_PAGE = /^(.+?)(?:['’]s?)?\s+(pinned|ideas)$/iu

/** `read`: a scene or part of it, a record's Pinned or Ideas, or a Research page (two a message). */
function read(world: NavigatorWorld, arg: string): ToolRun {
  const step: AgentStep = { tool: 'read', label: clip(`Reading ${arg}…`) }
  if (world.reads >= NAVIGATOR_READS_MAX) {
    return { step, added: [], note: `Two reads a message: use what the menu holds.` }
  }
  world.reads += 1
  const page = RECORD_PAGE.exec(arg)
  if (page !== null) {
    const record = recordNamed(world, page[1] ?? '')
    if (record === null) return { step, added: [], note: `No record is called "${page[1] ?? ''}".` }
    if ((page[2] ?? '').toLowerCase() === 'ideas') {
      const item = world.menu.addKey({ kind: 'ideas', recordId: record.id })
      return {
        step,
        added: added([item]),
        note: item === null ? `${record.name}'s Ideas are empty.` : null
      }
    }
    const items = addUpTo(pageParagraphs(record.pinned), NAVIGATOR_TOOL_ITEMS, (paragraph) =>
      world.menu.addKey({
        kind: 'passage',
        source: 'pinned',
        ownerId: record.id,
        para: paragraph.index
      })
    )
    return {
      step,
      added: items,
      note: items.length === 0 ? `${record.name}'s Pinned is empty.` : null
    }
  }
  const part = PARA_RANGE.exec(arg)
  const sceneId = scenesNamed(world, part?.[1] ?? arg)[0]
  if (sceneId !== undefined) return readScene(world, step, sceneId, part)
  const researchId = researchByTitle(world, arg)
  if (researchId !== undefined) {
    const source: PassageSource =
      researchDocOf(world.frame.db, researchId).origin === 'upload' ? 'research' : 'note'
    const row = world.frame.nodes.find((each) => each.id === researchId)
    const doc = row === undefined ? null : parseDoc(row.content)
    const paragraphs = doc === null ? [] : markedParagraphs(doc)
    const items = addUpTo(paragraphs, NAVIGATOR_TOOL_ITEMS, (paragraph) =>
      world.menu.addKey({ kind: 'passage', source, ownerId: researchId, para: paragraph.index })
    )
    return { step, added: items, note: items.length === 0 ? `"${arg}" is empty.` : null }
  }
  return { step, added: [], note: `"${arg}" names no scene, record page or Research page.` }
}

/** A scene read: its paragraphs from the first asked, within `NAVIGATOR_READ_TOKENS`. */
function readScene(
  world: NavigatorWorld,
  step: AgentStep,
  nodeId: string,
  part: RegExpExecArray | null
): ToolRun {
  const row = world.frame.documents.get(nodeId)
  const texts = row === undefined ? [] : rowTexts(row)
  if (texts.length === 0) return { step, added: [], note: 'That scene is empty.' }
  const from = Math.min(Number(part?.[2] ?? 0), texts.length - 1)
  const last = Math.min(
    part === null ? texts.length - 1 : Number(part[3] ?? part[2] ?? 0),
    texts.length - 1
  )
  let to = from
  let used = estimateTokens(texts[from] ?? '')
  while (to < last && used + estimateTokens(texts[to + 1] ?? '') <= NAVIGATOR_READ_TOKENS) {
    to += 1
    used += estimateTokens(texts[to] ?? '')
  }
  const key: EvidenceKey = { kind: 'scene', nodeId, from, to }
  world.menu.addHits(Array.from({ length: to - from + 1 }, (_, i) => ({ nodeId, para: from + i })))
  const item = world.menu.addKey(key)
  return { step, added: added([item]), note: item === null ? 'Already on the menu.' : null }
}

/**
 * `state`: a record as of now: its live values, what it knows, its threads and age (Step 0's
 * digest), its Pinned lines, where the book names it first and last up to now, and the card of the
 * last scene it is Here in (a map).
 */
function state(world: NavigatorWorld, arg: string): ToolRun {
  const step: AgentStep = { tool: 'state', label: clip(`Looking up ${arg}…`) }
  const record = recordNamed(world, arg)
  if (record === null) return { step, added: [], note: `No record is called "${arg}".` }
  if (!isNamedKind(record.kind)) {
    return { step, added: [], note: `"${record.name}" is a ${record.kind}: use knows or search.` }
  }
  const sheet = sheetMemory(world.frame.db, record.id, world.step0.nowId)
  const digest = recordDigest(sheet, record, nameOf(world))
  // Each candidate is added only while the call is under its cap (`addUpTo`).
  const candidates: (() => MenuItem | null)[] = digest.lines.map(
    (line) => () =>
      world.menu.add(
        line.key,
        line.key.kind === 'timeline' ? 'computed' : 'happened',
        record.name,
        `${record.name} · ${line.text}`
      )
  )
  const known = recordState(world.project, record)
  for (const paragraph of known.pinned.slice(0, 4)) {
    candidates.push(() =>
      world.menu.addKey({
        kind: 'passage',
        source: 'pinned',
        ownerId: record.id,
        para: paragraph.index
      })
    )
  }
  const upToNow = known.named.slice(0, known.upToNow)
  for (const each of [upToNow[0], upToNow.at(-1)]) {
    const para =
      each === undefined ? undefined : each === upToNow[0] ? each.paras[0] : each.paras.at(-1)
    if (each === undefined || para === undefined) continue
    candidates.push(() =>
      world.menu.addHit({
        source: 'scene',
        ownerId: each.nodeId,
        para,
        snippet: snippetOf(world, each.nodeId, para)
      })
    )
  }
  const seen = known.seen
  if (seen !== null && promptCard(world.frame.db, seen) !== null) {
    candidates.push(() => world.menu.addKey({ kind: 'card', nodeId: seen }))
  }
  const kept = addUpTo(candidates, NAVIGATOR_TOOL_ITEMS * 2, (each) => each())
  return { step, added: kept, note: kept.length === 0 ? `Nothing new on ${record.name}.` : null }
}

/** A scene paragraph's text as a snippet. */
function snippetOf(world: NavigatorWorld, nodeId: string, para: number): string {
  const row = world.frame.documents.get(nodeId)
  return row === undefined ? '' : (rowTexts(row)[para] ?? '')
}

/**
 * `knows`: a secret's lines (who knows or half-knows it as of now), or the secrets a person knows
 * or half-knows. Positive lines only: never a "does not know" (P2b rule 9).
 */
function knows(world: NavigatorWorld, arg: string): ToolRun {
  const secretId = secretNamed(world, arg)
  if (secretId !== null) {
    const label = frameRecord(world.frame, secretId)?.name ?? arg
    const step: AgentStep = { tool: 'knows', label: clip(`Checking who knows ${label}…`) }
    const item = world.menu.addKey({ kind: 'knows', secretId }, label)
    return {
      step,
      added: added([item]),
      note: item === null ? `No new line shows anyone knowing ${label}.` : null
    }
  }
  const record = recordNamed(world, arg)
  const step: AgentStep = {
    tool: 'knows',
    label: clip(`Checking what ${record?.name ?? arg} knows…`)
  }
  if (record === null || !isNamedKind(record.kind)) {
    return { step, added: [], note: `No secret or person is called "${arg}".` }
  }
  const sheet = sheetMemory(world.frame.db, record.id, world.step0.nowId)
  const items = addUpTo(sheet.knows?.lines ?? [], NAVIGATOR_TOOL_ITEMS, (line) => {
    const text = knowsLineText(line, nameOf(world))
    return text === null
      ? null
      : world.menu.add(
          { kind: 'knows', secretId: line.secretId },
          'happened',
          record.name,
          `${record.name} · ${text}`
        )
  })
  return { step, added: items, note: items.length === 0 ? `No new line for ${record.name}.` : null }
}

/** `timeline`: a record's age as of now, or the story years up to now (computed from the book). */
function timeline(world: NavigatorWorld, arg: string): ToolRun {
  const record = arg === '' ? null : recordNamed(world, arg)
  const step: AgentStep = {
    tool: 'timeline',
    label: record === null ? 'Reading the story years…' : clip(`Working out ${record.name}'s age…`)
  }
  if (arg !== '' && record === null)
    return { step, added: [], note: `No record is called "${arg}".` }
  const item = world.menu.addKey({ kind: 'timeline', recordId: record?.id ?? null })
  const note =
    item !== null
      ? null
      : record === null
        ? 'No story years yet.'
        : `No age for ${record.name} yet.`
  return { step, added: added([item]), note }
}

/** `ideas`: a record's Ideas, or every record's (the author's ideas, never the book). */
function ideas(world: NavigatorWorld, arg: string): ToolRun {
  const record = arg === '' ? null : recordNamed(world, arg)
  const step: AgentStep = {
    tool: 'ideas',
    label: record === null ? 'Reading your ideas…' : clip(`Reading your ideas for ${record.name}…`)
  }
  if (arg !== '' && record === null)
    return { step, added: [], note: `No record is called "${arg}".` }
  const ids =
    record !== null
      ? [record.id]
      : recordsOf(world.project)
          .filter((each) => (frameRecord(world.frame, each.id)?.ideas ?? null) !== null)
          .map((each) => each.id)
  const items = addUpTo(ids, NAVIGATOR_TOOL_ITEMS, (recordId) =>
    world.menu.addKey({ kind: 'ideas', recordId })
  )
  return { step, added: items, note: items.length === 0 ? 'No new ideas.' : null }
}

/** Runs one call of `navigator.v1` against the book (P3 §4.2). */
export function runNavigatorTool(world: NavigatorWorld, call: NavigatorCall): ToolRun {
  switch (call.tool) {
    case 'search':
      return search(world, call.terms)
    case 'cards':
      return cards(world, call.arg)
    case 'read':
      return read(world, call.arg)
    case 'state':
      return state(world, call.arg)
    case 'knows':
      return knows(world, call.arg)
    case 'timeline':
      return timeline(world, call.arg)
    case 'ideas':
      return ideas(world, call.arg)
    case 'outline': {
      const item = world.menu.addKey({ kind: 'outline' }, 'outline')
      return {
        step: { tool: 'outline', label: 'Reading the outline…' },
        added: added([item]),
        note: item === null ? 'The outline is on the menu already.' : null
      }
    }
    case 'todos': {
      const item = world.menu.addKey({ kind: 'todos' }, 'to-dos')
      return {
        step: { tool: 'todos', label: 'Reading your to-dos…' },
        added: added([item]),
        note: item === null ? 'No open to-dos.' : null
      }
    }
  }
}
