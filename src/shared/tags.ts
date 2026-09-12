import { z } from 'zod'

/**
 * Tag vocabulary shared by the database schema, the tag store, and the UI (F-4.1).
 * One owner for the categories, their labels and default colors, and the name normalization.
 */

export const TAG_CATEGORIES = [
  'character',
  'setting',
  'worldBuilding',
  'tone',
  'content',
  'plotThread',
  'custom'
] as const
export const TagCategory = z.enum(TAG_CATEGORIES)
export type TagCategory = z.infer<typeof TagCategory>

export const TAG_CATEGORY_LABEL: Record<TagCategory, string> = {
  character: 'Characters',
  setting: 'Settings',
  worldBuilding: 'World Building',
  tone: 'Tone',
  content: 'Content',
  plotThread: 'Plot Threads',
  custom: 'Custom'
}

/** The spec's default color per category (F-4.1); a tag may be recolored away from it (F-4.2). */
export const DEFAULT_CATEGORY_COLOR: Record<TagCategory, string> = {
  character: '#dc2626',
  setting: '#ea580c',
  worldBuilding: '#0d9488',
  tone: '#2563eb',
  content: '#16a34a',
  plotThread: '#9333ea',
  custom: '#6b7280'
}

/** Tag colors are stored as lowercase 6-digit hex. */
export const HEX_COLOR = /^#[0-9a-f]{6}$/

/** Longest allowed tag name, measured on the input before normalization. */
export const TAG_NAME_MAX = 60

/**
 * Kebab-cases a tag name: "Dark Forest" → "dark-forest". Letters and digits of any script are
 * kept (fiction names carry diacritics: "Zoë" → "zoë"); runs of anything else collapse to one
 * hyphen, and leading and trailing hyphens are stripped. Returns '' when nothing survives (main
 * refuses that with VALIDATION).
 */
export function toTagName(input: string): string {
  return input
    .normalize('NFC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
}
