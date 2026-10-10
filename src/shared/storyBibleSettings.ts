import { z } from 'zod'
import { EntityFieldId, EntityKind, EntityTemplate, type EntityFieldDef } from './entities'

/**
 * The story bible's own settings (F-9.17, F-9.19; requested by the author 2026-10-10): how every
 * category tab lists its sheets, which view a new sheet opens in, and how the Blank page of a
 * sheet is written up from its fields (F-9.18). Stored per project as JSON in the `settings`
 * table under `STORY_BIBLE_SETTINGS_KEY` (no migration); a missing or broken row reads as the
 * defaults, and every part is defaulted so a row from an older build still parses.
 */

/** Settings-table key under which the story-bible settings are stored as JSON. */
export const STORY_BIBLE_SETTINGS_KEY = 'storyBible'

/** How the category tabs lay their rows out (F-9.2): one line each, or a card with an excerpt. */
export const BIBLE_LIST_VIEWS = ['list', 'cards'] as const
export const BibleListView = z.enum(BIBLE_LIST_VIEWS)
export type BibleListView = z.infer<typeof BibleListView>

/** How long a write-up runs (F-9.18): short, medium, or long. */
export const WRITE_UP_LENGTHS = ['short', 'medium', 'long'] as const
export const WriteUpLength = z.enum(WRITE_UP_LENGTHS)
export type WriteUpLength = z.infer<typeof WriteUpLength>

export const WRITE_UP_LENGTH_LABEL: Readonly<Record<WriteUpLength, string>> = {
  short: 'Short',
  medium: 'Medium',
  long: 'Long'
}

/**
 * About how many words a write-up of each length aims at, at most: the fields may hold less, and
 * the write-up never adds what they do not say.
 */
export const WRITE_UP_WORDS: Readonly<Record<WriteUpLength, number>> = {
  short: 120,
  medium: 250,
  long: 500
}

/** How a field shows on the Blank page: under a heading of its own, or woven into the opening paragraphs. */
export const WRITE_UP_ROLES = ['heading', 'paragraph'] as const
export const WriteUpRole = z.enum(WRITE_UP_ROLES)
export type WriteUpRole = z.infer<typeof WriteUpRole>

export const WRITE_UP_ROLE_LABEL: Readonly<Record<WriteUpRole, string>> = {
  heading: 'Heading',
  paragraph: 'Paragraph'
}

/**
 * One category's write-up style: its length, and the role of each field it names. A field it does
 * not name (one added later, or a sheet's own) takes `defaultWriteUpRole`.
 */
export const WriteUpStyle = z.object({
  length: WriteUpLength.default('medium'),
  roles: z.record(EntityFieldId, WriteUpRole).default({})
})
export type WriteUpStyle = z.infer<typeof WriteUpStyle>

/** A stored map of styles, read leniently: an entry under a key that is not a category id, or one that does not parse, is dropped. */
const LenientStyles = z.record(z.string(), z.unknown()).transform((stored) => {
  const out: Record<string, WriteUpStyle> = {}
  for (const [id, raw] of Object.entries(stored)) {
    if (!EntityKind.safeParse(id).success) continue
    const style = WriteUpStyle.safeParse(raw)
    if (style.success) out[id] = style.data
  }
  return out
})

export const StoryBibleSettings = z.object({
  /** F-9.17: one List/Cards choice for every category tab. */
  listView: BibleListView.catch('cards').default('cards'),
  /** F-9.19: the view a new sheet opens in (the create dialog's preselected template). */
  defaultTemplate: EntityTemplate.catch('structured').default('structured'),
  /** F-9.19: the write-up style per category id. */
  writeUp: LenientStyles.catch({}).default({})
})
export type StoryBibleSettings = z.infer<typeof StoryBibleSettings>
export type StoryBibleSettingsInput = z.input<typeof StoryBibleSettings>

export function defaultStoryBibleSettings(): StoryBibleSettings {
  return { listView: 'cards', defaultTemplate: 'structured', writeUp: {} }
}

/** A field with no role of its own: a one-line field (Age) flows, a long one (Background) gets a heading. */
export function defaultWriteUpRole(field: Pick<EntityFieldDef, 'multiline'>): WriteUpRole {
  return field.multiline ? 'heading' : 'paragraph'
}

/** The style a category's sheets are written up in: the stored one, or medium with the default roles. */
export function writeUpStyleOf(settings: StoryBibleSettings, categoryId: string): WriteUpStyle {
  return settings.writeUp[categoryId] ?? { length: 'medium', roles: {} }
}

/** The role of one field under a style. */
export function writeUpRoleOf(style: WriteUpStyle, field: EntityFieldDef): WriteUpRole {
  return style.roles[field.id] ?? defaultWriteUpRole(field)
}
