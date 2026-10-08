import { z } from 'zod'
import { assetUrl } from './assets'
import { TAG_NAME_MAX, toTagName } from './tags'

/**
 * Entity vocabulary shared by the database schema, the entity store, the IPC contract, and the
 * UI (F-9.1). One owner for the sheet's category id and field id shapes, the stored limits, and
 * the name normalization the store's uniqueness check uses; the categories themselves and their
 * templates are `categories.ts` (F-9.11).
 */

/**
 * The category a sheet belongs to (F-9.11): a library category id (`character`, `setting`,
 * `world`, `magic`…, see `categories.ts`) or a project category's (`c-…`). Before F-9.11 these
 * were the three fixed kinds of F-9.1, whose ids the library keeps.
 */
export const EntityKind = z.string().regex(/^[a-z][a-z0-9-]{0,47}$/, 'Not a category id')
export type EntityKind = z.infer<typeof EntityKind>

/**
 * How an entity is written: the kind's structured template (a value per field) or a blank page
 * (one free text). The author chooses at creation (F-9.3); both columns exist either way, so
 * switching template later loses nothing that was already typed.
 */
export const ENTITY_TEMPLATES = ['structured', 'blank'] as const
export const EntityTemplate = z.enum(ENTITY_TEMPLATES)
export type EntityTemplate = z.infer<typeof EntityTemplate>

/**
 * Who made an entity (F-5.16): the author, or the background story-bible job that met a name with
 * no entity. An `ai` entity is marked "Added by AI" until the author's first edit of its name,
 * fields, or page makes it theirs; nothing ever turns an entity back to `ai`.
 */
export const ENTITY_ORIGINS = ['author', 'ai'] as const
export const EntityOrigin = z.enum(ENTITY_ORIGINS)
export type EntityOrigin = z.infer<typeof EntityOrigin>

/**
 * A field id of a category's structured template (F-9.11: the project's own categories make
 * their own, `fieldIdFromLabel`). `name` is a column and not a field (every entity has one,
 * whatever its template), and so is `image`.
 */
export const EntityFieldId = z.string().regex(/^[a-z][a-zA-Z0-9]{0,39}$/, 'Not a field id')
export type EntityFieldId = z.infer<typeof EntityFieldId>

/** One field of a structured template: what it is stored under, its label, and its input shape. */
export interface EntityFieldDef {
  id: EntityFieldId
  label: string
  /** True for the fields the editor gives a textarea (F-9.3); false for one-line inputs. */
  multiline: boolean
}

/**
 * What the World category's `category` field suggests (magic system, culture, technology…). Only
 * suggestions: the field is free text, so an author's own category is as good as these.
 */
export const WORLD_CATEGORY_SUGGESTIONS: readonly string[] = [
  'Magic system',
  'Culture',
  'Technology',
  'Religion',
  'History',
  'Geography',
  'Politics',
  'Language',
  'Other'
]

/** Longest allowed entity name, measured on the input before trimming. */
export const ENTITY_NAME_MAX = 200
/** Longest allowed value of one structured field. */
export const ENTITY_FIELD_MAX = 20_000
/** Longest allowed blank page: the free text of a `blank` entity. */
export const ENTITY_BODY_MAX = 200_000

/** The stored values of a structured template; a field with no text has no key. */
export type EntityFields = Partial<Record<EntityFieldId, string>>

/** The wire schema of `EntityFields`; the channels that write cap the values themselves. */
export const EntityFieldsSchema = z.record(EntityFieldId, z.string())

/** The folder under the project's `assets/` that holds the entity images (F-9.3). */
export const ENTITY_IMAGES_DIR = 'entities' as const

/** The asset URL the renderer loads an entity's `image` file from (F-9.3). */
export function entityImageUrl(fileName: string): string {
  return assetUrl(ENTITY_IMAGES_DIR, fileName)
}

/**
 * The name of an entity's tag (F-9.4): the entity name kebab-cased like any tag name, cut to
 * `TAG_NAME_MAX` with the hyphen a cut through a separator leaves trimmed off. Returns '' when
 * nothing survives ("???"), which is how an entity ends up with no tag at all.
 */
export function entityTagName(name: string): string {
  return toTagName(name).slice(0, TAG_NAME_MAX).replace(/-+$/, '')
}

/**
 * The key two entity names are compared by: trimmed, runs of whitespace collapsed to one space,
 * and lower-cased. "  Ada   Lovelace " and "ada lovelace" are the same character; the stored
 * name keeps the author's own spelling and spacing.
 */
export function toEntityNameKey(name: string): string {
  return name.normalize('NFC').trim().replace(/\s+/gu, ' ').toLocaleLowerCase()
}

/** A stored `fields` cell before it is read: an object, with anything at all under its keys. */
const StoredFields = z.record(z.string(), z.unknown())

/**
 * The stored `entity.fields` column as values keyed by field id. Lenient on purpose: a null cell,
 * invalid JSON, a key that is not a field id, a value that is not a string, and an empty string
 * all read as "that field has nothing", rather than as an error. Every well-formed key is kept,
 * whatever the sheet's category (F-9.11): a value outside the template is not shown, but a write
 * never drops it, so nothing the author typed is lost when a category's template changes.
 */
export function parseEntityFields(raw: string | null): EntityFields {
  if (raw === null) return {}
  let json: unknown
  try {
    json = JSON.parse(raw)
  } catch {
    return {}
  }
  const parsed = StoredFields.safeParse(json)
  if (!parsed.success) return {}
  const fields: EntityFields = {}
  for (const [id, value] of Object.entries(parsed.data)) {
    if (typeof value === 'string' && value !== '' && EntityFieldId.safeParse(id).success) {
      fields[id] = value
    }
  }
  return fields
}
