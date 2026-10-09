import { z } from 'zod'
import { EntityFieldId, EntityKind, type EntityFieldDef } from './entities'
import { TagCategory } from './tags'

/**
 * Story-bible categories (F-9.11): what kind of thing a sheet is. A built-in LIBRARY of ready
 * categories, each with an icon and the fields of its structured template, plus the project's own
 * categories (invented by the AI and accepted by the author, or added by hand) stored in
 * `story_category`. A sheet's `kind` is a category id. The sidebar's section picker shows a
 * category once it has a sheet (Characters and Places always).
 *
 * The ids of the first three (`character`, `setting`, `world`) are the kinds of F-9.1, so every
 * sheet written before categories reads as one of the library's without a data migration.
 */

/** The icons a category may wear; the renderer maps each to a lucide icon. */
export const CATEGORY_ICONS = [
  'users',
  'map-pin',
  'globe',
  'sparkles',
  'shield',
  'church',
  'paw-print',
  'gem',
  'landmark',
  'scroll',
  'languages',
  'cog',
  'book-marked',
  'flag',
  'crown',
  'leaf',
  'swords',
  'star',
  'ship',
  'castle',
  'feather',
  'flame',
  'skull',
  'folder'
] as const
export const CategoryIcon = z.enum(CATEGORY_ICONS)
export type CategoryIcon = z.infer<typeof CategoryIcon>

/** The icon a new category gets when nobody picked one. */
export const DEFAULT_CATEGORY_ICON: CategoryIcon = 'folder'

/** Who made a category: the built-in library, the author by hand, or the AI (accepted by the author). */
export const CATEGORY_ORIGINS = ['library', 'author', 'ai'] as const
export const CategoryOrigin = z.enum(CATEGORY_ORIGINS)
export type CategoryOrigin = z.infer<typeof CategoryOrigin>

/** Longest category name ("Factions & Organisations" fits easily). */
export const CATEGORY_NAME_MAX = 60
/** Longest field label of a project category. */
export const CATEGORY_FIELD_LABEL_MAX = 60
/** Most fields a project category's template may have (Notes is added on top). */
export const CATEGORY_FIELDS_MAX = 12
/** Longest one-line description of what goes in a category (what the AI reads). */
export const CATEGORY_HINT_MAX = 200

export const CategoryFieldDef = z.object({
  id: EntityFieldId,
  label: z.string().trim().min(1).max(CATEGORY_FIELD_LABEL_MAX),
  multiline: z.boolean()
})

/**
 * One category as both sides see it. `builtIn` is a library category (its fields are fixed; the
 * author may still rename it); `hint` says what goes in it, for the AI's sorting prompt.
 */
export const StoryCategory = z.object({
  id: EntityKind,
  name: z.string().trim().min(1).max(CATEGORY_NAME_MAX),
  /** One item of the category, lower case: "New magic system", "1 creature". */
  noun: z.string().trim().min(1).max(CATEGORY_NAME_MAX),
  icon: CategoryIcon,
  fields: z.array(CategoryFieldDef),
  /** Whether its sheets carry a portrait or a picture (F-9.3). */
  hasImage: z.boolean(),
  /** The tag category a sheet's tag is created under (F-9.4). */
  tagCategory: TagCategory,
  builtIn: z.boolean(),
  origin: CategoryOrigin,
  hint: z.string().max(CATEGORY_HINT_MAX)
})
export type StoryCategory = z.infer<typeof StoryCategory>

const f = (id: string, label: string, multiline = true): EntityFieldDef => ({
  id,
  label,
  multiline
})
const NOTES = f('notes', 'Notes')
const DESCRIPTION = f('description', 'Description')

function builtin(
  def: Omit<StoryCategory, 'builtIn' | 'origin' | 'hasImage' | 'tagCategory'> &
    Partial<Pick<StoryCategory, 'hasImage' | 'tagCategory'>>
): StoryCategory {
  return {
    hasImage: false,
    tagCategory: 'worldBuilding',
    ...def,
    builtIn: true,
    origin: 'library'
  }
}

