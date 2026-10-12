import { queryTerms } from '../searchTerms'

/**
 * Plan links applied automatically (F-16.21, decision 2; plan P2a §5.2): the code half. A planned
 * scene (a manuscript scene with no text yet) is matched against the drafted scenes by what both
 * say: the plan's title and synopsis against the scene's title and its card's line and gist (the
 * AI's map of it), plus the records both name. Pure: main gathers the sides (`memory/reading/
 * planLinks.ts`) and applies what this decides.
 *
 * The score is the share of the plan's terms the scene holds (`planScore`, 0 to 1). A record the
 * plan names is one term: the words of the name that resolved to it are not counted again as
 * words, so a shared character name is one shared term, never two. A plan is linked by code only
 * when the match is unambiguous: the best scene scores at least `PLAN_MATCH_MIN`, shares at least
 * `PLAN_MATCH_MIN_SHARED` terms with the plan, at least one of them a word rather than a record
 * (a scene that only names the same people is not the plan), and scores at least
 * `PLAN_MATCH_RATIO` times the runner-up, wherever the runner-up scores. When the best qualifies
 * but the runner-up is within the ratio, the match is `ambiguous` and `planLinks.v2` may choose
 * between them (main allows one call per reading, only when the reading moved one of their card
 * lines). A `blocked` scene (one the author unlinked from this plan) is ranked like any other but
 * never linked: when it is the best, or one of an ambiguous best two, nothing is linked, so an
 * *Unlink* never hands the plan to the runner-up. Anything else is no match: the plan reads *Not
 * yet drafted*. Thresholds decided by Claude on the fixtures, unconfirmed (`QUESTIONS.md`, P2a
 * slice 5).
 */

/** The least share of the plan's terms the best scene must hold. */
export const PLAN_MATCH_MIN = 0.35
/** How many times the runner-up's score the best one must be to need no AI. */
export const PLAN_MATCH_RATIO = 1.5
/** The fewest terms the plan and the best scene must share (one shared word is a coincidence). */
export const PLAN_MATCH_MIN_SHARED = 2

/** A planned scene as the matcher reads it. */
export interface PlanSide {
  id: string
  title: string
  synopsis: string
  /** The records its title and synopsis name for certain. */
  records: readonly string[]
  /** The words that named those records, as the plan writes them (counted once, as the record). */
  names: readonly string[]
}

/** A drafted scene as the matcher reads it: its title, its card's line and gist, who it names. */
export interface SceneSide {
  id: string
  title: string
  line: string
  gist: string
  /** The records the scene names for certain (the name scan). */
  records: readonly string[]
}

/** One scene's score against a plan. */
export interface PlanScore {
  sceneId: string
  score: number
  /** How many of the plan's terms the scene holds. */
  shared: number
  /** How many of those are words (not records). */
  words: number
}

export type PlanMatch =
  | { kind: 'none' }
  | { kind: 'link'; sceneId: string; score: number }
  | { kind: 'ambiguous'; top: readonly [PlanScore, PlanScore] }

/** A plain English plural folded to its singular ("docks" → "dock", "stories" → "story"). */
function fold(word: string): string {
  if (word.length > 4 && word.endsWith('ies')) return `${word.slice(0, -3)}y`
  if (word.length > 3 && word.endsWith('s') && !word.endsWith('ss')) return word.slice(0, -1)
  return word
}

/** The words of a text that mean something to the match: search terms, plurals folded. */
export function planWords(text: string): Set<string> {
  return new Set(queryTerms(text).map(fold))
}

const recordTerm = (id: string): string => `\u0000${id}`

/** A plan's terms: its words (less the words of the names that resolved) and its records. */
function planTerms(plan: PlanSide): Set<string> {
  const terms = planWords(`${plan.title} ${plan.synopsis}`)
  for (const name of plan.names) for (const word of planWords(name)) terms.delete(word)
  for (const id of plan.records) terms.add(recordTerm(id))
  return terms
}

function sceneTerms(scene: SceneSide): Set<string> {
  const terms = planWords(`${scene.title} ${scene.line} ${scene.gist}`)
  for (const id of scene.records) terms.add(recordTerm(id))
  return terms
}

/** The share of the plan's terms the scene holds, how many that is, and how many are words. */
export function planScore(plan: PlanSide, scene: SceneSide): PlanScore {
  const wanted = planTerms(plan)
  if (wanted.size === 0) return { sceneId: scene.id, score: 0, shared: 0, words: 0 }
  const held = sceneTerms(scene)
  let shared = 0
  let words = 0
  for (const term of wanted) {
    if (!held.has(term)) continue
    shared += 1
    if (!term.startsWith('\u0000')) words += 1
  }
  return { sceneId: scene.id, score: shared / wanted.size, shared, words }
}

/** Whether a scene's score could link it at all: the floor, enough terms, at least one a word. */
export function qualifies(score: PlanScore): boolean {
  return score.score >= PLAN_MATCH_MIN && score.shared >= PLAN_MATCH_MIN_SHARED && score.words >= 1
}

/**
 * The plan's match among `scenes` (in reading order; ties keep that order): a link, an ambiguous
 * best two, or none. A plan with fewer than `PLAN_MATCH_MIN_SHARED` terms of its own never
 * matches (a one-word title says too little). `blocked` scenes rank but never link (above).
 */
export function matchPlan(
  plan: PlanSide,
  scenes: readonly SceneSide[],
  blocked: ReadonlySet<string> = new Set()
): PlanMatch {
  if (planTerms(plan).size < PLAN_MATCH_MIN_SHARED) return { kind: 'none' }
  const ranked = scenes
    .map((scene, index) => ({ ...planScore(plan, scene), index }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
  const best = ranked[0]
  if (best === undefined || !qualifies(best) || blocked.has(best.sceneId)) return { kind: 'none' }
  const second = ranked[1]
  if (second === undefined || best.score >= PLAN_MATCH_RATIO * second.score) {
    return { kind: 'link', sceneId: best.sceneId, score: best.score }
  }
  if (blocked.has(second.sceneId)) return { kind: 'none' }
  const strip = ({ sceneId, score, shared, words }: PlanScore): PlanScore => ({
    sceneId,
    score,
    shared,
    words
  })
  return { kind: 'ambiguous', top: [strip(best), strip(second)] }
}
