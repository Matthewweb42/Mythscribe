import { AGENT_CARET_CHARS } from '@shared/agent'
import { estimateTokens } from '@shared/ai'
import {
  buildAskIndex,
  instantShape,
  namesInQuestion,
  nameWords,
  ordinalSearch,
  questionCues,
  type AskIndex,
  type AskNames,
  type InstantShape,
  type QuestionCues
} from '@shared/memory/askParse'
import { HOW_LABEL } from '@shared/memory/knows'
import {
  DEFAULT_PASSAGE_SOURCES,
  type MemoryPassageHit,
  type PassageSource
} from '@shared/memory/passages'
import type { RecordKind, StoryRecordSummary } from '@shared/memory/records'
import type { SheetLineView, SheetMemory } from '@shared/memory/views'
import {
  NAVIGATION_HITS_MAX,
  NAVIGATION_TERM_MAX,
  NAVIGATION_TERMS_MAX,
  NAVIGATOR_MENU_HITS,
  ORDINAL_HITS_MAX,
  sameEvidence,
  type EvidenceKey,
  type EvidenceLabel,
  type SearchHit,
  type SearchScope
} from '@shared/scribe'
import { searchableText } from '@shared/search'
import { queryTerms } from '@shared/searchTerms'
import type { NowBasis } from '@shared/storyTime'
import { storyTime } from '../ai/context/storyTime'
import { nameScanShared } from '../memory/nameIndexer'
import { searchMemoryPassages, searchMemoryPassagesInOrder } from '../memory/passageIndexer'
import { readingOrder, rowTexts } from '../memory/reading/readingFrame'
import { sheetFrame, sheetMemory } from '../memory/reading/views'
import { listRecords } from '../memory/recordStore'
import { listNodes, type TreeDb } from '../tree/treeStore'
import {
  ageText,
  evidenceFrame,
  itemOf,
  passageNow,
  sceneLabel,
  type EvidenceFrame
} from './evidence'

/**
 * Step 0 (F-16.24; design §2.6, plan P3 §1.3): what every chat question gets locally, before any
 * AI is asked, in under 50 ms: now (the open scene, else the latest written); **E0**, the open
 * scene's saved paragraphs whole; the records the question names, each with a short digest of its
 * live state, what it knows, its threads and its age as of now (positive lines only: absence is
 * never a line, P2b rule 9); word-search hits over every labelled source but the cards (for a
 * first/last/ever question, every earlier scene's best paragraph for its content words, in reading
 * order, with the best of the other sources beside them, P3-D8); and the evidence menu, E1…En, the
 * navigator and the answer pick from. No AI, no write.
 */

/** Where the author is in the open scene: the caret's paragraph and the selection's text. */
export interface Step0Focus {
  caretPara: number | null
  selection: string | null
}

/**
 * The paragraph the caret is in, from the caret window the chat sends (`AgentFocus.beforeCaret`:
 * the text up to the caret, blocks joined by a blank line, its last `AGENT_CARET_CHARS`). The
 * window's blocks are matched as a run against the scene's paragraphs, ending in the paragraph
 * that starts with the window's last block (or, with the caret at the start of an empty block, the
 * one after the paragraph the block before it is): the place that matches the most blocks wins.
 * A window shorter than the cap starts at the top of the scene, so among equal matches the one
 * as many paragraphs down as the window has blocks; a full window is cut, so its first block may
 * be a paragraph's tail (and a window inside one long paragraph holds its middle). Empty blocks
 * are skipped, as the saved paragraphs skip them. Null without a window or a match.
 */
