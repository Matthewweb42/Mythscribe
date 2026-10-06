import { docToText } from '@shared/docText'
import { AI_ORIGIN_MARK } from '@shared/provenance'
import { parseStoredSceneMeta } from '@shared/sceneMeta'
import { classifyKind, computeStylometrics, type Stylometrics } from '@shared/stylometry'
import type { TiptapNodeT } from '@shared/tiptap'
import {
  VOICE_AUTO_EXEMPLAR_MAX,
  VOICE_AUTO_PASSAGE_MAX,
  VOICE_AUTO_PASSAGE_MIN,
  VOICE_AUTO_REFRESH_WORDS,
  type VoiceExemplarKind
} from '@shared/voice'
import type { NodeRow } from '../db/schema'
import { getVoiceAutoState, setVoiceAutoState } from '../project/settingsStore'
import type { TreeDb } from '../tree/treeStore'
import {
  listExemplars,
  passageHash,
  replaceAutoExemplars,
  type AutoExemplarPick
} from './exemplarStore'
import { buildVoiceProfile, documentJson, manuscriptDocuments } from './profile'

/**
 * Automatic voice learning, the local half (F-14.14, decided by Claude, unconfirmed): the voice
 * job re-picks a handful of exemplars from the author's own paragraphs so the voice block has
 * examples without the author marking any. No AI call, no cost. Imported prose is the author's
 * and counts; text carrying the F-14.6 `aiOrigin` mark never does.
 */

/** A run of short paragraphs is closed once it reaches this many characters. */
const PASSAGE_TARGET = 400

/** One passage of the author's own prose, in reading order across the manuscript. */
export interface AuthorPassage {
  nodeId: string
  pov: string | null
  text: string
}

/**
 * The author's passages of one document, in order: each top-level paragraph that carries no
 * AI-origin text, joined with its neighbours while the run is shorter than `PASSAGE_TARGET`
 * characters (dialogue comes in short paragraphs), and a paragraph longer than
 * `VOICE_AUTO_PASSAGE_MAX` cut to its leading whole sentences. Any other block (a heading, a
 * scene break, a list), and any paragraph with AI-origin text, closes the run; an empty
 * paragraph is spacing and is stepped over. Runs shorter than `VOICE_AUTO_PASSAGE_MIN` are
 * dropped.
 */
export function authorPassages(
  nodeId: string,
  pov: string | null,
  doc: TiptapNodeT
): AuthorPassage[] {
  const out: AuthorPassage[] = []
  let run: string[] = []
  const runLength = (): number => run.join('\n').length
  const flush = (): void => {
    const text = run.join('\n').trim()
    if (text.length >= VOICE_AUTO_PASSAGE_MIN) out.push({ nodeId, pov, text })
    run = []
  }
  for (const block of doc.content ?? []) {
    if (block.type !== 'paragraph' || hasAiOrigin(block)) {
      flush()
      continue
    }
    let text = docToText({ type: 'doc', content: [block] }).trim()
    if (text === '') continue
    if (text.length > VOICE_AUTO_PASSAGE_MAX) {
      flush()
      text = leadingSentences(text, VOICE_AUTO_PASSAGE_MAX)
      if (text.length >= VOICE_AUTO_PASSAGE_MIN) out.push({ nodeId, pov, text })
      continue
    }
    if (run.length > 0 && runLength() + 1 + text.length > VOICE_AUTO_PASSAGE_MAX) flush()
    run.push(text)
    if (runLength() >= PASSAGE_TARGET) flush()
  }
  flush()
  return out
}

function hasAiOrigin(node: TiptapNodeT): boolean {
  if (node.marks?.some((mark) => mark.type === AI_ORIGIN_MARK)) return true
  return (node.content ?? []).some(hasAiOrigin)
}

