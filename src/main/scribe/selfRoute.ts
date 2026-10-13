import { normalizeForMatch } from '@shared/critique'
import { searchableText } from '@shared/search'
import type { EvidenceKey, SearchHit } from '@shared/scribe'
import { rowTexts } from '../memory/reading/readingFrame'
import type { EvidenceFrame } from './evidence'

/**
 * Self-Route (F-16.25; plan P3 §2.3 step 3, P3-D15): what one `{"need":"chapter 9"}` from Ms
 * Scribe names, as whole scenes of the book in reading order: a chapter by number ("chapter 9",
 * "ch. IX", "9") or by title, a scene by its reference ("9.3") or title, or a range ("9.1-9.4",
 * "7.4 to 9.2", "chapters 7-9"). Only readable manuscript scenes (an Idea scene or a cut one never
 * widens an answer); null when the need names nothing. Pure over the frame.
 */

/** What a need resolved to: its words for the chat ("chapter 9 (9.1–9.6)") and the scenes. */
export interface WidenTarget {
  what: string
  nodeIds: string[]
}

const ROMAN: Readonly<Record<string, number>> = { i: 1, v: 5, x: 10, l: 50, c: 100 }

/** A chapter number written as digits or a small Roman numeral; null for anything else. */
function chapterNumber(text: string): number | null {
  const word = text.trim().toLowerCase()
  if (/^\d{1,3}$/u.test(word)) return Number(word)
  if (!/^[ivxlc]{1,8}$/u.test(word)) return null
  let total = 0
  for (let i = 0; i < word.length; i++) {
    const value = ROMAN[word[i] ?? ''] ?? 0
    const next = ROMAN[word[i + 1] ?? ''] ?? 0
    total += value < next ? -value : value
  }
  return total > 0 ? total : null
}

/** The readable scenes in reading order with their references. */
function readable(frame: EvidenceFrame): { id: string; ref: string }[] {
  return [...frame.reading.order.entries()]
    .sort((a, b) => a[1] - b[1])
    .map(([id]) => ({ id, ref: frame.reading.refs.get(id) ?? '' }))
}

/** The scenes of chapter `n` (a scene that is itself the chapter has the ref "n"). */
const ofChapter = (
  scenes: readonly { id: string; ref: string }[],
  n: number
): { id: string; ref: string }[] =>
  scenes.filter((scene) => scene.ref === String(n) || scene.ref.startsWith(`${n}.`))

/** One end of a range: a scene ref ("9.3") or a chapter number ("9"), as positions. */
function endOf(
  scenes: readonly { id: string; ref: string }[],
  text: string
): { first: number; last: number } | null {
  const word = text.trim()
  const scene = scenes.findIndex((each) => each.ref === word)
  if (/^\d{1,3}\.\d{1,3}$/u.test(word)) return scene < 0 ? null : { first: scene, last: scene }
  const n = chapterNumber(word)
  if (n === null) return null
  const chapter = ofChapter(scenes, n)
  const first = chapter[0]
  const last = chapter.at(-1)
  if (first === undefined || last === undefined) return null
  return { first: scenes.indexOf(first), last: scenes.indexOf(last) }
}

/** "9.1–9.6", "9.3". */
const span = (scenes: readonly { ref: string }[]): string => {
  const first = scenes[0]?.ref ?? ''
  const last = scenes.at(-1)?.ref ?? ''
  return first === last ? first : `${first}–${last}`
}

