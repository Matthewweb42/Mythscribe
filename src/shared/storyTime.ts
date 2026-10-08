import { estimateTokens } from './ai'
import type { SceneStatus } from './sceneMeta'

/**
 * Story time (F-5.23): where "now" is in the book, so the AI never takes an event the author has
 * only planned for one that has happened. Now is the scene the author is in; everything the
 * manuscript shows up to and including it has happened, the scenes after it are later in the
 * book, and the author's sheets, notes, synopses, beats, and planned scenes are plans. This file
 * owns the pure parts: the planned / drafted / revised rule the outline shows (F-11.1d), where a
 * scene sits relative to now, and the compact story map the prompts carry.
 * `src/main/ai/context/storyTime.ts` gathers the rows.
 */

/** Where a scene stands as writing: no text yet, written, or revised. */
export const SCENE_PROGRESS = ['planned', 'drafted', 'revised'] as const
export type SceneProgress = (typeof SCENE_PROGRESS)[number]

export const SCENE_PROGRESS_LABEL: Record<SceneProgress, string> = {
  planned: 'Planned',
  drafted: 'Drafted',
  revised: 'Revised'
}

/**
 * The rule (F-11.1d, decided by Claude, unconfirmed): a document with no words is Planned
 * whatever its status says, since nothing in it can have happened; one with words is Revised
 * when its status is Revised or Final and Drafted otherwise (no status, Idea, or Draft). The
 * real content decides planned against written; the status field only tells drafted from
 * revised.
 */
export function sceneProgress(wordCount: number, status: SceneStatus): SceneProgress {
  if (wordCount <= 0) return 'planned'
  return status === 'revised' || status === 'final' ? 'revised' : 'drafted'
}

/**
 * A chapter's or part's progress from its documents': Planned while none has text, Revised once
 * every one is revised, Drafted in between; null for a folder with no document under it.
 */
export function folderProgress(documents: readonly SceneProgress[]): SceneProgress | null {
  if (documents.length === 0) return null
  if (documents.every((progress) => progress === 'planned')) return 'planned'
  if (documents.every((progress) => progress === 'revised')) return 'revised'
  return 'drafted'
}

/** Where a manuscript scene sits relative to now. */
export const STORY_POSITIONS = ['earlier', 'now', 'later'] as const
export type StoryPosition = (typeof STORY_POSITIONS)[number]

/**
 * How now was found: `open`, the scene the author is in (or the last scene of the chapter they
 * selected); `latest`, no manuscript scene is selected, so the latest scene with text; `none`,
 * nothing is written, so nothing has happened.
 */
export type NowBasis = 'open' | 'latest' | 'none'

export interface StoryNow {
  nowId: string | null
  basis: NowBasis
}

/**
 * Now, from the manuscript documents in reading order and the document the selection points at
 * (already resolved from a chapter to its last document; null when the selection is outside the
 * manuscript or there is none).
 */
export function resolveNow(
  documents: readonly { id: string; wordCount: number }[],
  activeDocumentId: string | null
): StoryNow {
  if (activeDocumentId !== null && documents.some((doc) => doc.id === activeDocumentId)) {
    return { nowId: activeDocumentId, basis: 'open' }
  }
  const latest = [...documents].reverse().find((doc) => doc.wordCount > 0)
  return latest === undefined
    ? { nowId: null, basis: 'none' }
    : { nowId: latest.id, basis: 'latest' }
}

/**
 * Where `id` sits in `order` (the manuscript documents in reading order) relative to `nowId`;
 * null for a node outside the manuscript. With nothing written (`nowId` null) every scene is
 * later: nothing has happened yet.
 */
export function positionIn(
  order: readonly string[],
  nowId: string | null,
  id: string
): StoryPosition | null {
  const at = order.indexOf(id)
  if (at < 0) return null
  const now = nowId === null ? -1 : order.indexOf(nowId)
  if (now < 0) return 'later'
  return at < now ? 'earlier' : at === now ? 'now' : 'later'
}

/** How a lookup result names a scene's position, for the model. */
export const STORY_POSITION_NOTE: Record<StoryPosition, string> = {
  earlier: 'before now: has happened',
  now: 'now: the scene the author is at',
  later: 'after now: has not happened yet'
}

/** One line of the map: a folder, or a document with its progress and stored summary. */
export interface StoryMapItem {
  id: string
  /** The name the prompt uses for the node (`n7` for the agent), or '' for none. */
  ref: string
  title: string
  depth: number
  kind: 'folder' | 'document'
  /** Documents only. */
  progress: SceneProgress | null
  /** The stored scene summary (F-5.6), or null; cut to one line by the renderer. */
  summary: string | null
}

/** The map's opening line; the golden tests and the e2e recognise the block by it. */
export const STORY_MAP_HEADING =
  'Story map (the manuscript in reading order; "▶ NOW" marks where the author is: what the ' +
  'scenes up to and including it show has happened, the scenes after it have not happened yet):'
export const STORY_MAP_NOW_MARK = '▶ NOW'
/** The line under the heading when no manuscript scene is selected. */
export const STORY_MAP_LATEST_NOTE = 'No scene is open, so now is the latest written scene.'
/** The line under the heading when no scene has text. */
export const STORY_MAP_NOTHING_WRITTEN =
  'Nothing is written yet: every scene is planned, so nothing has happened.'
/** A summary in the map is its first sentence, within this many characters. */
export const STORY_MAP_SUMMARY_CHARS = 120
/** The map's estimated-token budget in the chat agent's prompt (F-5.22). */
export const STORY_MAP_TOKEN_BUDGET = 1_200
/** The map's budget in What should come next? (F-5.17), whose whole input is 4,000. */
export const STORY_MAP_SMALL_TOKEN_BUDGET = 400

