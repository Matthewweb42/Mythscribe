import { parseTagRefs } from '@shared/chat'
import { QUERY_FULL_SCENES, QUERY_SCENE_CHAR_BUDGET, QUERY_SUMMARY_SCENES } from '@shared/query'
import { parseStoredSceneMeta } from '@shared/sceneMeta'
import type { StoredSceneSummary } from '@shared/summary'
import { summariesFor } from '../../document/summaryStore'
import { listAllDocumentTags } from '../../tag/documentTagStore'
import { listNodes, type TreeDb } from '../../tree/treeStore'
import { documentText, manuscriptDocuments } from '../../voice/profile'
import { headTruncate } from './chatContext'

/**
 * Candidate ranking for Story Intelligence (F-5.7). The author asks a question about the whole
 * manuscript; nothing but the top matches may be sent (CLAUDE.md, token rule 2: retrieve, do
 * not dump), so main scores every manuscript document locally — no request, no embeddings — and
 * hands back the few that ride along in full, the next few as their stored summary (F-5.6), and
 * the whole ranked list so the panel can offer "Also mentioned in".
 *
 * The scoring is lexical on purpose: PLAN.md §2.5 keeps vectors for a later feature, and a
 * word-prefix match over the title, the tags, the scene metadata, the summary, and the body is
 * both explainable and free. The weights say where a hit means most — a term in the title or in
 * a tag names the scene, a term in the body only mentions it — and a `#name` reference the
 * author typed outranks everything, because it is an explicit pointer rather than a guess.
 */

/** A token shorter than this is noise ("who", "did" are also stopwords below). */
const TERM_MIN = 3

/**
 * Words that match everything and mean nothing here: ordinary English function words plus the
 * five nouns every question about a manuscript contains. Kept small: a stopword that is also a
 * character's name would silently un-rank the scenes about them.
 */
const STOPWORDS = new Set([
  'the',
  'and',
  'but',
  'for',
  'not',
  'are',
  'was',
  'were',
  'been',
  'being',
  'have',
  'has',
  'had',
  'does',
  'did',
  'doing',
  'what',
  'when',
  'where',
  'which',
  'while',
  'who',
  'whom',
  'whose',
  'why',
  'how',
  'that',
  'this',
  'these',
  'those',
  'there',
  'then',
  'than',
  'with',
  'without',
  'from',
  'into',
  'onto',
  'over',
  'about',
  'after',
  'before',
  'her',
  'hers',
  'his',
  'she',
  'him',
  'they',
  'them',
  'their',
  'theirs',
  'you',
  'your',
  'yours',
  'its',
  'any',
  'all',
  'can',
  'could',
  'would',
  'should',
  'will',
  'just',
  'ever',
  'anything',
  'something',
  'scene',
  'scenes',
  'chapter',
  'chapters',
  'manuscript',
  'story',
  'book'
])

/** What a hit is worth, by where it landed; a `#name` the author typed outranks every guess. */
export const QUERY_WEIGHTS = {
  title: 4,
  tag: 4,
  meta: 3,
  summary: 2,
  body: 1,
  ref: 6
} as const

/** A term repeated in the body is worth a little more, up to ten occurrences. */
const BODY_OCCURRENCE_WEIGHT = 0.1
const BODY_OCCURRENCE_MAX = 10

/**
 * The question's search terms: lower-cased, split on everything that is not a letter or a
 * digit, tokens under `TERM_MIN` and the stopwords dropped, deduplicated in the order the
 * author wrote them.
 */
export function queryTerms(question: string): string[] {
  const terms: string[] = []
  for (const token of question.toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    if (token.length < TERM_MIN || STOPWORDS.has(token) || terms.includes(token)) continue
    terms.push(token)
  }
  return terms
}

/** One document's searchable text, already gathered, so the scorer stays pure and testable. */
export interface CandidateFields {
  /** `Chapter › Scene`, as `sceneTitles` names it. */
  title: string
  /** The tag names linked to the document (F-4.4). */
  tags: string[]
  /** The scene's location, POV, and timeline as one line. */
  meta: string
  /** The stored summary with its key points and characters (F-5.6); '' when it has none. */
  summary: string
  /** The scene's plain text. */
  body: string
}

/**
 * What one document scores for a question: each term counts once per field it starts a word in
 * (so a scene that only mentions a name does not outrank the one named after it), the body adds
 * a little for repetition, and every `#name` reference that matches one of the document's tags
 * adds `QUERY_WEIGHTS.ref`. Zero means the document is not a candidate at all.
 */
export function scoreCandidate(
  terms: readonly string[],
  refs: readonly string[],
  fields: CandidateFields
): number {
  const title = fields.title.toLowerCase()
  const meta = fields.meta.toLowerCase()
  const summary = fields.summary.toLowerCase()
  const body = fields.body.toLowerCase()
  const tags = fields.tags.map((name) => name.toLowerCase())
  let score = 0
  for (const term of terms) {
    if (occurrences(title, term) > 0) score += QUERY_WEIGHTS.title
    if (tags.some((name) => occurrences(name, term) > 0)) score += QUERY_WEIGHTS.tag
    if (occurrences(meta, term) > 0) score += QUERY_WEIGHTS.meta
    if (occurrences(summary, term) > 0) score += QUERY_WEIGHTS.summary
    const hits = occurrences(body, term)
    if (hits > 0) {
      score += QUERY_WEIGHTS.body + BODY_OCCURRENCE_WEIGHT * Math.min(hits, BODY_OCCURRENCE_MAX)
    }
  }
  for (const ref of refs) {
    if (tags.includes(ref)) score += QUERY_WEIGHTS.ref
  }
  return score
}

