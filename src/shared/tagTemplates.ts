import { z } from 'zod'
import { TagExchangeRecord } from './tagExchange'
import type { TagCategory } from './tags'

/**
 * Tag templates (F-4.3): the four seeded tag banks an author can load into a project. One owner
 * for ids, labels, and tag lists; main creates the tags (skipping names already in the bank), the
 * renderer builds the loader and its confirmation copy from the same list. Every tag takes the
 * category's default color and loads top-level; nothing here is per-project state.
 */

export const TAG_TEMPLATE_IDS = ['standard-fiction', 'mystery', 'fantasy', 'sci-fi'] as const
export const TagTemplateId = z.enum(TAG_TEMPLATE_IDS)
export type TagTemplateId = z.infer<typeof TagTemplateId>

/** One tag to seed: an already kebab-cased name and its category (never `custom`). */
export interface TagTemplateTag {
  name: string
  category: Exclude<TagCategory, 'custom'>
}

export interface TagTemplate {
  id: TagTemplateId
  label: string
  tags: TagTemplateTag[]
}

/** Expands `{ category: [names] }` into the flat tag list, in the given order. */
function tags(groups: Record<Exclude<TagCategory, 'custom'>, string[]>): TagTemplateTag[] {
  return (Object.keys(groups) as Exclude<TagCategory, 'custom'>[]).flatMap((category) =>
    groups[category].map((name) => ({ name, category }))
  )
}

export const TAG_TEMPLATES: readonly TagTemplate[] = [
  {
    id: 'standard-fiction',
    label: 'Standard Fiction',
    tags: tags({
      character: ['protagonist', 'antagonist', 'supporting-character', 'minor-character'],
      setting: ['primary-location', 'secondary-location', 'time-period', 'recurring-location'],
      worldBuilding: ['rules', 'culture', 'history', 'technology'],
      tone: ['dramatic', 'humorous', 'suspenseful', 'romantic', 'dark', 'lighthearted'],
      content: ['action', 'dialogue', 'description', 'internal-monologue', 'flashback'],
      plotThread: ['main-plot', 'subplot', 'character-arc', 'mystery', 'romance-arc']
    })
  },
  {
    id: 'mystery',
    label: 'Mystery',
    tags: tags({
      character: ['detective', 'suspect', 'victim', 'witness', 'accomplice'],
      setting: ['crime-scene', 'investigation-location', 'hideout', 'safe-house'],
      worldBuilding: ['police-procedure', 'forensics', 'legal-system', 'criminal-underworld'],
      tone: ['suspenseful', 'noir', 'cozy', 'psychological'],
      content: ['clue', 'red-herring', 'revelation', 'interrogation', 'deduction'],
      plotThread: ['main-mystery', 'personal-stakes', 'ticking-clock', 'twist']
    })
  },
  {
    id: 'fantasy',
    label: 'Fantasy',
    tags: tags({
      character: ['hero', 'mentor', 'villain', 'magical-creature', 'ally'],
      setting: ['kingdom', 'magical-realm', 'dungeon', 'village', 'wilderness'],
      worldBuilding: ['magic-system', 'mythology', 'races', 'politics', 'prophecy'],
      tone: ['epic', 'dark-fantasy', 'whimsical', 'gritty'],
      content: ['battle', 'magic-use', 'quest', 'world-building-exposition', 'training'],
      plotThread: ['heroes-journey', 'magical-quest', 'war', 'coming-of-age', 'political-intrigue']
    })
  },
  {
    id: 'sci-fi',
    label: 'Sci-Fi',
    tags: tags({
      character: ['captain', 'scientist', 'android', 'alien', 'pilot'],
      setting: ['spaceship', 'space-station', 'alien-planet', 'colony', 'laboratory'],
      worldBuilding: [
        'technology',
        'alien-species',
        'faster-than-light-travel',
        'time-travel',
        'artificial-intelligence'
      ],
      tone: ['hard-sci-fi', 'space-opera', 'cyberpunk', 'dystopian', 'hopeful'],
      content: [
        'space-battle',
        'scientific-discovery',
        'first-contact',
        'tech-explanation',
        'survival'
      ],
      plotThread: ['exploration', 'invasion', 'rebellion', 'mystery', 'ethical-dilemma']
    })
  }
]

/** The template with the given id; the id is enum-validated, so a miss means catalogue drift. */
export function tagTemplateById(id: TagTemplateId): TagTemplate | undefined {
  return TAG_TEMPLATES.find((template) => template.id === id)
}

/**
 * Custom tag templates (F-4.11): a tag bank (or part of one) the author saved under a name, kept
 * app-wide in app state so any project can load it. A template holds tag-bank records (F-4.9), so
 * colors, the custom category, nesting by parent name, and the tracking switch travel with it,
 * and loading one is an import: taken names are skipped, never overwritten.
 */
export const CUSTOM_TAG_TEMPLATES_MAX = 50
export const CUSTOM_TAG_TEMPLATE_NAME_MAX = 80
/** A template is a bank snapshot, so it is capped well above any real bank. */
export const CUSTOM_TAG_TEMPLATE_TAGS_MAX = 2000

export const CustomTagTemplateName = z.string().trim().min(1).max(CUSTOM_TAG_TEMPLATE_NAME_MAX)

export const CustomTagTemplate = z.object({
  id: z.string().min(1),
  name: CustomTagTemplateName,
  tags: z.array(TagExchangeRecord).min(1).max(CUSTOM_TAG_TEMPLATE_TAGS_MAX),
  created: z.string(),
  modified: z.string()
})
export type CustomTagTemplate = z.infer<typeof CustomTagTemplate>

/** The uniqueness key of a template name: NFC, trimmed, whitespace collapsed, lower-cased. */
export function customTemplateNameKey(name: string): string {
  return name.normalize('NFC').trim().replace(/\s+/gu, ' ').toLocaleLowerCase()
}

/**
 * The records whose names are in `keep`, in their order. A parent outside the kept set is
 * dropped, so a template never names a parent it does not carry.
 */
export function keepTemplateRecords(
  records: readonly TagExchangeRecord[],
  keep: ReadonlySet<string>
): TagExchangeRecord[] {
  return records
    .filter((record) => keep.has(record.name))
    .map((record) =>
      record.parent !== null && !keep.has(record.parent) ? { ...record, parent: null } : record
    )
}
