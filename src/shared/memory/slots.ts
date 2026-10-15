import { z } from 'zod'

/**
 * The closed slot list of story memory v2 (F-16.17; design §2.2 "Slots"): what a claim can say
 * about a record. No free-form slots: the reader's answer is parsed against this list, and a
 * slot outside it is refused. Each slot has a group, which decides how its values behave over
 * the book (`asOf.ts`):
 * - **fixed**: never changes (eyes, born, species, kinship, the fixed `detail:` labels); every
 *   differing value is shown side by side;
 * - **lasting**: the latest value wins, shown "since 12.1" (hair, alive, role, stated age, scars);
 * - **transient**: shown only as "last stated in 13.4" (location, injuries, clothing, objects);
 * - **accumulating**: values add up (traits, history, relation to another record);
 * - **knows** and **thread**: P2b's who-knows-what and plot threads; listed so the vocabulary is
 *   one list. `reader.v2` proposes them as knows lines and thread steps, never as a fact's slot
 *   (the pipeline refuses that).
 *
 * Pure and relative-imported: `schema.ts` (loaded by drizzle-kit without path aliases) does not
 * import it, but `claims.ts`, which it does import, does.
 */

export const SLOT_GROUPS = [
  'fixed',
  'lasting',
  'transient',
  'accumulating',
  'knows',
  'thread'
] as const
export type SlotGroup = (typeof SLOT_GROUPS)[number]

/** The base slots, in the order a sheet lists them within a group. */
export const BASE_SLOTS = [
  'eyes',
  'born',
  'species',
  'kinship',
  'hair',
  'alive',
  'role',
  'age',
  'scars',
  'location',
  'injuries',
  'clothing',
  'objects',
  'traits',
  'history',
  'relation',
  'knows',
  'thread'
] as const
export type BaseSlot = (typeof BASE_SLOTS)[number]

const BASE_GROUP: Readonly<Record<BaseSlot, SlotGroup>> = {
  eyes: 'fixed',
  born: 'fixed',
  species: 'fixed',
  kinship: 'fixed',
  hair: 'lasting',
  alive: 'lasting',
  role: 'lasting',
  age: 'lasting',
  scars: 'lasting',
  location: 'transient',
  injuries: 'transient',
  clothing: 'transient',
  objects: 'transient',
  traits: 'accumulating',
  history: 'accumulating',
  relation: 'accumulating',
  knows: 'knows',
  thread: 'thread'
}

/**
 * The `detail:<label>` slots (design §2.2: "a closed list of about 20 labels"), each with its
 * group: what a person is that the base slots do not name ("seven thousand a year" is
 * `detail:income`). Only fixed and lasting: a detail is never transient or accumulating.
 */
export const DETAIL_LABELS = {
  height: 'fixed',
  build: 'fixed',
  skin: 'fixed',
  handedness: 'fixed',
  birthplace: 'fixed',
  accent: 'fixed',
  mark: 'fixed',
  home: 'lasting',
  occupation: 'lasting',
  rank: 'lasting',
  title: 'lasting',
  faith: 'lasting',
  allegiance: 'lasting',
  income: 'lasting',
  wealth: 'lasting',
  language: 'lasting',
  weapon: 'lasting',
  companion: 'lasting',
  illness: 'lasting'
} as const satisfies Readonly<Record<string, 'fixed' | 'lasting'>>
export type DetailLabel = keyof typeof DETAIL_LABELS
export const DETAIL_LABEL_NAMES = Object.keys(DETAIL_LABELS) as DetailLabel[]

/** One slot of the closed list: a base slot or `detail:<label>`. */
export type Slot = BaseSlot | `detail:${DetailLabel}`

const DETAIL_PREFIX = 'detail:'

const isDetailLabel = (label: string): label is DetailLabel =>
  Object.prototype.hasOwnProperty.call(DETAIL_LABELS, label)

/** The slot `text` names, or null when it is not on the closed list. */
export function parseSlot(text: string): Slot | null {
  if ((BASE_SLOTS as readonly string[]).includes(text)) return text as BaseSlot
  if (text.startsWith(DETAIL_PREFIX)) {
    const label = text.slice(DETAIL_PREFIX.length)
    if (isDetailLabel(label)) return `detail:${label}`
  }
  return null
}

/**
 * The other number of a slot word, where it is the same slot spelled singular or plural (second
 * live planted-error run, 2026-10-14: "trait", "roles", "detail:scar"): only these exact pairs,
 * each naming one slot of the closed list. Never a word of another meaning ("voice", "speech",
 * "memory", "secret", "event" stay refused).
 */
const OTHER_NUMBER: Readonly<Record<string, string>> = {
  eye: 'eyes',
  trait: 'traits',
  scar: 'scars',
  injury: 'injuries',
  object: 'objects',
  roles: 'role',
  ages: 'age',
  locations: 'location',
  relations: 'relation',
  histories: 'history',
  ...Object.fromEntries(DETAIL_LABEL_NAMES.map((label) => [`${label}s`, label]))
}

/** A slot word as written, or its other number when that is the closed list's spelling. */
const numbered = (word: string): string => {
  const lower = word.toLowerCase()
  return OTHER_NUMBER[lower] ?? lower
}

/**
 * The slot a reader's answer names, read a little leniently (live planted-error runs of
 * 2026-10-14: the model wrote a detail label bare, "occupation", a base slot behind the prefix,
 * "detail:location", or a slot in its other number, "trait", "roles", "detail:scar"): the exact
 * slot, else the one detail label written bare, else the one base slot written as a detail, each
 * also in its other number (`OTHER_NUMBER`) and any case; null for anything else ("emotion",
 * "dialogue", "voice" stay refused). Nothing is guessed: each spelling names exactly one slot of
 * the closed list, with the same meaning.
 */
