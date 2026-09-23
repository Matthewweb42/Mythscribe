import { z } from 'zod'
import { assetUrl } from './assets'
import { TAG_NAME_MAX, toTagName, type TagCategory } from './tags'

/**
 * Entity vocabulary shared by the database schema, the entity store, the IPC contract, and the
 * UI (F-9.1). One owner for the three kinds, the fields of their structured templates, the
 * stored limits, and the name normalization the store's uniqueness check uses.
 */

/** The three kinds of the story bible; the sidebar gives each its own tab (F-9.2). */
export const ENTITY_KINDS = ['character', 'setting', 'world'] as const
export const EntityKind = z.enum(ENTITY_KINDS)
export type EntityKind = z.infer<typeof EntityKind>

/** The tab and section heading per kind. */
export const ENTITY_KIND_LABEL: Record<EntityKind, string> = {
  character: 'Characters',
  setting: 'Settings',
  world: 'World'
}

/** The singular noun for one entity of the kind, for messages and buttons ("New character"). */
export const ENTITY_KIND_NOUN: Record<EntityKind, string> = {
  character: 'character',
  setting: 'setting',
  world: 'world-building item'
}

/**
 * How an entity is written: the kind's structured template (a value per field) or a blank page
 * (one free text). The author chooses at creation (F-9.3); both columns exist either way, so
 * switching template later loses nothing that was already typed.
 */
export const ENTITY_TEMPLATES = ['structured', 'blank'] as const
export const EntityTemplate = z.enum(ENTITY_TEMPLATES)
export type EntityTemplate = z.infer<typeof EntityTemplate>

/**
 * Every field id of every structured template, in kind order. `name` is a column and not a
 * field (every entity has one, whatever its template), and so is `image`.
 */
export const ENTITY_FIELD_IDS = [
  'age',
  'gender',
  'appearance',
  'personality',
  'background',
  'goals',
  'relationships',
  'type',
  'description',
  'atmosphere',
  'features',
  'associatedCharacters',
  'category',
  'rules',
  'impact',
  'notes'
] as const
export const EntityFieldId = z.enum(ENTITY_FIELD_IDS)
export type EntityFieldId = z.infer<typeof EntityFieldId>

/** One field of a structured template: what it is stored under, its label, and its input shape. */
export interface EntityFieldDef {
  id: EntityFieldId
  label: string
  /** True for the fields the editor gives a textarea (F-9.3); false for one-line inputs. */
  multiline: boolean
}

/**
 * The structured template of each kind (F-9.1), in display and storage order. A field carries a
 * plain string; an empty one is not stored at all, so a template that grows later costs nothing
 * in the rows written before it.
 */
export const ENTITY_FIELDS: Record<EntityKind, readonly EntityFieldDef[]> = {
  character: [
    { id: 'age', label: 'Age', multiline: false },
    { id: 'gender', label: 'Gender', multiline: false },
    { id: 'appearance', label: 'Appearance', multiline: true },
    { id: 'personality', label: 'Personality', multiline: true },
    { id: 'background', label: 'Background', multiline: true },
    { id: 'goals', label: 'Goals / motivations', multiline: true },
    { id: 'relationships', label: 'Relationships', multiline: true },
    { id: 'notes', label: 'Notes', multiline: true }
  ],
  setting: [
    { id: 'type', label: 'Type', multiline: false },
    { id: 'description', label: 'Description', multiline: true },
    { id: 'atmosphere', label: 'Atmosphere', multiline: true },
    { id: 'features', label: 'Features', multiline: true },
    { id: 'associatedCharacters', label: 'Associated characters', multiline: true },
    { id: 'notes', label: 'Notes', multiline: true }
  ],
  world: [
    { id: 'category', label: 'Category', multiline: false },
    { id: 'description', label: 'Description', multiline: true },
    { id: 'rules', label: 'Rules', multiline: true },
    { id: 'impact', label: 'Impact on story', multiline: true },
    { id: 'notes', label: 'Notes', multiline: true }
  ]
}

/** The kinds whose entity carries a portrait or a photograph (F-9.3 uploads it). */
export const ENTITY_KINDS_WITH_IMAGE: readonly EntityKind[] = ['character', 'setting']

/**
 * What the World kind's `category` field suggests (magic system, culture, technology…). Only
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

/** The field ids of one kind, in template order. */
export function fieldIdsFor(kind: EntityKind): readonly EntityFieldId[] {
  return ENTITY_FIELDS[kind].map((field) => field.id)
}

/** Whether `id` is a field of `kind`'s template ("age" is a character's, never a setting's). */
export function isFieldOf(kind: EntityKind, id: string): id is EntityFieldId {
  return ENTITY_FIELDS[kind].some((field) => field.id === id)
}

/** Whether entities of this kind carry an image (F-9.3). */
export function kindHasImage(kind: EntityKind): boolean {
  return ENTITY_KINDS_WITH_IMAGE.includes(kind)
}

/** The folder under the project's `assets/` that holds the entity images (F-9.3). */
export const ENTITY_IMAGES_DIR = 'entities' as const

/** The asset URL the renderer loads an entity's `image` file from (F-9.3). */
export function entityImageUrl(fileName: string): string {
  return assetUrl(ENTITY_IMAGES_DIR, fileName)
}

/**
 * The tag category an entity of each kind is tagged under (F-9.4). The three entity kinds are
 * the first three tag categories by another name; a tag the author later recategorizes is left
 * alone, the link is by id.
 */
export const ENTITY_TAG_CATEGORY: Record<EntityKind, TagCategory> = {
  character: 'character',
  setting: 'setting',
  world: 'worldBuilding'
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
 * The stored `entity.fields` column as the values of `kind`'s template. Lenient on purpose: a
 * null cell, invalid JSON, a key no template knows, a value that is not a string, and an empty
 * string all read as "that field has nothing", rather than as an error. A row therefore survives
 * a later change to the vocabulary instead of keeping the author out of their own story bible.
 */
export function parseEntityFields(raw: string | null, kind: EntityKind): EntityFields {
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
  for (const id of fieldIdsFor(kind)) {
    const value = parsed.data[id]
    if (typeof value === 'string' && value !== '') fields[id] = value
  }
  return fields
}