/**
 * How often `term` starts a word in `field`, both already lower-cased. The boundary is written
 * as a lookbehind over letters and digits rather than `\b`, which is ASCII-only and would miss
 * a term starting with an accented letter.
 */
function occurrences(field: string, term: string): number {
  if (term === '') return 0
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return (field.match(new RegExp(`(?<![\\p{L}\\p{N}])${escaped}`, 'gu')) ?? []).length
}

/** One manuscript document as a candidate answer source. */
export interface QueryCandidate {
  nodeId: string
  /** `Chapter › Scene`, as the beta reader names scenes (F-14.11). */
  title: string
  /** The plain text; head-truncated to `QUERY_SCENE_CHAR_BUDGET` in `full`, whole elsewhere. */
  text: string
  /** The stored summary (F-5.6), or null when the scene has none. */
  summary: StoredSceneSummary | null
  /** What `scoreCandidate` gave it; 0 only in the fallback, where nothing matched at all. */
  score: number
}

export interface QueryCandidates {
  /** The best matches, sent in full (head-truncated), best first. */
  full: QueryCandidate[]
  /** The next matches that have a stored summary, sent as that summary, best first. */
  summaries: QueryCandidate[]
  /** Every candidate in rank order, for the "Also mentioned in" list. */
  ranked: QueryCandidate[]
}

export interface RankCandidatesInput {
  /** The author's question. */
  question: string
  /** The active document; it breaks ties and is the first fallback when nothing scores. */
  nodeId: string | null
}

/**
 * Every manuscript document with text, ranked for the question. Ties keep reading order (the
 * sort is stable over `manuscriptDocuments`) except that the scene the author is looking at
 * wins them. When nothing scores at all — a question with no usable term, or one about words
 * nobody wrote — the active scene comes first and the rest follow in reading order, so the
 * feature still answers "not found" from real scenes rather than refusing.
 */
export function rankCandidates(db: TreeDb, input: RankCandidatesInput): QueryCandidates {
  const documents = manuscriptDocuments(db)
  const title = sceneTitles(db)
  const tagsByNode = listAllDocumentTags(db)
  const stored = summariesFor(
    db,
    documents.map((row) => row.id)
  )
  const terms = queryTerms(input.question)
  const refs = parseTagRefs(input.question)

  const scored: QueryCandidate[] = []
  for (const row of documents) {
    const text = documentText(row).trim()
    if (text === '') continue
    const summary = stored.get(row.id) ?? null
    const meta = parseStoredSceneMeta(row.sceneMeta)
    const sceneTitle = title(row.id)
    const score = scoreCandidate(terms, refs, {
      title: sceneTitle,
      tags: tagsByNode.get(row.id) ?? [],
      meta: [meta.location, meta.pov, meta.timeline].filter((value) => value !== '').join(' '),
      summary:
        summary === null
          ? ''
          : [summary.summary, ...summary.keyPoints, ...summary.characters].join('\n'),
      body: text
    })
    scored.push({ nodeId: row.id, title: sceneTitle, text, summary, score })
  }

  const hits = scored.filter((candidate) => candidate.score > 0)
  const ranked =
    hits.length > 0
      ? [...hits].sort((a, b) => {
          if (a.score !== b.score) return b.score - a.score
          if (a.nodeId === input.nodeId) return -1
          if (b.nodeId === input.nodeId) return 1
          return 0
        })
      : [
          ...scored.filter((candidate) => candidate.nodeId === input.nodeId),
          ...scored.filter((candidate) => candidate.nodeId !== input.nodeId)
        ]

  return {
    full: ranked.slice(0, QUERY_FULL_SCENES).map((candidate) => ({
      ...candidate,
      text: headTruncate(candidate.text, QUERY_SCENE_CHAR_BUDGET)
    })),
    summaries: ranked
      .slice(QUERY_FULL_SCENES)
      .filter((candidate) => candidate.summary !== null)
      .slice(0, QUERY_SUMMARY_SCENES),
    ranked
  }
}

/**
 * How a scene is named to the model and in the panel: `Chapter 1 › The Ferry` when it sits
 * under a folder, its own title at the top level, so two scenes called "Scene 1" in different
 * chapters are still told apart. Built once per request from `listNodes`, since both callers
 * name many scenes at a time. Shared by the beta reader (F-14.11) and the query ranker.
 */
export function sceneTitles(db: TreeDb): (nodeId: string) => string {
  const rows = listNodes(db)
  const byId = new Map(rows.map((row) => [row.id, row]))
  return (nodeId) => {
    const row = byId.get(nodeId)
    if (row === undefined) return ''
    const parent = row.parentId === null ? undefined : byId.get(row.parentId)
    // The manuscript root is not a chapter; prefixing every scene with "Manuscript" says nothing.
    return parent?.sectionType !== null ? row.title : `${parent.title} › ${row.title}`
  }
}
