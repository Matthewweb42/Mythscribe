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
 *   one list, refused by the P2a reader (`readerAccepts`).
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

/** Whether the P2a reader may propose `slot` (knows and thread wait for `reader.v2`, P2b). */
export function readerAccepts(slot: Slot): boolean {
  const group = slotGroup(slot)
  return group !== 'knows' && group !== 'thread'
}

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
