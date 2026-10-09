import { z } from 'zod'

/**
 * Relationships between records (F-9.14, decision D5): a relationship is a dated fact whose
 * `objectEntityId` is the other record, so it carries a scene, a quote, a status, and an Undo like
 * every other fact, and there is one owner of dated statements (`fact`). The type is one of a
 * fixed list and the fact's `value` is a free label ("older sister", "sworn to"). A relationship
 * is directed (`entityId` → `objectEntityId`); the other record's sheet shows it the other way
 * round (`RELATION_INVERSE_LABEL`).
 */

export const RELATION_TYPES = [
  'family',
  'partner',
  'friend',
  'ally',
  'enemy',
  'rival',
  'mentor',
  'serves',
  'member-of',
  'owns',
  'located-in',
  'other'
] as const
export const RelationType = z.enum(RELATION_TYPES)
export type RelationType = z.infer<typeof RelationType>

/** How the relationship reads from its subject's sheet: "Mara · Mentor of Tomas". */
export const RELATION_LABEL: Readonly<Record<RelationType, string>> = {
  family: 'Family of',
  partner: 'Partner of',
  friend: 'Friend of',
  ally: 'Ally of',
  enemy: 'Enemy of',
  rival: 'Rival of',
  mentor: 'Mentor of',
  serves: 'Serves',
  'member-of': 'Member of',
  owns: 'Owns',
  'located-in': 'Located in',
  other: 'Related to'
}

/** How the same relationship reads from the other record's sheet: "Tomas · Mentored by Mara". */
export const RELATION_INVERSE_LABEL: Readonly<Record<RelationType, string>> = {
  family: 'Family of',
  partner: 'Partner of',
  friend: 'Friend of',
  ally: 'Ally of',
  enemy: 'Enemy of',
  rival: 'Rival of',
  mentor: 'Mentored by',
  serves: 'Served by',
  'member-of': 'Has member',
  owns: 'Owned by',
  'located-in': 'Holds',
  other: 'Related to'
}

/** Longest free label on a relationship ("older sister"). */
export const RELATION_LABEL_MAX = 80

/** The fact attribute a relationship of this type is stored under: `relation:mentor`. */
export function relationAttribute(type: RelationType): string {
  return `${RELATION_PREFIX}${type}`
}

const RELATION_PREFIX = 'relation:'

/** The type of a relationship fact's attribute, or null for an attribute that is not one. */
export function relationTypeOf(attribute: string): RelationType | null {
  if (!attribute.startsWith(RELATION_PREFIX)) return null
  const parsed = RelationType.safeParse(attribute.slice(RELATION_PREFIX.length))
  return parsed.success ? parsed.data : null
}

/** A type as the model may spell it ("Member of", "located_in"), or null when it is none of the list. */
export function parseRelationType(text: string): RelationType | null {
  const key = text
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, '-')
  const parsed = RelationType.safeParse(key)
  return parsed.success ? parsed.data : null
}
