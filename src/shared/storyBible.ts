import { estimateTokens } from './ai'
import type { EntityKind } from './entities'
import type { TagCategory } from './tags'

/**
 * The story bible block every prose prompt carries (F-14.9): the project's story facts as
 * ground truth, rendered once and placed in the stable prefix after the voice profile
 * (CLAUDE.md, token efficiency rule 3). Today the facts are the tag bank in its four story
 * categories, the scene's tags, its place in the manuscript, and the scenes either side with
 * their metadata and their scene summaries (F-5.6), and — since F-5.16 — the entity sheets of
 * the scene's tags with what the manuscript itself states about them (observed facts).
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
  /** The neighbour's stored scene summary (F-5.6), or null while it has none. */
  summary: string | null
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

/** Longest value of one sheet field or observed fact in an entity line; a longer one is cut with "…". */
export const STORY_BIBLE_VALUE_MAX = 120

/** What introduces the observed facts in an entity line; the sheet before it is the author's word. */
export const STORY_BIBLE_OBSERVED_LABEL = 'Seen in the manuscript:'

/** One stated thing about an entity: the sheet field's (or the fact's attribute's) label and its value. */
export interface StoryBibleEntry {
  label: string
  value: string
}

/**
 * One entity of the story bible as a prompt carries it (F-5.16): the author's own sheet, and
 * then what the manuscript states that the sheet does not already say. The sheet comes first
 * and wins every conflict (F-14.9), which is why a fact whose attribute the sheet fills is left
 * out by the gatherer rather than set beside it.
 */
export interface StoryBibleEntity {
  /** The entity's id when it came from the project (query.v3 names the sheets it sent by it). */
  entityId?: string
  name: string
  kind: EntityKind
  /** The filled fields of the author's sheet, in template order. */
  sheet: StoryBibleEntry[]
  /** The observed facts the sheet does not cover, merged (`groupFacts`), in template order. */
  observed: StoryBibleEntry[]
}

export interface StoryBibleFacts {
  /** Every bank tag in a story category, in `tag:list` order. */
  bank: { category: StoryBibleCategory; name: string }[]
  /** The current scene's place in the manuscript, or null outside the manuscript. */
  scene: StoryBibleScene | null
  previous: SceneNeighbor | null
  next: SceneNeighbor | null
  /**
   * The entities linked to the scene's tags (F-5.16), in story-bible order; absent or empty for
   * a project without entities, which renders exactly as before.
   */
  entities?: StoryBibleEntity[]
}

/** A cut category line keeps at least this many names before "… and N more". */
const MIN_NAMES_WHEN_CUT = 1

/**
 * Renders the block within `maxTokens` estimated tokens, or null when the facts say nothing
 * (an empty bank, no neighbour, and no tag on the scene). Lines come out in a fixed order
 * (heading, categories, this scene, previous, next, the two neighbours' summaries), but are
 * admitted by priority when the budget is short (CLAUDE.md, token efficiency rule 8): the
 * heading and the scene line always, then the neighbours, then each category in order, cut to
 * fit with "… and N more" rather than dropped, and last the neighbours' summaries (F-5.6),
 * each whole or not at all — half a summary states a fact the scene does not. A bank line
 * that cannot keep even one name is dropped whole.
 *
 * F-5.16: the entities of the scene's tags follow the scene line, one line each. Their sheets
 * are admitted after the bank and ahead of the neighbours' summaries (the author's own word
 * about who is in the scene), their observed facts last of all, so facts are dropped before
 * sheets (`renderStoryBibleEntities`).
 */