export function readSlot(text: string): Slot | null {
  const trimmed = text.trim()
  const exact = parseSlot(trimmed)
  if (exact !== null) return exact
  const prefixed = trimmed.toLowerCase().startsWith(DETAIL_PREFIX)
  const word = numbered(prefixed ? trimmed.slice(DETAIL_PREFIX.length).trim() : trimmed)
  if ((BASE_SLOTS as readonly string[]).includes(word)) return word as BaseSlot
  if (isDetailLabel(word)) return `detail:${word}`
  return null
}

/**
 * The slots a place can hold (live planted-error run 2026-10-14: "Thornmere" was given a home):
 * its role, traits, history and relations, and the few details a place has. A place never has
 * eyes, an age, clothes, a birthplace or an occupation, and since the third live run of that day
 * (plan `ReaderPrecision.md`: "never settled at Thornmere" stored as Thornmere's location) no
 * location either: the slot says where a person is or goes, and a place named in a sentence is
 * where someone else is. A group may have a home or a faith.
 */
const PLACE_SLOTS: ReadonlySet<Slot> = new Set<Slot>([
  'role',
  'traits',
  'history',
  'relation',
  'detail:allegiance',
  'detail:faith',
  'detail:language',
  'detail:title',
  'detail:wealth'
])

/**
 * The person slots a thing never holds (plan `ReaderPrecision.md`, decided by Claude, unconfirmed:
 * "places and things are never the subject of a person slot, location included"). A thing's kind
 * covers the author's own categories, so a creature keeps eyes, hair, scars, an age and alive; it
 * never has a location, a role, kin, clothes or objects of its own.
 */
const THING_REFUSED: ReadonlySet<Slot> = new Set<Slot>([
  'location',
  'role',
  'kinship',
  'clothing',
  'objects'
])

/**
 * Whether a fact in `slot` can be about a record of `kind` (the ladder's `kind` refusal): a place
 * only in `PLACE_SLOTS`, a thing in no slot of `THING_REFUSED`, a secret or thread never (they are
 * topics, read as knows lines and steps), every other kind in any slot.
 */
export function slotFitsKind(slot: Slot, kind: string | undefined): boolean {
  if (kind === 'secret' || kind === 'thread') return false
  if (kind === 'place') return PLACE_SLOTS.has(slot)
  if (kind === 'thing') return !THING_REFUSED.has(slot)
  return true
}

/** A slot as stored and sent over IPC: any member of the closed list. */
export const SlotSchema = z.custom<Slot>(
  (value) => typeof value === 'string' && parseSlot(value) !== null,
  { message: 'Not a story-memory slot' }
)

/** The group a slot belongs to. */
export function slotGroup(slot: Slot): SlotGroup {
  if (slot.startsWith(DETAIL_PREFIX)) {
    const label = slot.slice(DETAIL_PREFIX.length)
    return isDetailLabel(label) ? DETAIL_LABELS[label] : 'fixed'
  }
  return BASE_GROUP[slot as BaseSlot]
}

/** The slots whose claims name a second record (`claim.object_id`): kinship and relation targets. */
export const OBJECT_SLOTS: readonly Slot[] = ['kinship', 'relation']

/**
 * The slots the reader no longer reads (F-16.17, the author's decision of 2026-10-14, plan
 * `ReaderNarrow.md`): the open-ended ones (traits, history, relation, role) and clothing and
 * objects, where nearly every wrong fact of four live runs sat. They stay on the closed list, so
 * stored v1 data, the author's own notes and the switch-over keep working; the reader is not asked
 * for them (`reader.v6`) and the pipeline refuses one it proposes anyway (`notRead`). Ms Scribe
 * answers such questions by searching the text and quoting the passage (`agent.v9`, `cite.v1`).
 * `reader.v7` read traits and history again as suggestions (plan `Suggestions.md`); its sixth live
 * run found them about half noise, so the author went back to concrete-only suggestions
 * (2026-10-15): `reader.v7` stays in the catalogue, unused, with its own set in its test.
 */
export const NOT_READ_SLOTS: ReadonlySet<Slot> = new Set<Slot>([
  'traits',
  'history',
  'relation',
  'role',
  'clothing',
  'objects'
])

/** Whether the reader still reads `slot` into facts (`NOT_READ_SLOTS` aside). */
export const slotIsRead = (slot: Slot): boolean => !NOT_READ_SLOTS.has(slot)

/** How a sheet and the panel name a base slot. */
export const SLOT_LABEL: Readonly<Record<BaseSlot, string>> = {
  eyes: 'Eyes',
  born: 'Born',
  species: 'Species',
  kinship: 'Family',
  hair: 'Hair',
  alive: 'Alive',
  role: 'Role',
  age: 'Age',
  scars: 'Scars',
  location: 'Last seen at',
  injuries: 'Injuries',
  clothing: 'Wearing',
  objects: 'Carrying',
  traits: 'Traits',
  history: 'History',
  relation: 'Relation',
  knows: 'Knows',
  thread: 'Thread'
}

/** A slot's display name: the base label, or the detail label with a capital ("Income"). */
export function slotLabel(slot: Slot): string {
  if (slot.startsWith(DETAIL_PREFIX)) {
    const label = slot.slice(DETAIL_PREFIX.length)
    return label.charAt(0).toUpperCase() + label.slice(1)
  }
  return SLOT_LABEL[slot as BaseSlot]
}

/** Every slot of the closed list, base slots first, then the details in list order. */
export const ALL_SLOTS: readonly Slot[] = [
  ...BASE_SLOTS,
  ...DETAIL_LABEL_NAMES.map((label): Slot => `detail:${label}`)
]