/** The longest run of whole sentences from the start of `text` within `max` characters; '' when the first is longer. */
export function leadingSentences(text: string, max: number): string {
  const ends = /[.!?…]+["”’')\]]*(?=\s|$)/g
  let cut = 0
  for (const match of text.matchAll(ends)) {
    const end = match.index + match[0].length
    if (end > max) break
    cut = end
  }
  return text.slice(0, cut).trim()
}

/** Every author passage of the manuscript in reading order. */
export function manuscriptPassages(
  db: TreeDb,
  rows: NodeRow[] = manuscriptDocuments(db)
): AuthorPassage[] {
  return rows.flatMap((row) => {
    const json = documentJson(row)
    if (json === null) return []
    const pov = parseStoredSceneMeta(row.sceneMeta).pov.trim()
    return authorPassages(row.id, pov.length > 0 ? pov : null, json)
  })
}

/** The order the picker cycles through kinds, so the set is balanced rather than all one kind. */
const KIND_ROTATION: readonly VoiceExemplarKind[] = ['interiority', 'action', 'dialogue', 'mixed']

interface Candidate extends AuthorPassage {
  kind: VoiceExemplarKind
  distance: number
  order: number
}

/**
 * How far a passage sits from the manuscript's habits: the relative difference of its median
 * sentence length, plus half the relative difference of its adverb rate. 0 when the manuscript
 * has no figures yet.
 */
export function styleDistance(passage: Stylometrics, profile: Stylometrics): number {
  if (profile.wordCount === 0) return 0
  const sentence =
    Math.abs(passage.sentenceLength.median - profile.sentenceLength.median) /
    Math.max(profile.sentenceLength.median, 1)
  const adverbs =
    Math.abs(passage.adverbRate - profile.adverbRate) / Math.max(profile.adverbRate, 1)
  return sentence + adverbs * 0.5
}

export interface SelectOptions {
  /** How many to pick. */
  max: number
  /** Hashes (`passageHash`) of passages the author removed: never picked again. */
  dismissed: ReadonlySet<string>
  /** The hand-marked exemplars' texts: a passage overlapping one is not picked twice. */
  authorTexts: readonly string[]
}

/**
 * Picks up to `max` passages, pure: kinds in rotation (interiority, action, dialogue, mixed),
 * and within a kind the passage closest to the manuscript's style, a scene not used yet ranking
 * ahead by a full point and a POV not used yet by a quarter, the earlier passage on a tie. The
 * answer is in pick order, best first.
 */
export function selectAutoExemplars(
  passages: readonly AuthorPassage[],
  profile: Stylometrics,
  options: SelectOptions
): AutoExemplarPick[] {
  const overlapsAuthor = (text: string): boolean =>
    options.authorTexts.some((own) => own.includes(text) || text.includes(own.trim()))
  let pool: Candidate[] = passages
    .filter((p) => !options.dismissed.has(passageHash(p.text)) && !overlapsAuthor(p.text))
    .map((p, order) => ({
      ...p,
      order,
      kind: classifyKind(p.text),
      distance: styleDistance(computeStylometrics(p.text), profile)
    }))
  const picks: AutoExemplarPick[] = []
  const nodes = new Set<string>()
  const povs = new Set<string>()
  while (picks.length < options.max) {
    let progressed = false
    for (const kind of KIND_ROTATION) {
      if (picks.length >= options.max) break
      let best: Candidate | null = null
      let bestScore = Infinity
      for (const c of pool) {
        if (c.kind !== kind) continue
        const score =
          c.distance +
          (nodes.has(c.nodeId) ? 1 : 0) +
          (c.pov !== null && povs.has(c.pov.toLowerCase()) ? 0.25 : 0)
        if (score < bestScore || (score === bestScore && best !== null && c.order < best.order)) {
          best = c
          bestScore = score
        }
      }
      if (best === null) continue
      const chosen = best
      picks.push({ nodeId: chosen.nodeId, text: chosen.text, pov: chosen.pov, kind: chosen.kind })
      nodes.add(chosen.nodeId)
      if (chosen.pov !== null) povs.add(chosen.pov.toLowerCase())
      pool = pool.filter((c) => c !== chosen)
      progressed = true
    }
    if (!progressed) break
  }
  return picks
}

/** Whether the automatic exemplars are due: never picked, or the manuscript moved by the threshold since. */
export function autoExemplarsDue(basedOnWords: number | null, words: number): boolean {
  return basedOnWords === null || Math.abs(words - basedOnWords) >= VOICE_AUTO_REFRESH_WORDS
}

export interface AutoExemplarRefresh {
  /** Whether a pick ran (it was due, or forced). */
  ran: boolean
  /** Whether the stored automatic set changed. */
  changed: boolean
  /** The manuscript's words now. */
  words: number
}

/**
 * The voice job's local step: when due (or `force`), re-pick the automatic exemplars from the
 * manuscript as saved, store them in place of the previous set, and remember the word count.
 * The style the passages are measured against is the voice profile's own stylometrics.
 */
export function refreshAutoExemplars(
  db: TreeDb,
  now: Date,
  options: { force?: boolean } = {}
): AutoExemplarRefresh {
  const rows = manuscriptDocuments(db)
  const words = rows.reduce((sum, row) => sum + row.wordCount, 0)
  const state = getVoiceAutoState(db)
  if (options.force !== true && !autoExemplarsDue(state.basedOnWords, words)) {
    return { ran: false, changed: false, words }
  }
  const picks = selectAutoExemplars(manuscriptPassages(db, rows), buildVoiceProfile(db).stats, {
    max: VOICE_AUTO_EXEMPLAR_MAX,
    dismissed: new Set(state.dismissed),
    authorTexts: listExemplars(db)
      .filter((e) => e.source === 'author')
      .map((e) => e.text)
  })
  const changed = replaceAutoExemplars(db, picks, now)
  setVoiceAutoState(db, { ...state, basedOnWords: words })
  return { ran: true, changed, words }
}