export function caretParaOf(paragraphs: readonly string[], beforeCaret: string): number | null {
  if (beforeCaret.trim() === '' || paragraphs.length === 0) return null
  const norm = (text: string): string => text.replace(/\s+/gu, ' ').trim()
  const blocks = beforeCaret.split('\n\n')
  const last = norm(blocks.at(-1) ?? '')
  const earlier = blocks
    .slice(0, -1)
    .map(norm)
    .filter((block) => block !== '')
  // The run to match: every block before the caret's, then the caret's own (a paragraph's start).
  const run = last === '' ? earlier : [...earlier, last]
  if (run.length === 0) return null
  const fromTop = beforeCaret.length < AGENT_CARET_CHARS
  const flat = paragraphs.map(norm)
  const end = run.length - 1
  const matches = (para: string, k: number): boolean => {
    const block = run[k] ?? ''
    const cutFirst = k === 0 && !fromTop
    if (k === end && last !== '') return cutFirst ? para.includes(block) : para.startsWith(block)
    return cutFirst ? para.endsWith(block) : para === block
  }
  // Where a window from the top expects the run's end: as many paragraphs down as it has blocks.
  const expected = fromTop ? end : null
  let best: { at: number; score: number; off: number } | null = null
  for (let at = 0; at < flat.length; at++) {
    if (!matches(flat[at] ?? '', end)) continue
    let score = 1
    while (score <= end && at - score >= 0 && matches(flat[at - score] ?? '', end - score)) {
      score += 1
    }
    const off = expected === null ? 0 : Math.abs(at - expected)
    if (best === null || score > best.score || (score === best.score && off < best.off)) {
      best = { at, score, off }
    }
  }
  if (best === null) return null
  return last === '' ? Math.min(best.at + 1, flat.length - 1) : best.at
}

/** E0: the open scene as it is saved (the renderer flushed it first). */
export interface SceneE0 {
  nodeId: string
  ref: string
  /** What the open scene is (`sceneLabel`): an Idea scene or a cut scene is never real. */
  label: EvidenceLabel
  title: string
  paragraphs: readonly string[]
  caretPara: number | null
  /** The selection's opening (at most `SELECTION_OPENING` characters). */
  selection: string | null
}

/** A record the question names, with what the book says of it as of now. */
export interface RecordDigest {
  recordId: string
  name: string
  kind: RecordKind
  /** At most `DIGEST_TOKENS` tokens: "Mara (character): Eyes: grey (1.1) · …". */
  digest: string
  /** The evidence each line rests on, in the digest's order. */
  keys: EvidenceKey[]
  /** Each kept line with the evidence it rests on (the menu's snippets). */
  lines: { text: string; key: EvidenceKey }[]
}

/** One entry of the evidence menu (`E3 happened 9.3 ¶4: …snippet…`). */
export interface MenuItem {
  id: string
  key: EvidenceKey
  label: EvidenceLabel
  ref: string
  snippet: string
}

export interface Step0 {
  nowId: string | null
  nowRef: string | null
  basis: NowBasis
  e0: SceneE0 | null
  names: AskNames
  cues: QuestionCues
  /** The instant card the question could have (`instant.ts` decides whether it does). */
  shape: InstantShape | null
  records: RecordDigest[]
  /** The search's words (at most 8): an ordinal search's content words, or the names it ranked by. */
  terms: string[]
  /**
   * What was searched, for a first/last/ever/never/how-many/learns question (or a knows question
   * naming a secret, or a record and what it may know): every scene up to now, or the stretch
   * every match of which is in the menu when the cap cut some; null otherwise, or when there was
   * nothing to search for.
   */
  scope: SearchScope | null
  /**
   * The question asks for every earlier scene (first, last, ever, never, how many, learns, or a
   * knows question with something to search for): the navigator's searches go in reading order too.
   */
  ordinal: boolean
  /** A last or latest question: the cap keeps the latest scenes. */
  latest: boolean
  /** Each named record's names, as an ordered search ranks by them. */
  groups: string[][]
  /**
   * Every manuscript paragraph the searches returned, those the cap cut too (at most 50): the
   * search-miss baseline (P3-D15).
   */
  hits: SearchHit[]
  menu: MenuItem[]
}

/** The most records Step 0 digests, and a digest's tokens. */
export const STEP0_RECORDS = 3
export const DIGEST_TOKENS = 120
/** The selection's opening E0 notes. */
export const SELECTION_OPENING = 200
/** The best hits of the other sources (Pinned, Ideas, notes, Research) beside an ordinal search. */
export const ORDINAL_OTHER_HITS = 6

/** Every source but a manuscript scene and a card: what an ordinal search adds beside the scenes. */
export const OTHER_SOURCES: readonly PassageSource[] = DEFAULT_PASSAGE_SOURCES.filter(
  (source) => source !== 'scene'
)