/**
 * The library, in picker order. The first three keep the F-9.1 templates field for field (the
 * Settings tab is called Places now); the rest are new with F-9.11. Every template ends in Notes,
 * which takes what fits no other field.
 */
export const BUILTIN_CATEGORIES: readonly StoryCategory[] = [
  builtin({
    id: 'character',
    name: 'Characters',
    noun: 'character',
    icon: 'users',
    hasImage: true,
    tagCategory: 'character',
    hint: 'people and beings with a name',
    fields: [
      f('age', 'Age', false),
      f('born', 'Born (story year)', false),
      f('gender', 'Gender', false),
      f('appearance', 'Appearance'),
      f('personality', 'Personality'),
      f('background', 'Background'),
      f('goals', 'Goals / motivations'),
      f('relationships', 'Relationships'),
      NOTES
    ]
  }),
  builtin({
    id: 'setting',
    name: 'Places',
    noun: 'place',
    icon: 'map-pin',
    hasImage: true,
    tagCategory: 'setting',
    hint: 'places: cities, rooms, regions, worlds',
    fields: [
      f('type', 'Type', false),
      DESCRIPTION,
      f('atmosphere', 'Atmosphere'),
      f('features', 'Features'),
      f('associatedCharacters', 'Associated characters'),
      NOTES
    ]
  }),
  builtin({
    id: 'world',
    name: 'World',
    noun: 'world-building item',
    icon: 'globe',
    hint: 'anything about the world no other category fits',
    fields: [
      f('category', 'Category', false),
      DESCRIPTION,
      f('rules', 'Rules'),
      f('impact', 'Impact on story'),
      NOTES
    ]
  }),
  builtin({
    id: 'magic',
    name: 'Magic Systems',
    noun: 'magic system',
    icon: 'sparkles',
    hint: 'magic, powers, and how they work',
    fields: [
      DESCRIPTION,
      f('source', 'Source of power'),
      f('rules', 'Rules'),
      f('costs', 'Costs and limits'),
      f('practitioners', 'Practitioners'),
      f('impact', 'Impact on story'),
      NOTES
    ]
  }),
  builtin({
    id: 'faction',
    name: 'Factions & Organisations',
    noun: 'faction',
    icon: 'shield',
    hint: 'groups, orders, guilds, houses, governments, armies',
    fields: [
      f('type', 'Type', false),
      DESCRIPTION,
      f('goals', 'Goals'),
      f('leadership', 'Leadership'),
      f('members', 'Members'),
      f('relationships', 'Allies and rivals'),
      NOTES
    ]
  }),
  builtin({
    id: 'religion',
    name: 'Religions',
    noun: 'religion',
    icon: 'church',
    hint: 'faiths, gods, cults, and their practices',
    fields: [
      DESCRIPTION,
      f('deities', 'Deities'),
      f('beliefs', 'Beliefs'),
      f('practices', 'Practices and rites'),
      f('followers', 'Followers'),
      NOTES
    ]
  }),
  builtin({
    id: 'creature',
    name: 'Creatures',
    noun: 'creature',
    icon: 'paw-print',
    hasImage: true,
    hint: 'animals, monsters, and species',
    fields: [
      DESCRIPTION,
      f('appearance', 'Appearance'),
      f('habitat', 'Habitat'),
      f('behavior', 'Behavior'),
      f('abilities', 'Abilities'),
      NOTES
    ]
  }),
  builtin({
    id: 'item',
    name: 'Items & Artifacts',
    noun: 'item',
    icon: 'gem',
    hasImage: true,
    hint: 'objects, weapons, relics, and artifacts',
    fields: [
      DESCRIPTION,
      f('appearance', 'Appearance'),
      f('origin', 'Origin'),
      f('powers', 'Powers or use'),
      f('owner', 'Owner', false),
      NOTES
    ]
  }),
  builtin({
    id: 'culture',
    name: 'Cultures',
    noun: 'culture',
    icon: 'landmark',
    hint: 'peoples, nations, customs, and ways of life',
    fields: [
      DESCRIPTION,
      f('homeland', 'Homeland'),
      f('customs', 'Customs'),
      f('values', 'Values'),
      NOTES
    ]
  }),
  builtin({
    id: 'history',
    name: 'History & Events',
    noun: 'event',
    icon: 'scroll',
    hint: 'wars, eras, and past events',
    fields: [
      f('when', 'When', false),
      DESCRIPTION,
      f('causes', 'Causes'),
      f('consequences', 'Consequences'),
      f('associatedCharacters', 'People involved'),
      NOTES
    ]
  }),
  builtin({
    id: 'language',
    name: 'Languages',
    noun: 'language',
    icon: 'languages',
    hint: 'languages, scripts, and dialects',
    fields: [
      DESCRIPTION,
      f('speakers', 'Speakers'),
      f('sound', 'Sound and grammar'),
      f('examples', 'Example words'),
      NOTES
    ]
  }),
  builtin({
    id: 'technology',
    name: 'Technology',
    noun: 'technology',
    icon: 'cog',
    hint: 'machines, inventions, and how they work',
    fields: [
      DESCRIPTION,
      f('howItWorks', 'How it works'),
      f('limits', 'Limits'),
      f('impact', 'Impact on story'),
      NOTES
    ]
  }),
  builtin({
    id: 'lore',
    name: 'Lore & Legends',
    noun: 'legend',
    icon: 'book-marked',
    hint: 'myths, prophecies, and stories told in the world',
    fields: [DESCRIPTION, f('origin', 'Origin'), f('truth', 'What is really true'), NOTES]
  })
]

