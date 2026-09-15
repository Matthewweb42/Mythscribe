import { estimateTokens } from './ai'
import type { TagCategory } from './tags'

/**
 * The story bible block every prose prompt carries (F-14.9): the project's story facts as
 * ground truth, rendered once and placed in the stable prefix after the voice profile
 * (CLAUDE.md, token efficiency rule 3). Today the facts are the tag bank in its four story
 * categories, the scene's tags, its place in the manuscript, and the scenes either side with
 * their metadata; F-9 entity sheets and F-5.6 summaries plug into the same shape later.
 * `renderStoryBible` is pure; `src/main/ai/context/storyBible.ts` gathers the facts.
 */

/** The estimated-token budget for the block in chat, critique, and rewrite prompts. */
export const STORY_BIBLE_TOKEN_BUDGET = 400
/** Ghost text runs on every pause, so its bible is the cast and places, little more. */
export const STORY_BIBLE_GHOST_TOKEN_BUDGET = 150

/** The tag categories that state story facts; tone, content, and custom tags are labels, not facts. */
export const STORY_BIBLE_CATEGORIES = [
  'character',
  'setting',
  'worldBuilding',
  'plotThread'
] as const satisfies readonly TagCategory[]
export type StoryBibleCategory = (typeof STORY_BIBLE_CATEGORIES)[number]

export const STORY_BIBLE_CATEGORY_LABEL: Record<StoryBibleCategory, string> = {
  character: 'Characters',
  setting: 'Settings',
  worldBuilding: 'World',
  plotThread: 'Plot threads'
}

/**
 * The opening line. It states the ground-truth rule ("entity sheets win conflicts"), and the
 * e2e and the golden tests recognise the block by it, so it must not change within a prompt
 * version.
 */
export const STORY_BIBLE_HEADING =
  'Story bible (ground truth: use only the characters and places it names; where the passage ' +
  'and the bible disagree, follow the bible):'

export interface SceneNeighbor {
  title: string
  location: string
  pov: string
  timeline: string
}

export interface StoryBibleScene {
  title: string
  /** The titles of the containing folders, nearest first (chapter, then part). */
  ancestors: string[]
  /** 1-based position among the sibling documents, and how many there are. */
  index: number
  count: number
  /** The names of the tags linked to the scene, in bank order. */
  tags: string[]
}

export interface StoryBibleFacts {
  /** Every bank tag in a story category, in `tag:list` order. */
  bank: { category: StoryBibleCategory; name: string }[]
  /** The current scene's place in the manuscript, or null outside the manuscript. */
  scene: StoryBibleScene | null
  previous: SceneNeighbor | null
  next: SceneNeighbor | null
}

/** A cut category line keeps at least this many names before "… and N more". */
const MIN_NAMES_WHEN_CUT = 1

/**
 * Renders the block within `maxTokens` estimated tokens, or null when the facts say nothing
 * (an empty bank, no neighbour, and no tag on the scene). Lines come out in a fixed order
 * (heading, categories, this scene, previous, next), but are admitted by priority when the
 * budget is short (CLAUDE.md, token efficiency rule 8): the heading and the scene line
 * always, then the neighbours, then each category in order, cut to fit with "… and N more"
 * rather than dropped. A bank line that cannot keep even one name is dropped whole.
 */
export function renderStoryBible(facts: StoryBibleFacts, maxTokens: number): string | null {
  const hasTags = facts.scene !== null && facts.scene.tags.length > 0
  if (facts.bank.length === 0 && facts.previous === null && facts.next === null && !hasTags) {
    return null
  }

  const sceneLine = facts.scene ? renderScene(facts.scene) : null
  const previousLine = facts.previous ? `Previous scene: ${renderNeighbor(facts.previous)}` : null
  const nextLine = facts.next ? `Next scene: ${renderNeighbor(facts.next)}` : null

  const base = [STORY_BIBLE_HEADING, sceneLine].filter((line): line is string => line !== null)
  let used = estimateTokens(base.join('\n'))
  const fits = (line: string): boolean => estimateTokens(`${line}\n`) + used <= maxTokens

  const neighbours: string[] = []
  for (const line of [previousLine, nextLine]) {
    if (line !== null && fits(line)) {
      neighbours.push(line)
      used += estimateTokens(`${line}\n`)
    }
  }

  const categories: string[] = []
  for (const category of STORY_BIBLE_CATEGORIES) {
    const names = facts.bank.filter((entry) => entry.category === category).map((e) => e.name)
    if (names.length === 0) continue
    const line = cutCategoryLine(category, names, maxTokens - used)
    if (line === null) continue
    categories.push(line)
    used += estimateTokens(`${line}\n`)
  }

  return [STORY_BIBLE_HEADING, ...categories, sceneLine, ...neighbours]
    .filter((line): line is string => line !== null)
    .join('\n')
}

function renderScene(scene: StoryBibleScene): string {
  const where = scene.ancestors.map((title) => `, in "${title}"`).join('')
  const tagged = scene.tags.length ? `; tagged ${scene.tags.join(', ')}` : ''
  return `This scene: "${scene.title}"${where}, scene ${scene.index} of ${scene.count}${tagged}.`
}

function renderNeighbor(neighbor: SceneNeighbor): string {
  const fields = [
    neighbor.location ? `location ${neighbor.location}` : null,
    neighbor.pov ? `POV ${neighbor.pov}` : null,
    neighbor.timeline ? `timeline ${neighbor.timeline}` : null
  ].filter((field): field is string => field !== null)
  return `"${neighbor.title}"${fields.length ? ` (${fields.join(', ')})` : ''}.`
}

/** The category line with as many names as fit in `room` tokens, or null when not even one does. */
function cutCategoryLine(
  category: StoryBibleCategory,
  names: string[],
  room: number
): string | null {
  const label = STORY_BIBLE_CATEGORY_LABEL[category]
  const whole = `${label}: ${names.join(', ')}`
  if (estimateTokens(`${whole}\n`) <= room) return whole
  for (let keep = names.length - 1; keep >= MIN_NAMES_WHEN_CUT; keep -= 1) {
    const cut = `${label}: ${names.slice(0, keep).join(', ')} … and ${names.length - keep} more`
    if (estimateTokens(`${cut}\n`) <= room) return cut
  }
  return null
}