export function renderStoryBible(facts: StoryBibleFacts, maxTokens: number): string | null {
  const hasTags = facts.scene !== null && facts.scene.tags.length > 0
  if (facts.bank.length === 0 && facts.previous === null && facts.next === null && !hasTags) {
    return null
  }

  const sceneLine = facts.scene ? renderScene(facts.scene) : null

  const base = [STORY_BIBLE_HEADING, sceneLine].filter((line): line is string => line !== null)
  let used = estimateTokens(base.join('\n'))
  const fits = (line: string): boolean => estimateTokens(`${line}\n`) + used <= maxTokens
  const admit = (line: string, into: string[]): void => {
    if (!fits(line)) return
    into.push(line)
    used += estimateTokens(`${line}\n`)
  }

  const sides = [
    { label: 'Previous', neighbor: facts.previous },
    { label: 'Next', neighbor: facts.next }
  ]
  const neighbours: string[] = []
  // Only a neighbour whose own line got in carries its summary: a summary with no scene line
  // to hang on reads as a fact about nothing.
  const withSummary: { label: string; summary: string }[] = []
  for (const { label, neighbor } of sides) {
    if (neighbor === null) continue
    const line = `${label} scene: ${renderNeighbor(neighbor)}`
    const before = neighbours.length
    admit(line, neighbours)
    if (neighbours.length === before) continue
    if (neighbor.summary) withSummary.push({ label, summary: neighbor.summary })
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

  const entityLines = entityAdmission(facts.entities ?? [])
  used += entityLines.admitSheets(maxTokens - used)

  const summaries: string[] = []
  for (const { label, summary } of withSummary) {
    admit(`${label} scene summary: ${summary}`, summaries)
  }

  entityLines.admitObserved(maxTokens - used)

  return [
    STORY_BIBLE_HEADING,
    ...categories,
    sceneLine,
    ...entityLines.lines(),
    ...neighbours,
    ...summaries
  ]
    .filter((line): line is string => line !== null)
    .join('\n')
}

/** A value on one line and within `valueMax` characters: a sheet field can run to pages. */
function cutValue(value: string, valueMax: number): string {
  const flat = value.replace(/\s+/gu, ' ').trim()
  return flat.length <= valueMax ? flat : `${flat.slice(0, valueMax).trimEnd()}…`
}

const renderEntries = (entries: readonly StoryBibleEntry[], valueMax: number): string =>
  entries.map((entry) => `${entry.label}: ${cutValue(entry.value, valueMax)}`).join('; ')

/** One entity's line with its sheet and the first `observed` of its facts; null when both are empty. */
function renderEntity(
  entity: StoryBibleEntity,
  withSheet: boolean,
  observed: number,
  valueMax: number
): string | null {
  const sheet = withSheet && entity.sheet.length > 0 ? renderEntries(entity.sheet, valueMax) : ''
  const seen =
    observed > 0
      ? `${STORY_BIBLE_OBSERVED_LABEL} ${renderEntries(entity.observed.slice(0, observed), valueMax)}`
      : ''
  if (sheet === '' && seen === '') return null
  // Each part closes as a sentence; a value that already ends one is not given a second stop.
  const stated = [sheet, seen]
    .filter((part) => part !== '')
    .map((part) => (/[.!?…]$/u.test(part) ? part : `${part}.`))
    .join(' ')
  return `${entity.name} (${entity.kind}): ${stated}`
}

/**
 * The two-pass admission of the entity lines, shared by the prose bible and the query bible so
 * both drop the same things first: `admitSheets` lets in each entity's sheet line while it fits
 * `room` estimated tokens, and `admitObserved` then adds each entity's observed facts — to its
 * sheet line, or as a line of their own for an entity with no sheet (or whose sheet did not
 * fit) — as many as fit, earliest attribute first. Both answer the tokens they spent.
 */
function entityAdmission(
  entities: readonly StoryBibleEntity[],
  valueMax: number = STORY_BIBLE_VALUE_MAX
): {
  admitSheets: (room: number) => number
  admitObserved: (room: number) => number
  lines: () => string[]
} {
  const admitted: (string | null)[] = entities.map(() => null)
  const cost = (line: string | null): number => (line === null ? 0 : estimateTokens(`${line}\n`))
  return {
    admitSheets: (room) => {
      let spent = 0
      entities.forEach((entity, index) => {
        const line = renderEntity(entity, true, 0, valueMax)
        if (line === null || spent + cost(line) > room) return
        admitted[index] = line
        spent += cost(line)
      })
      return spent
    },
    admitObserved: (room) => {
      let spent = 0
      entities.forEach((entity, index) => {
        const before = admitted[index] ?? null
        for (let keep = entity.observed.length; keep > 0; keep -= 1) {
          const line = renderEntity(entity, before !== null, keep, valueMax)
          const extra = cost(line) - cost(before)
          if (line === null || spent + extra > room) continue
          admitted[index] = line
          spent += extra
          break
        }
      })
      return spent
    },
    lines: () => admitted.filter((line): line is string => line !== null)
  }
}

/**
 * Entity lines on their own within `maxTokens` (F-5.16): what Story Intelligence carries under
 * its own heading. Sheets first, then the observed facts, so the facts are what a short budget
 * drops. Empty when nothing fits or nothing is stated.
 */
export function renderStoryBibleEntities(
  entities: readonly StoryBibleEntity[],
  maxTokens: number,
  /** Characters per value; query.v3 sends longer sheet values than the prose bible's default. */
  valueMax: number = STORY_BIBLE_VALUE_MAX
): string[] {
  const admission = entityAdmission(entities, valueMax)
  const spent = admission.admitSheets(maxTokens)
  admission.admitObserved(maxTokens - spent)
  return admission.lines()
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