/**
 * Plot threads (F-9.14, decision D6): a built-in category of its own, apart from the library above
 * on purpose. The library is the list the AI files sheets into (Organise, the context library, the
 * review chat render it into their prompts, unchanged); a thread record is made from a plot-thread
 * tag or a thread event the scene reading finds, and the sidebar shows the category as the
 * Threads section (`ThreadsTab`), not a sheet list. Its tag category is `plotThread`, so a thread
 * record's tag is a plot-thread tag and the F-11.1c grid keeps working. Status is derived from its
 * events (`src/shared/threads.ts`), never a field.
 */
export const THREAD_CATEGORY: StoryCategory = builtin({
  id: 'thread',
  name: 'Threads',
  noun: 'thread',
  icon: 'flag',
  tagCategory: 'plotThread',
  hint: 'plot threads: setups, promises, open questions, and subplots',
  fields: [
    f('threadKind', 'Kind (setup, promise, question, subplot)', false),
    DESCRIPTION,
    f('payoff', 'Intended payoff'),
    NOTES
  ]
})

/** Every built-in category in picker order: the library, then Threads. */
export const ALL_BUILTIN_CATEGORIES: readonly StoryCategory[] = [
  ...BUILTIN_CATEGORIES,
  THREAD_CATEGORY
]

export const BUILTIN_CATEGORY_IDS: readonly string[] = ALL_BUILTIN_CATEGORIES.map((c) => c.id)

/** The categories the section picker shows even with no sheet (F-9.11, the author's call). */
export const ALWAYS_SHOWN_CATEGORIES: readonly string[] = ['character', 'setting']

/** The library category with this id, or undefined. */
export function builtinCategory(id: string): StoryCategory | undefined {
  return ALL_BUILTIN_CATEGORIES.find((category) => category.id === id)
}

/** The category of a sheet whose category is gone (never expected; a row stays readable). */
function fallbackCategory(id: string): StoryCategory {
  return {
    id,
    name: id,
    noun: id,
    icon: DEFAULT_CATEGORY_ICON,
    fields: [DESCRIPTION, NOTES],
    hasImage: false,
    tagCategory: 'worldBuilding',
    builtIn: false,
    origin: 'author',
    hint: ''
  }
}

/**
 * The category `id` names among `categories` (the project's list, `category:list`), then the
 * library; a generic Description + Notes category when it is neither, so a sheet is never
 * unreadable.
 */
export function categoryOf(id: string, categories: readonly StoryCategory[] = []): StoryCategory {
  return (
    categories.find((category) => category.id === id) ?? builtinCategory(id) ?? fallbackCategory(id)
  )
}