/** The question index over the roster: the name scan's names, the secrets and threads. */
export function askIndexOf(
  db: TreeDb,
  records: readonly StoryRecordSummary[] = listRecords(db)
): AskIndex {
  return buildAskIndex(nameScanShared(db).index, records)
}

const valueLine = (line: SheetLineView, kind: 'fixed' | 'lasting' | 'transient'): string => {
  const at =
    kind === 'lasting'
      ? `since ${line.since ?? line.value.ref}`
      : kind === 'transient'
        ? `last stated in ${line.since ?? line.value.ref}`
        : line.value.ref
  const also =
    kind === 'fixed'
      ? line.also
          .filter((each) => !each.stale)
          .map((each) => ` · also “${each.value}” ${each.ref}`)
          .join('')
      : ''
  return `${line.label}: ${line.value.value} (${at}${line.value.stale ? ', re-checking' : ''})${also}`
}

/** One secret a record knows or half-knows as of now, as its sheet lists it. */
type KnowsLine = NonNullable<SheetMemory['knows']>['lines'][number]

/**
 * A knows line as Step 0's digest and the navigator's `knows` tool word it: "Knows the sold map
 * (overheard from Tomas, 1.1)"; half-knowing never reads as knowing (P2b-D7): "Suspects the sold
 * map (1.2)", "Believes otherwise about …". Null for a later line or one that does not count:
 * absence is never a line (P2b rule 9).
 */
export function knowsLineText(
  line: KnowsLine,
  nameOf: (id: string | null) => string
): string | null {
  const cell = line.cell
  if (cell.later || cell.line === 'other') return null
  const where = cell.ref ?? ''
  if (cell.line === 'partial') {
    const what =
      cell.how === 'believesFalse'
        ? `Believes otherwise about ${line.label}`
        : `${HOW_LABEL[cell.how].replace(/^./u, (first) => first.toUpperCase())} ${line.label}`
    return where === '' ? what : `${what} (${where})`
  }
  const from = cell.fromId === null ? '' : ` from ${nameOf(cell.fromId)}`
  return `Knows ${line.label} (${HOW_LABEL[cell.how]}${from}${where === '' ? '' : `, ${where}`})`
}

/**
 * A record's digest as of now from its sheet (`sheetMemory`): fixed, lasting and transient values
 * with where the book says them (stale ones "re-checking"), the secrets it knows or half-knows,
 * its threads, its age; lines past `DIGEST_TOKENS` are left out. Never a line of absence.
 */
export function recordDigest(
  sheet: SheetMemory,
  record: { id: string; name: string; kind: RecordKind },
  nameOf: (id: string | null) => string
): RecordDigest {
  const lines: { text: string; key: EvidenceKey | null }[] = []
  const add = (text: string, key: EvidenceKey | null): void => void lines.push({ text, key })
  for (const line of sheet.fixed)
    add(valueLine(line, 'fixed'), { kind: 'claim', claimId: line.value.claimId })
  // A stated age is worded with the age as of now below (decision 5): never a bare "since".
  const age = sheet.age?.age ?? null
  for (const line of sheet.lasting) {
    if (line.slot === 'age' && age !== null) continue
    add(valueLine(line, 'lasting'), { kind: 'claim', claimId: line.value.claimId })
  }
  for (const line of sheet.transient) {
    add(valueLine(line, 'transient'), { kind: 'claim', claimId: line.value.claimId })
  }
  for (const line of sheet.knows?.lines ?? []) {
    const text = knowsLineText(line, nameOf)
    if (text !== null) add(text, { kind: 'knows', secretId: line.secretId })
  }
  for (const thread of sheet.threads?.threads ?? []) {
    if (thread.status === 'notYet') continue
    const last = thread.steps.at(-1)
    const at = thread.status === 'resolved' ? thread.resolved : thread.opened
    add(
      `Thread: ${thread.label} (${thread.status}${at === null ? '' : ` since ${at.ref}`})`,
      last === undefined ? null : { kind: 'claim', claimId: last.claimId }
    )
  }
  if (age !== null) add(`Age: ${ageText(age)}`, { kind: 'timeline', recordId: record.id })
  const head = `${record.name} (${record.kind})`
  const kept: string[] = []
  const keys: EvidenceKey[] = []
  const keyed: RecordDigest['lines'] = []
  for (const line of lines) {
    if (estimateTokens(`${head}: ${[...kept, line.text].join(' · ')}`) > DIGEST_TOKENS) break
    kept.push(line.text)
    const key = line.key
    if (key === null) continue
    keyed.push({ text: line.text, key })
    if (!keys.some((each) => sameEvidence(each, key))) keys.push(key)
  }
  const digest = kept.length === 0 ? head : `${head}: ${kept.join(' · ')}`
  return { recordId: record.id, name: record.name, kind: record.kind, digest, keys, lines: keyed }
}

