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
import { ageText, evidenceFrame, passageNow, sceneLabel, type EvidenceFrame } from './evidence'

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
const OTHER_SOURCES: readonly PassageSource[] = DEFAULT_PASSAGE_SOURCES.filter(
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
    const cell = line.cell
    if (cell.later || cell.line === 'other') continue
    const key: EvidenceKey = { kind: 'knows', secretId: line.secretId }
    const where = cell.ref ?? ''
    // Half-knowing never reads as knowing (P2b-D7): "Suspects …", "Believes otherwise about …".
    if (cell.line === 'partial') {
      const what =
        cell.how === 'believesFalse'
          ? `Believes otherwise about ${line.label}`
          : `${HOW_LABEL[cell.how].replace(/^./u, (first) => first.toUpperCase())} ${line.label}`
      add(where === '' ? what : `${what} (${where})`, key)
      continue
    }
    const from = cell.fromId === null ? '' : ` from ${nameOf(cell.fromId)}`
    add(
      `Knows ${line.label} (${HOW_LABEL[cell.how]}${from}${where === '' ? '' : `, ${where}`})`,
      key
    )
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
  let terms = asked
  let scope: SearchScope | null = null
  let scenes: MemoryPassageHit[] = []
  let others: MemoryPassageHit[]
  const baseline: SearchHit[] = []
  if (ordinal) {
    // Each named record by every name it has (a nickname in the prose counts), else as written.
    const groups = names.records.map((name) => {
      const words = ask.roster
        .filter((alias) => alias.recordId === name.recordId)
        .flatMap((alias) => queryTerms(alias.text))
      return [...new Set(words.length > 0 ? words : nameWords(name.text))]
    })
    const content = search.terms
      .map((term) => term.slice(0, NAVIGATION_TERM_MAX))
      .slice(0, NAVIGATION_TERMS_MAX)
    terms = (content.length > 0 ? content : [...new Set(groups.flat())])
      .map((term) => term.slice(0, NAVIGATION_TERM_MAX))
      .slice(0, NAVIGATION_TERMS_MAX)
    const now = frame.nowId === null ? -1 : (frame.reading.at.get(frame.nowId) ?? -1)
    const upTo = cues.wholeBook || now < 0 ? Infinity : now
    const found = searchMemoryPassagesInOrder(db, content, {
      names: groups,
      sources: ['scene'],
      max: ORDINAL_HITS_MAX,
      latest: search.latest,
      orderOf: (ownerId) => {
        const order = frame.reading.order.get(ownerId)
        return order !== undefined && order <= upTo ? order : undefined
      },
      nodes
    })
    scenes = found.hits
    scope = ordinalScope(frame, terms, {
      wholeBook: cues.wholeBook,
      latest: search.latest,
      cut: found.cut
    })
    for (const each of found.matched) baseline.push({ nodeId: each.ownerId, para: each.para })
    others = searchMemoryPassages(db, query, {
      sources: OTHER_SOURCES,
      limit: ORDINAL_OTHER_HITS,
      nodes
    })
  } else {
    others = searchMemoryPassages(db, query, { limit: NAVIGATOR_MENU_HITS, nodes })
  }

  const menu: MenuItem[] = []
  const push = (key: EvidenceKey, label: EvidenceLabel, ref: string, snippet: string): void => {
    if (menu.some((item) => sameEvidence(item.key, key))) return
    menu.push({ id: `E${menu.length + 1}`, key, label, ref, snippet })
  }
  for (const digest of digests) {
    for (const line of digest.lines) {
      const label: EvidenceLabel = line.key.kind === 'timeline' ? 'computed' : 'happened'
      push(line.key, label, digest.name, `${digest.name} · ${line.text}`)
    }
  }
  const hits: SearchHit[] = []
  const place = (hit: MemoryPassageHit): void => {
    const item = passageNow(frame, hit.source, hit.ownerId, hit.para)
    if (item === null) return
    if (hit.source === 'scene' || hit.source === 'ideaScene' || hit.source === 'excludedScene') {
      hits.push({ nodeId: hit.ownerId, para: hit.para })
    }
    push(
      { kind: 'passage', source: hit.source, ownerId: hit.ownerId, para: hit.para },
      item.label,
      item.ref,
      hit.snippet.replace(/\s+/g, ' ').trim()
    )
  }
  for (const hit of cues.idea ? [...others, ...scenes] : [...scenes, ...others]) place(hit)
  // What the cap cut is still what the search returned: never a search miss later (P3-D15).
  for (const hit of baseline) {
    if (!hits.some((each) => each.nodeId === hit.nodeId && each.para === hit.para)) hits.push(hit)
  }

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
    hits: hits.slice(0, NAVIGATION_HITS_MAX),
    menu
  }
}