/** Whether `id` names a category the project has (a library one or one of its own). */
export function isKnownCategory(id: string, categories: readonly StoryCategory[]): boolean {
  return builtinCategory(id) !== undefined || categories.some((category) => category.id === id)
}

/** The field ids of a category's template, in order. */
export function categoryFieldIds(category: StoryCategory): string[] {
  return category.fields.map((field) => field.id)
}

/** Whether `id` is a field of the category's template ("age" is a character's, never a place's). */
export function isCategoryField(category: StoryCategory, id: string): boolean {
  return category.fields.some((field) => field.id === id)
}

/** The label of a field of the category, or the raw id when the template has no such field. */
export function categoryFieldLabel(category: StoryCategory, id: string): string {
  return category.fields.find((field) => field.id === id)?.label ?? id
}

/**
 * Two pieces of a sheet's text as one (F-9.10): either alone when the other is empty, the first
 * when it already holds the second (compared without case and spacing), else both, a blank line
 * apart.
 */
export function joinSheetText(
  first: string | null | undefined,
  second: string | null | undefined
): string {
  const a = (first ?? '').trim()
  const b = (second ?? '').trim()
  if (b === '') return a
  if (a === '') return b
  const flat = (text: string): string => text.replace(/\s+/g, ' ').toLowerCase()
  return flat(a).includes(flat(b)) ? a : `${a}\n\n${b}`
}

/**
 * A sheet's field values as they read in another category (F-9.10, a sheet moved by Organise):
 * a value of a field the new template has stays under it; every other one moves into the new
 * template's Notes as "Label: value" (the label as the old category names it), after what Notes
 * held. A template without Notes (never expected) keeps the values as they were stored.
 */
export function refileFields(
  from: StoryCategory,
  to: StoryCategory,
  fields: Readonly<Partial<Record<string, string>>>
): Record<string, string> {
  const kept: Record<string, string> = {}
  const all: Record<string, string> = {}
  const moved: string[] = []
  for (const [id, raw] of Object.entries(fields)) {
    const value = raw ?? ''
    all[id] = value
    if (isCategoryField(to, id)) kept[id] = value
    else if (value.trim() !== '') moved.push(`${categoryFieldLabel(from, id)}: ${value.trim()}`)
  }
  if (moved.length === 0) return kept
  if (!isCategoryField(to, 'notes')) return all
  const notes = moved.reduce((text, line) => joinSheetText(text, line), kept.notes ?? '')
  return { ...kept, notes }
}

/**
 * The order sheets and categories are listed in: the library's order, then project categories
 * by id. `entity:list` sorts by it, and so does the renderer's store.
 */
export function compareCategoryIds(a: string, b: string): number {
  const rank = (id: string): number => {
    const index = BUILTIN_CATEGORY_IDS.indexOf(id)
    return index === -1 ? BUILTIN_CATEGORY_IDS.length : index
  }
  const diff = rank(a) - rank(b)
  return diff !== 0 ? diff : a.localeCompare(b)
}

/** Lower-case ASCII words of a label, accents dropped. */
function words(text: string): string[] {
  return text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word !== '')
}

/** The prefix of every project category id, so one never collides with a library id. */
export const CUSTOM_CATEGORY_PREFIX = 'c-'

/** A fresh id for a project category named `name`: `c-` and its words, made unique against `taken`. */
export function customCategoryId(name: string, taken: readonly string[]): string {
  const slug = words(name).join('-').slice(0, 40).replace(/-+$/, '') || 'category'
  const base = `${CUSTOM_CATEGORY_PREFIX}${slug}`
  let id = base
  for (let n = 2; taken.includes(id); n++) id = `${base}-${n}`
  return id
}

/** A field id from a label ("Crew size" → `crewSize`), unique against `taken`. */
export function fieldIdFromLabel(label: string, taken: readonly string[]): string {
  const parts = words(label)
  // A field id starts with a letter: leading numbers ("42 guns") are dropped, not shifted.
  while (parts.length > 0 && /^[0-9]/.test(parts[0] ?? '')) parts.shift()
  const camel = parts
    .map((word, i) => (i === 0 ? word : word.charAt(0).toUpperCase() + word.slice(1)))
    .join('')
    .replace(/^[0-9]+/, '')
    .slice(0, 32)
  const base = camel === '' ? 'field' : camel
  let id = base
  for (let n = 2; taken.includes(id); n++) id = `${base}${n}`
  return id
}