/**
 * The scenes a first/last/ever question searched (P3-D8), from what code searched: every readable
 * scene from the first up to now, in reading order, or the whole book when the question asks about
 * it (`wholeBook`). When the cap cut matching scenes, only the stretch whose every match is in the
 * menu: up to the scene before the first cut one (from the scene after the last cut one for a
 * "last" question), and neither every earlier scene nor the whole book. Null with nothing searched
 * for, or no such stretch.
 */
export function ordinalScope(
  frame: EvidenceFrame,
  terms: string[],
  options: { wholeBook: boolean; latest: boolean; cut: { first: number; last: number } | null }
): SearchScope | null {
  if (terms.length === 0) return null
  const order = [...frame.reading.order.entries()].sort((a, b) => a[1] - b[1]).map(([id]) => id)
  if (order.length === 0) return null
  const now = frame.nowId === null ? -1 : (frame.reading.at.get(frame.nowId) ?? -1)
  const whole = options.wholeBook || now < 0
  let from = 0
  let to = whole ? order.length - 1 : Math.min(now, order.length - 1)
  if (options.cut !== null) {
    if (options.latest) from = Math.max(from, options.cut.last + 1)
    else to = Math.min(to, options.cut.first - 1)
  }
  const first = order[from]
  const last = order[to]
  if (first === undefined || last === undefined || from > to) return null
  return {
    from: frame.reading.refs.get(first) ?? '',
    to: frame.reading.refs.get(last) ?? '',
    allEarlier: options.cut === null && !whole,
    wholeBook: options.cut === null && whole,
    terms
  }
}

/**
 * Each named record by every name it has (a nickname in the prose counts), else as the question
 * writes it: the name groups an ordered search ranks by.
 */
export function nameGroups(ask: AskIndex, names: AskNames): string[][] {
  return names.records.map((name) => {
    const words = ask.roster
      .filter((alias) => alias.recordId === name.recordId)
      .flatMap((alias) => queryTerms(alias.text))
    return [...new Set(words.length > 0 ? words : nameWords(name.text))]
  })
}

/** What an ordered search found: the kept paragraphs, every matching one, and the scope. */
export interface OrderedSceneSearch {
  hits: MemoryPassageHit[]
  matched: SearchHit[]
  scope: SearchScope | null
}

/**
 * Every readable scene up to now (the whole book with `wholeBook`) searched in reading order for
 * `search`'s words, ranked by them and the name `groups` (P3-D8): each scene's best paragraph, the
 * first `ORDINAL_HITS_MAX` (the last, for a `latest` question) kept, and the scope over `terms`
 * that code can claim (`ordinalScope`: the fully kept stretch when the cap cut some). Step 0's
 * first/last/ever search, and the navigator's `search` on such a question.
 */
export function orderedSceneSearch(
  db: TreeDb,
  frame: EvidenceFrame,
  input: {
    search: readonly string[]
    terms: string[]
    groups: readonly (readonly string[])[]
    wholeBook: boolean
    latest: boolean
  }
): OrderedSceneSearch {
  const now = frame.nowId === null ? -1 : (frame.reading.at.get(frame.nowId) ?? -1)
  const upTo = input.wholeBook || now < 0 ? Infinity : now
  const found = searchMemoryPassagesInOrder(db, input.search, {
    names: input.groups,
    sources: ['scene'],
    max: ORDINAL_HITS_MAX,
    latest: input.latest,
    orderOf: (ownerId) => {
      const order = frame.reading.order.get(ownerId)
      return order !== undefined && order <= upTo ? order : undefined
    },
    nodes: frame.nodes
  })
  return {
    hits: found.hits,
    matched: found.matched.map((each) => ({ nodeId: each.ownerId, para: each.para })),
    scope: ordinalScope(frame, input.terms, {
      wholeBook: input.wholeBook,
      latest: input.latest,
      cut: found.cut
    })
  }
}