const titleKey = (title: string): string =>
  normalizeForMatch(searchableText(title))
    .toLowerCase()
    .replace(/^["“'‘]|["”'’]$/gu, '')

/** The readable scenes under a folder, in reading order. */
function scenesUnder(
  frame: EvidenceFrame,
  scenes: readonly { id: string; ref: string }[],
  folderId: string
): { id: string; ref: string }[] {
  const parent = new Map(frame.nodes.map((row) => [row.id, row.parentId]))
  const inside = (id: string): boolean => {
    let at: string | null | undefined = parent.get(id)
    while (at !== null && at !== undefined) {
      if (at === folderId) return true
      at = parent.get(at)
    }
    return false
  }
  return scenes.filter((scene) => scene.id === folderId || inside(scene.id))
}

/** What a need names, or null when it names no readable scene. */
export function resolveNeed(frame: EvidenceFrame, need: string): WidenTarget | null {
  const scenes = readable(frame)
  const text = need
    .trim()
    .replace(/^["“'‘]+|["”'’.]+$/gu, '')
    .trim()
  if (text === '' || scenes.length === 0) return null
  const target = (what: string, picked: { id: string; ref: string }[]): WidenTarget | null =>
    picked.length === 0 ? null : { what, nodeIds: picked.map((scene) => scene.id) }

  // A range: "9.1-9.4", "7.4 to 9.2", "chapters 7-9", "scenes 9.1–9.3".
  const range = /^(?:chapters?|ch\.?|scenes?)?\s*(\S+)\s*(?:-|–|—|to)\s*(\S+)$/iu.exec(text)
  if (range !== null) {
    const from = endOf(scenes, range[1] ?? '')
    const to = endOf(scenes, range[2] ?? '')
    if (from !== null && to !== null && from.first <= to.last) {
      const picked = scenes.slice(from.first, to.last + 1)
      return target(span(picked), picked)
    }
  }
  // One scene by its reference: "9.3", "scene 9.3".
  const ref = /^(?:scene\s+)?(\d{1,3}\.\d{1,3})$/iu.exec(text)
  if (ref !== null) {
    const picked = scenes.filter((scene) => scene.ref === ref[1])
    return target(ref[1] ?? '', picked)
  }
  // A chapter by number: "chapter 9", "ch. IX", "9".
  const numbered = /^(?:chapter|ch\.?)?\s*(\d{1,3}|[ivxlc]{1,8})$/iu.exec(text)
  const n = numbered === null ? null : chapterNumber(numbered[1] ?? '')
  if (n !== null) {
    const picked = ofChapter(scenes, n)
    return target(`chapter ${n} (${span(picked)})`, picked)
  }
  // A chapter, then a scene, by title.
  const key = titleKey(text.replace(/^(?:the\s+)?(?:chapter|scene)\s+/iu, ''))
  if (key === '') return null
  const matches = (title: string): boolean => {
    const own = titleKey(title)
    return own !== '' && (own === key || own.includes(key))
  }
  for (const chapter of frame.nodes) {
    if (chapter.hierarchyLevel !== 'chapter' || !matches(chapter.title)) continue
    const picked = scenesUnder(frame, scenes, chapter.id)
    const title = searchableText(chapter.title).trim()
    if (picked.length > 0) return target(`“${title}” (${span(picked)})`, picked)
  }
  const scene = scenes.find((each) => {
    const row = frame.documents.get(each.id)
    return row !== undefined && matches(row.title)
  })
  return scene === undefined ? null : target(scene.ref, [scene])
}

/** What a scene read costs as the prompt shows it (a generous tag), in tokens. */
function readCost(
  scene: { ref: string; title: string; lines: readonly string[] },
  from: number,
  to: number
): number {
  const tag = `W99 [later in the book, ${scene.ref} ¶${from}–${to}, id n0000] ${scene.title}\n`
  let chars = tag.length
  for (let i = from; i <= to; i++) chars += (scene.lines[i]?.length ?? 0) + 1
  return Math.ceil(chars / 4)
}

/**
 * The scenes of a widening as evidence keys (`W1`…), in reading order, within `budget` tokens
 * (`SCRIBE_WIDEN_TOKENS`): each scene whole that fits, a scene that does not left out and the
 * next still tried. When no scene fits whole (a chapter that is one long scene), the paragraphs of
 * the first that fit, from the turn's first hit in it (else its start), reading on and back, so a
 * long scene is never skipped outright. Empty when nothing fits.
 */
export function widenKeys(
  frame: EvidenceFrame,
  nodeIds: readonly string[],
  options: { budget: number; hits: readonly SearchHit[] } = { budget: Infinity, hits: [] }
): EvidenceKey[] {
  const scenes = nodeIds.flatMap((nodeId) => {
    const row = frame.documents.get(nodeId)
    const texts = row === undefined ? [] : rowTexts(row)
    if (row === undefined || texts.length === 0) return []
    return [
      {
        nodeId,
        ref: frame.reading.refs.get(nodeId) ?? '',
        title: searchableText(row.title).trim() || 'Untitled',
        lines: texts.map((text, i) => `¶${i} ${text}`)
      }
    ]
  })
  const keys: EvidenceKey[] = []
  let used = 0
  for (const scene of scenes) {
    const last = scene.lines.length - 1
    const cost = readCost(scene, 0, last)
    if (used + cost > options.budget) continue
    keys.push({ kind: 'scene', nodeId: scene.nodeId, from: 0, to: last })
    used += cost
  }
  const first = scenes[0]
  if (keys.length > 0 || first === undefined) return keys
  const last = first.lines.length - 1
  const hit = options.hits.find((each) => each.nodeId === first.nodeId && each.para <= last)
  let from = hit?.para ?? 0
  let to = from
  if (readCost(first, from, to) > options.budget) return []
  for (let step = 0; from > 0 || to < last; step++) {
    const after = step % 2 === 0
    const nextFrom = after ? from : from - 1
    const nextTo = after ? to + 1 : to
    if (nextFrom < 0 || nextTo > last) continue
    if (readCost(first, nextFrom, nextTo) > options.budget) break
    from = nextFrom
    to = nextTo
  }
  return [{ kind: 'scene', nodeId: first.nodeId, from, to }]
}
