import { chunkText } from '@shared/editPass'
import { estimateTokens } from '@shared/ai'
import {
  EDIT_FLOW_DEEP_SLICE_TOKENS,
  EDIT_FLOW_FAMILIES,
  EDIT_FLOW_FAMILY,
  EDIT_FLOW_QUICK_SLICE_TOKENS,
  type EditFlowCategory,
  type EditFlowDepth,
  type EditFlowFamily
} from '@shared/editFlow'

/**
 * The edit flow's request plan (notes redesign phase 2), pure: the scope's scenes cut into slices
 * (Quick: a chapter at a time, Deep: as much of the book as one budget-sized request holds), and
 * one request per slice and family, slice by slice so a stopped run keeps whole slices.
 */

/** A scene of the scope, in reading order, with its text as paragraphs split by blank lines. */
export interface FlowScene {
  nodeId: string
  /** `n5`, the ref the book map and the slices name it by. */
  ref: string
  /** `Chapter › Scene`, or the scene's own title outside a chapter. */
  title: string
  /** The folder the scene sits in (its chapter), or null at the top of the manuscript. */
  chapterId: string | null
  chapterTitle: string | null
  text: string
}

/** A scene, or one piece of a long one, as one slice carries it. */
export interface FlowSliceItem {
  nodeId: string
  ref: string
  title: string
  text: string
  part: { index: number; count: number }
}

export interface FlowSlice {
  /** What the slice is called in the prompt and above its overview ("Chapter 3"). */
  label: string
  items: FlowSliceItem[]
  /** The estimated tokens of its text. */
  tokens: number
}

export interface FlowRequest {
  slice: number
  family: EditFlowFamily
}

/** The scene text one request of `depth` reads at most. */
export function sliceBudget(depth: EditFlowDepth): number {
  return depth === 'quick' ? EDIT_FLOW_QUICK_SLICE_TOKENS : EDIT_FLOW_DEEP_SLICE_TOKENS
}

const itemTokens = (item: Pick<FlowSliceItem, 'text'>): number => estimateTokens(item.text) + 12

/** A scene as the items it is sent in: whole, or cut at paragraph breaks into pieces that fit. */
function itemsOf(scene: FlowScene, budget: number): FlowSliceItem[] {
  const pieces = estimateTokens(scene.text) <= budget ? [scene.text] : chunkText(scene.text, budget * 4)
  return pieces.map((text, index) => ({
    nodeId: scene.nodeId,
    ref: scene.ref,
    title: scene.title,
    text,
    part: { index, count: pieces.length }
  }))
}

function labelOf(items: readonly FlowSliceItem[], scenes: ReadonlyMap<string, FlowScene>): string {
  const first = items[0]
  const last = items.at(-1)
  if (first === undefined || last === undefined) return ''
  const chapters = new Set(items.map((item) => scenes.get(item.nodeId)?.chapterId ?? null))
  const chapter = scenes.get(first.nodeId)
  if (chapters.size === 1 && chapter?.chapterTitle != null && items.length > 1) {
    return chapter.chapterTitle
  }
  if (first.nodeId === last.nodeId) return first.title
  return `${first.title} to ${last.title}`
}

/**
 * The scope's scenes as slices, in reading order. Quick starts a new slice at every chapter (and
 * when the next scene would pass the budget); Deep only at the budget. A scene longer than the
 * budget goes in pieces, each its own item.
 */
export function sliceScenes(scenes: readonly FlowScene[], depth: EditFlowDepth): FlowSlice[] {
  const budget = sliceBudget(depth)
  const byId = new Map(scenes.map((scene) => [scene.nodeId, scene]))
  const slices: FlowSlice[] = []
  let current: FlowSliceItem[] = []
  let used = 0
  let chapter: string | null | undefined
  const close = (): void => {
    if (current.length === 0) return
    slices.push({ label: labelOf(current, byId), items: current, tokens: used })
    current = []
    used = 0
  }
  for (const scene of scenes) {
    if (depth === 'quick' && chapter !== undefined && scene.chapterId !== chapter) close()
    chapter = scene.chapterId
    for (const item of itemsOf(scene, budget)) {
      const cost = itemTokens(item)
      if (used + cost > budget) close()
      current.push(item)
      used += cost
    }
  }
  close()
  return slices
}

/** The families the picked categories are asked in, in the flow's order. */
export function flowFamilies(categories: readonly EditFlowCategory[]): EditFlowFamily[] {
  const wanted = new Set(categories.map((category) => EDIT_FLOW_FAMILY[category]))
  return EDIT_FLOW_FAMILIES.filter((family) => wanted.has(family))
}

/** One request per slice and family: every family of a slice before the next slice. */
export function planRequests(
  slices: readonly FlowSlice[],
  families: readonly EditFlowFamily[]
): FlowRequest[] {
  return slices.flatMap((_, slice) => families.map((family) => ({ slice, family })))
}