/**
 * The evidence menu as it grows (P3 §1.3, §4.2): Step 0 fills it, the navigator's tools add to it.
 * Each item gets the next id (`E1`…) once; a hit in a manuscript scene, an Idea scene or a cut one
 * also joins `hits`, the search-miss baseline (P3-D15).
 */
export class EvidenceMenu {
  readonly items: MenuItem[] = []
  readonly hits: SearchHit[] = []

  constructor(
    private readonly frame: EvidenceFrame,
    seed: { items: readonly MenuItem[]; hits: readonly SearchHit[] } = { items: [], hits: [] }
  ) {
    this.items.push(...seed.items)
    this.hits.push(...seed.hits)
  }

  /** Adds an item unless the menu has its key already; answers it, or null. */
  add(key: EvidenceKey, label: EvidenceLabel, ref: string, snippet: string): MenuItem | null {
    if (this.items.some((item) => sameEvidence(item.key, key))) return null
    const item: MenuItem = { id: `E${this.items.length + 1}`, key, label, ref, snippet }
    this.items.push(item)
    return item
  }

  /** A search hit as it is now (`passageNow`); null when gone or already on the menu. */
  addHit(hit: Pick<MemoryPassageHit, 'source' | 'ownerId' | 'para' | 'snippet'>): MenuItem | null {
    const item = passageNow(this.frame, hit.source, hit.ownerId, hit.para)
    if (item === null) return null
    if (hit.source === 'scene' || hit.source === 'ideaScene' || hit.source === 'excludedScene') {
      this.addHits([{ nodeId: hit.ownerId, para: hit.para }])
    }
    return this.add(
      { kind: 'passage', source: hit.source, ownerId: hit.ownerId, para: hit.para },
      item.label,
      item.ref,
      hit.snippet.replace(/\s+/g, ' ').trim()
    )
  }

  /**
   * A key as the book is now (`itemOf`): its label and place, its text as the snippet; null when
   * it names nothing now or is on the menu already.
   */
  addKey(key: EvidenceKey, ref?: string): MenuItem | null {
    const item = itemOf(this.frame, key)
    if (item === null) return null
    return this.add(key, item.label, ref ?? (item.ref || item.title), item.text)
  }

  /** Paragraphs a search or a read returned, each once. */
  addHits(hits: readonly SearchHit[]): void {
    for (const hit of hits) {
      if (!this.hits.some((each) => each.nodeId === hit.nodeId && each.para === hit.para)) {
        this.hits.push(hit)
      }
    }
  }
}