/** A summary as one map line: the first sentence, flattened, cut with an ellipsis. */
export function mapSummary(summary: string, max = STORY_MAP_SUMMARY_CHARS): string {
  const flat = summary.replace(/\s+/gu, ' ').trim()
  const sentence = /^.*?[.!?…](?=\s|$)/u.exec(flat)?.[0] ?? flat
  return sentence.length <= max ? sentence : `${sentence.slice(0, max - 1).trimEnd()}…`
}

function itemLine(item: StoryMapItem, now: boolean, summary: boolean): string {
  const head = `${'  '.repeat(item.depth)}${item.ref ? `${item.ref} ` : ''}${item.title}`
  if (item.kind === 'folder') return head
  const mark = now ? ` ${STORY_MAP_NOW_MARK}` : ''
  const about = summary && item.summary ? `: ${mapSummary(item.summary)}` : ''
  return `${head} [${item.progress ?? 'planned'}]${mark}${about}`
}

const cost = (line: string): number => estimateTokens(`${line}\n`)

/**
 * The story map within `maxTokens` estimated tokens, or null for a manuscript with no document.
 * Every folder and document in reading order, each document with its progress, now marked, and
 * the stored summaries of written scenes as one line each. Admitted by priority when the budget
 * is short (CLAUDE.md, token rule 8): the heading and the scenes' lines first — and if even those
 * do not fit, a window of scenes around now, the rest counted as "… N earlier scenes" and
 * "… N later scenes" — then the summaries, now's first, then the earlier scenes nearest now, then
 * the later ones nearest now, each whole or not at all.
 */
export function renderStoryMap(
  items: readonly StoryMapItem[],
  now: StoryNow,
  maxTokens: number
): string | null {
  const docIndexes = items.flatMap((item, index) => (item.kind === 'document' ? [index] : []))
  if (docIndexes.length === 0) return null
  const nowDoc = now.nowId === null ? -1 : docIndexes.findIndex((i) => items[i]?.id === now.nowId)
  const centre = nowDoc < 0 ? 0 : nowDoc
  const note =
    now.basis === 'none'
      ? STORY_MAP_NOTHING_WRITTEN
      : now.basis === 'latest'
        ? STORY_MAP_LATEST_NOTE
        : null
  const head = [STORY_MAP_HEADING, ...(note === null ? [] : [note])]
  let used = head.reduce((sum, line) => sum + cost(line), 0)

  // The ancestors of each item, so a kept document brings its chapter and part lines with it.
  const parents: number[][] = []
  const stack: number[] = []
  items.forEach((item, index) => {
    while (stack.length > 0 && (items[stack.at(-1) ?? 0]?.depth ?? 0) >= item.depth) stack.pop()
    parents.push([...stack])
    if (item.kind === 'folder') stack.push(index)
  })

  const isNow = (index: number): boolean => nowDoc >= 0 && docIndexes[nowDoc] === index
  const shown = new Set<number>()
  const show = (index: number): boolean => {
    const needed = [...(parents[index] ?? []), index].filter((i) => !shown.has(i))
    const extra = needed.reduce((sum, i) => {
      const item = items[i]
      return item === undefined ? sum : sum + cost(itemLine(item, isNow(i), false))
    }, 0)
    if (used + extra > maxTokens) return false
    for (const i of needed) shown.add(i)
    used += extra
    return true
  }

  const cutLine = (n: number, side: string): string =>
    `… ${n} ${side} ${n === 1 ? 'scene' : 'scenes'}`
  const whole = items.reduce((sum, item, i) => sum + cost(itemLine(item, isNow(i), false)), 0)
  // Too long even without summaries: room is kept for the two lines that count what was cut.
  if (used + whole > maxTokens) {
    used += cost(cutLine(99_999, 'earlier')) + cost(cutLine(99_999, 'later'))
  }

  // Documents by distance from now, ties to the earlier one; a window, so stop at the first miss.
  const byDistance = docIndexes
    .map((index, position) => ({ index, distance: Math.abs(position - centre), position }))
    .sort((a, b) => a.distance - b.distance || a.position - b.position)
  let lo = centre
  let hi = centre
  for (const { index, position } of byDistance) {
    if (!show(index)) break
    lo = Math.min(lo, position)
    hi = Math.max(hi, position)
  }
  if (shown.size === 0) return head.join('\n')
  // Folders with no document (an empty chapter) inside the window still show: they are plans.
  const start = lo === 0 ? 0 : (docIndexes[lo] ?? 0)
  const end = hi === docIndexes.length - 1 ? items.length - 1 : (docIndexes[hi] ?? 0)
  for (let i = start; i <= end; i++) {
    if (items[i]?.kind === 'folder' && !shown.has(i)) show(i)
  }
  const earlierCut = lo
  const laterCut = docIndexes.length - 1 - hi

  const summarized = new Set<number>()
  const candidates = byDistance
    .filter(({ index }) => shown.has(index) && items[index]?.summary)
    .sort((a, b) => {
      const side = (position: number): number => (position <= centre ? 0 : 1)
      return side(a.position) - side(b.position) || a.distance - b.distance
    })
  for (const { index } of candidates) {
    const item = items[index]
    if (item === undefined) continue
    const extra =
      cost(itemLine(item, isNow(index), true)) - cost(itemLine(item, isNow(index), false))
    if (used + extra > maxTokens) continue
    summarized.add(index)
    used += extra
  }

  const lines = [...head]
  if (earlierCut > 0) lines.push(cutLine(earlierCut, 'earlier'))
  items.forEach((item, index) => {
    if (shown.has(index)) lines.push(itemLine(item, isNow(index), summarized.has(index)))
  })
  if (laterCut > 0) lines.push(cutLine(laterCut, 'later'))
  return lines.join('\n')
}