/** The singular a category name suggests ("Ships" → "ship"), lower case; the author may change it. */
export function singularOf(name: string): string {
  const lower = name.trim().toLowerCase()
  if (lower.endsWith('ies') && lower.length > 4) return `${lower.slice(0, -3)}y`
  if (/(ches|shes|sses|xes)$/.test(lower)) return lower.slice(0, -2)
  if (lower.endsWith('s') && !lower.endsWith('ss') && lower.length > 3) return lower.slice(0, -1)
  return lower
}

/**
 * A project category as the author or the AI describes it: a name, optionally the singular and
 * an icon, and the field labels of its template (Notes is always added at the end).
 */
export const NewCategoryInput = z.object({
  name: z.string().trim().min(1).max(CATEGORY_NAME_MAX),
  noun: z.string().trim().min(1).max(CATEGORY_NAME_MAX).optional(),
  icon: CategoryIcon.optional(),
  fields: z.array(z.string().trim().min(1).max(CATEGORY_FIELD_LABEL_MAX)).max(CATEGORY_FIELDS_MAX),
  hint: z.string().trim().max(CATEGORY_HINT_MAX).optional()
})
export type NewCategoryInput = z.infer<typeof NewCategoryInput>

/**
 * The category `input` describes, under `id`: one multi-line field per distinct label (a label
 * that is "Notes" is dropped, Notes comes last anyway), the singular from the name unless given.
 */
export function categoryFromInput(
  id: string,
  input: NewCategoryInput,
  origin: Exclude<CategoryOrigin, 'library'>
): StoryCategory {
  const fields: EntityFieldDef[] = []
  const seen = new Set<string>()
  for (const label of input.fields) {
    const key = label.trim().toLowerCase()
    if (key === '' || key === 'notes' || seen.has(key)) continue
    seen.add(key)
    fields.push({
      id: fieldIdFromLabel(label, fields.map((field) => field.id).concat('notes')),
      label: label.trim(),
      multiline: true
    })
  }
  fields.push(NOTES)
  const name = input.name.trim()
  const noun = input.noun?.trim() ?? ''
  return {
    id,
    name,
    noun: noun === '' ? singularOf(name) : noun,
    icon: input.icon ?? DEFAULT_CATEGORY_ICON,
    fields,
    hasImage: false,
    tagCategory: 'worldBuilding',
    builtIn: false,
    origin,
    hint: input.hint?.trim() ?? ''
  }
}

/**
 * The project's categories in picker order: the library (each under the author's name for it,
 * when renamed), then the project's own in `custom` order.
 */
export function mergeCategories(
  renames: ReadonlyMap<string, { name: string; noun: string; icon: CategoryIcon }>,
  custom: readonly StoryCategory[]
): StoryCategory[] {
  return [
    ...ALL_BUILTIN_CATEGORIES.map((category) => {
      const rename = renames.get(category.id)
      return rename === undefined ? category : { ...category, ...rename }
    }),
    ...custom
  ]
}

/** The field labels typed one per line, blank lines dropped, capped at `CATEGORY_FIELDS_MAX`. */
export function fieldLabelsOf(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .slice(0, CATEGORY_FIELDS_MAX)
}

/** "3 magic systems" / "1 magic system". */
export function countNoun(count: number, category: Pick<StoryCategory, 'noun'>): string {
  return `${count} ${count === 1 ? category.noun : pluralOf(category.noun)}`
}

/** A noun's plural, for counts ("magic systems", "factions", "entries"). */
export function pluralOf(noun: string): string {
  if (/[^aeiou]y$/.test(noun)) return `${noun.slice(0, -1)}ies`
  if (/(s|x|ch|sh)$/.test(noun)) return `${noun}es`
  return `${noun}s`
}