/** Step 0 for one question (plan P3 §1.3). */
export function gatherStep0(
  db: TreeDb,
  input: { nodeId: string | null; question: string; focus: Step0Focus }
): Step0 {
  const nodes = listNodes(db)
  const reading = readingOrder(db, nodes)
  const time = storyTime(db, input.nodeId, nodes)
  const frame = evidenceFrame(db, time.nowId, nodes, reading)
  const nowRef = time.nowId === null ? null : (reading.refs.get(time.nowId) ?? null)

  // E0: the open scene whole (a chapter selected opens its last scene; nothing open: none).
  const openRow =
    time.basis === 'open' && time.nowId !== null ? frame.documents.get(time.nowId) : undefined
  const selection = input.focus.selection?.replace(/\s+/g, ' ').trim() ?? ''
  const e0: SceneE0 | null =
    openRow === undefined
      ? null
      : {
          nodeId: openRow.id,
          ref: nowRef ?? '',
          label: sceneLabel(frame, openRow.id),
          title: searchableText(openRow.title).trim() || 'Untitled',
          paragraphs: rowTexts(openRow),
          caretPara: input.focus.caretPara,
          selection: selection === '' ? null : selection.slice(0, SELECTION_OPENING)
        }

  const records = listRecords(db)
  const ask = askIndexOf(db, records)
  const names = namesInQuestion(input.question, ask)
  const cues = questionCues(input.question, names)
  const shape = instantShape(input.question, names, ask.topics)

  const byId = new Map(records.map((each) => [each.id, each]))
  const nameOf = (id: string | null): string => (id === null ? '' : (byId.get(id)?.name ?? ''))
  const named = names.records.slice(0, STEP0_RECORDS)
  // The sheets' shared reads (who knows what, threads, years), once for every record named.
  const sheets = named.length === 0 ? null : sheetFrame(db, time.nowId, nodes, reading)
  const digests = named.flatMap((each) => {
    const record = byId.get(each.recordId)
    if (record === undefined || sheets === null) return []
    const sheet = sheetMemory(db, record.id, time.nowId, sheets)
    return [recordDigest(sheet, record, nameOf)]
  })

  // The search: the question's words, best first (bm25) over every source but the cards; for a
  // first/last/ever/learns question (or "does A know" a secret or about something) every earlier
  // scene's best paragraph for its content words, ranked by them and the names, in reading order
  // (P3-D8), with the other sources' best beside them (ahead of them for an idea question).
  const asked = queryTerms(input.question)
    .map((term) => term.slice(0, NAVIGATION_TERM_MAX))
    .slice(0, NAVIGATION_TERMS_MAX)
  const query = asked.join(' ')
  // A knows question names a secret, or a knower (a record named, never a possessive "Varrow's",
  // or "who") and what is known ("Does Tomas know about Orrin's brother?"): either way an absence
  // is stated over a scope code searched (design §2.6). "What do we know about …" is no such one.
  const search = ordinalSearch(input.question, names)
  const knower =
    /\bwho\b/iu.test(input.question) ||
    names.records.some((name) => !/['’]s?$/u.test(name.text)) ||
    names.ambiguous.some((name) => !/['’]s?$/u.test(name.text))
  const knowsAbout =
    cues.knows &&
    (names.topics.some((topic) => topic.kind === 'secret') || (knower && search.terms.length > 0))
  const ordinal = cues.scopeAll || cues.learns || knowsAbout
  const groups = nameGroups(ask, names)
  let terms = asked
  let scope: SearchScope | null = null
  let scenes: MemoryPassageHit[] = []
  let others: MemoryPassageHit[]
  let matched: SearchHit[] = []
  if (ordinal) {
    const content = search.terms
      .map((term) => term.slice(0, NAVIGATION_TERM_MAX))
      .slice(0, NAVIGATION_TERMS_MAX)
    terms = (content.length > 0 ? content : [...new Set(groups.flat())])
      .map((term) => term.slice(0, NAVIGATION_TERM_MAX))
      .slice(0, NAVIGATION_TERMS_MAX)
    const found = orderedSceneSearch(db, frame, {
      search: content,
      terms,
      groups,
      wholeBook: cues.wholeBook,
      latest: search.latest
    })
    scenes = found.hits
    scope = found.scope
    matched = found.matched
    others = searchMemoryPassages(db, query, {
      sources: OTHER_SOURCES,
      limit: ORDINAL_OTHER_HITS,
      nodes
    })
  } else {
    others = searchMemoryPassages(db, query, { limit: NAVIGATOR_MENU_HITS, nodes })
  }

  const menu = new EvidenceMenu(frame)
  for (const digest of digests) {
    for (const line of digest.lines) {
      const label: EvidenceLabel = line.key.kind === 'timeline' ? 'computed' : 'happened'
      menu.add(line.key, label, digest.name, `${digest.name} · ${line.text}`)
    }
  }
  for (const hit of cues.idea ? [...others, ...scenes] : [...scenes, ...others]) menu.addHit(hit)
  // What the cap cut is still what the search returned: never a search miss later (P3-D15).
  menu.addHits(matched)

  return {
    nowId: time.nowId,
    nowRef,
    basis: time.basis,
    e0,
    names,
    cues,
    shape,
    records: digests,
    terms,
    scope,
    ordinal,
    latest: search.latest,
    groups,
    hits: menu.hits.slice(0, NAVIGATION_HITS_MAX),
    menu: menu.items
  }
}
