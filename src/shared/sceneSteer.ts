import { estimateTokens } from './ai'
import type { TagCategory } from './tags'

/**
 * The scene steer block every prose prompt carries in its task-specific context (F-14.13): the
 * scene's Tone, Content, Plot Threads, and theme (custom) tags, labelled by category, with one
 * sentence telling the model to write by them. The story bible (F-14.9) already lists the
 * scene's tags as one flat, unlabelled list of facts; this block is the instruction. It sits
 * after the stable prefix (CLAUDE.md, token efficiency rule 3) because it changes per scene.
 * `renderSceneSteer` is pure; `src/main/ai/context/sceneSteer.ts` gathers the tags.
 */

/** The categories that steer the writing, in the order their lines come out. */
export const SCENE_STEER_CATEGORIES = [
  'tone',
  'content',
  'plotThread',
  'custom'
] as const satisfies readonly TagCategory[]
export type SceneSteerCategory = (typeof SCENE_STEER_CATEGORIES)[number]

/** Custom tags are where themes live (F-4.13 creates themes as `custom`), so they read as Themes. */
export const SCENE_STEER_LABEL: Record<SceneSteerCategory, string> = {
  tone: 'Tone',
  content: 'Content',
  plotThread: 'Plot threads',
  custom: 'Themes'
}

/** Most names one category line lists; the rest are counted as "… and N more". */
export const SCENE_STEER_NAMES_MAX = 6

/**
 * The block's estimated-token budget (CLAUDE.md, token efficiency rule 8): when the lines at
 * `SCENE_STEER_NAMES_MAX` names would run over it, every line keeps fewer names (down to one,
 * which fits: four lines of one `TAG_NAME_MAX` name each, the heading, and the closing
 * sentence stay under it). Sized so the ghost-text prompt at every other cap still fits its
 * input budget.
 */
export const SCENE_STEER_TOKEN_BUDGET = 120

/** The opening line; the golden tests and the e2e recognise the block by it. */
export const SCENE_STEER_HEADING = 'Scene tags (let them steer the writing):'

const CLAUSE: Record<'tone' | 'content' | 'threads', string> = {
  tone: 'write in this tone',
  content: 'keep to what the content tags allow',
  threads: 'keep these threads and themes in view'
}

function isSteerCategory(category: TagCategory): category is SceneSteerCategory {
  return (SCENE_STEER_CATEGORIES as readonly TagCategory[]).includes(category)
}

function categoryLine(category: SceneSteerCategory, names: string[], keep: number): string {
  const label = SCENE_STEER_LABEL[category]
  if (names.length <= keep) return `${label}: ${names.join(', ')}`
  return `${label}: ${names.slice(0, keep).join(', ')} … and ${names.length - keep} more`
}

/** "a", "a and b", "a, b, and c". */
function joinClauses(clauses: string[]): string {
  if (clauses.length <= 2) return clauses.join(' and ')
  return `${clauses.slice(0, -1).join(', ')}, and ${clauses[clauses.length - 1]}`
}

/**
 * The block for a scene's tags, in the order given (the caller passes `listDocumentTags`
 * order, by name), or null when none of them is in a steer category. Lines: the heading, one
 * `Label: a, b` line per present category in `SCENE_STEER_CATEGORIES` order (at most
 * `SCENE_STEER_NAMES_MAX` names each, fewer when the block would exceed
 * `SCENE_STEER_TOKEN_BUDGET`), then one sentence built from the categories present.
 */
export function renderSceneSteer(
  tags: readonly { category: TagCategory; name: string }[]
): string | null {
  const byCategory = new Map<SceneSteerCategory, string[]>()
  for (const tag of tags) {
    if (!isSteerCategory(tag.category)) continue
    const names = byCategory.get(tag.category) ?? []
    names.push(tag.name)
    byCategory.set(tag.category, names)
  }
  if (byCategory.size === 0) return null

  const clauses: string[] = []
  if (byCategory.has('tone')) clauses.push(CLAUSE.tone)
  if (byCategory.has('content')) clauses.push(CLAUSE.content)
  if (byCategory.has('plotThread') || byCategory.has('custom')) clauses.push(CLAUSE.threads)
  const sentence = joinClauses(clauses)
  const closing = `${sentence.charAt(0).toUpperCase()}${sentence.slice(1)}.`
  const block = (keep: number): string => {
    const lines = SCENE_STEER_CATEGORIES.flatMap((category) => {
      const names = byCategory.get(category)
      return names ? [categoryLine(category, names, keep)] : []
    })
    return [SCENE_STEER_HEADING, ...lines, closing].join('\n')
  }
  for (let keep = SCENE_STEER_NAMES_MAX; keep > 1; keep -= 1) {
    const candidate = block(keep)
    if (estimateTokens(candidate) <= SCENE_STEER_TOKEN_BUDGET) return candidate
  }
  return block(1)
}
