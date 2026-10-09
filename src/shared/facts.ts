import { z } from 'zod'
import { factKey } from './observedFacts'

/**
 * Dated facts (F-9.13, phase P2 of the knowledge model): one row per statement about a record
 * (a story-bible sheet), from the author or read from the manuscript by the AI, each dated by the
 * scene it holds from and, for the AI's, carrying the words of the scene that state it (the
 * "no assuming" rule: no AI fact without its quote). The author's own sheet text stays in
 * `entity.fields` (decision D1, confirmed): the AI never writes there, and the sheet shows its
 * facts beside each field instead. This file owns the shapes both sides share and the one pure
 * rule for "the value of a field at a scene", `sheetAt`.
 */

/**
 * Where a statement stands (D7): `canon` is the story as written; `plan` is the author's intent
 * not yet on the page; `idea` is a maybe. A fact read from a scene whose status is Idea is an
 * idea; everything else starts as canon. The author flips it by hand.
 */
export const FACT_STATUSES = ['canon', 'plan', 'idea'] as const
export const FactStatus = z.enum(FACT_STATUSES)
export type FactStatus = z.infer<typeof FactStatus>

export const FACT_STATUS_LABEL: Readonly<Record<FactStatus, string>> = {
  canon: 'Canon',
  plan: 'Plan',
  idea: 'Idea'
}

/** Who stated it: the author on the sheet, or the AI reading a scene. */
export const FACT_ORIGINS = ['author', 'ai'] as const
export const FactOrigin = z.enum(FACT_ORIGINS)
export type FactOrigin = z.infer<typeof FactOrigin>

/**
 * One stored fact as the windows read it. An author fact with no `nodeId` is dated "from the
 * start" (the sheet's own text is the undated baseline and is not listed); an author fact with a
 * `nodeId` holds from that scene on (D4, "From scene…"). An AI fact always has the scene it was
 * read from and the quote; `hidden` is the author's "this is wrong", kept as a tombstone so the
 * next reading of any scene does not bring the statement back.
 */
export const Fact = z.object({
  id: z.string(),
  entityId: z.string(),
  attribute: z.string(),
  value: z.string(),
  /** The other record of a relationship (phase P3); null for a plain field fact. */
  objectEntityId: z.string().nullable(),
  nodeId: z.string().nullable(),
  quote: z.string().nullable(),
  origin: FactOrigin,
  status: FactStatus,
  hidden: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string()
})
export type Fact = z.infer<typeof Fact>

/**
 * How a field takes a newer value (D1, confirmed): a `replace` field holds one value at a time
 * (an age, a role, a place's type), so the sheet shows the newest one stated at the viewed scene
 * over the author's baseline; every other field `accumulate`s, and the details stated so far are
 * listed under the author's text.
 */
export type FieldMode = 'replace' | 'accumulate'

/** The replace fields (D1): short, single-valued attributes. Every other attribute accumulates. */
export const REPLACE_FIELDS: readonly string[] = [
  'age',
  'status',
  'alive',
  'role',
  'allegiance',
  'type',
  'category'
]

/**
 * Whether a fact states a sheet field (F-9.14): a relationship (`relation:<type>`, with the other
 * record in `objectEntityId`) and a thread event (`thread:<event>`) are dated facts too, but they
 * are no field of the sheet, so `sheetAt`, the prompts' story-bible lines, and the consistency
 * checker never read them as one. A field id never holds a colon (`EntityFieldId`).
 */
export function isFieldFact(fact: Pick<Fact, 'attribute' | 'objectEntityId'>): boolean {
  return fact.objectEntityId === null && !fact.attribute.includes(':')
}

export function fieldMode(attribute: string): FieldMode {
  return REPLACE_FIELDS.includes(attribute) ? 'replace' : 'accumulate'
}

/**
 * The unique key of a stored fact within its record (`fact.fact_key`). An AI statement is keyed
 * by its scene and `factKey` (the same words in two scenes are two rows, one passage each); the
 * author's baseline by the attribute alone; an author fact dated at a scene by both.
 */
export function aiFactKey(nodeId: string, attribute: string, value: string): string {
  return `ai\u0000${nodeId}\u0000${factKey(attribute, value)}`
}

export function authorFactKey(attribute: string, nodeId: string | null): string {
  return `author\u0000${nodeId ?? ''}\u0000${attribute}`
}

/** One passage or dated author line behind a value on the sheet. */
export interface FactSourceAt {
  factId: string
  /** The scene; null for an author line whose scene was deleted. */
  nodeId: string | null
  quote: string | null
  origin: FactOrigin
}

/** One value of one field, merged over every scene that states it (same `factKey`). */
export interface FactValueAt {
  value: string
  factIds: string[]
  /** Earliest first. */
  sources: FactSourceAt[]
  /** The author's when any source is the author's. */
  origin: FactOrigin
  /** The status of its earliest source. */
  status: FactStatus
}

/** A value in a field's history, marked when it is stated only after the viewed scene. */
export interface FactHistoryAt extends FactValueAt {
  later: boolean
}

/** One field of a record as of one point in the story. */
export interface SheetFieldAt {
  attribute: string
  mode: FieldMode
  /** The author's own text, undated (`entity.fields`); null when blank. */
  baseline: string | null
  /**
   * A replace field's value at the position: the newest canon value stated at or before it (an
   * AI fact or an author line dated at a scene), restated counts as newer. A value counts as canon
   * when any of its statements at or before the position is canon; plan and idea statements never
   * decide it. Null when none is.
   */
  current: FactValueAt | null
  /** An accumulate field's details stated at or before the position, earliest first. */
  details: FactValueAt[]
  /** Every visible dated value, earliest first; the field history. */
  history: FactHistoryAt[]
}

export interface SheetAtInput {
  /**
   * The record's facts as main lists them (never the undated author rows, which mirror `fields`;
   * an author fact with no scene is one whose scene was deleted). Hidden ones are left out here.
   */
  facts: readonly Fact[]
  /** The author's baseline text per field (`entity.fields`). */
  fields: Readonly<Partial<Record<string, string>>>
  /** The record's template fields in order; an attribute only facts carry is appended. */
  attributes: readonly string[]
  /** The manuscript documents in reading order (D2: story position is reading order). */
  order: readonly string[]
  /** The scene the sheet is viewed at; null (or a scene not in `order`) is the end of the book. */
  position: string | null
}

/**
 * The record as of a point in the story (F-9.13), with no AI and no I/O: the one rule every view
 * and prompt reads a sheet "at a scene" through. Per field, the author's baseline, then the dated
 * values: a replace field's newest canon value at or before the position, an accumulate field's
 * details so far, and the whole history. Values with the same `factKey` merge, one source per
 * statement. A value stated after the position is in the history only, marked `later`. An author
 * line whose scene was deleted sorts first in the history and is never current.
 */
export function sheetAt(input: SheetAtInput): SheetFieldAt[] {
  const index = new Map(input.order.map((id, at) => [id, at]))
  const end = input.order.length
  const position = input.position === null ? end : (index.get(input.position) ?? end)
  /** A scene outside the order sorts at the end; an orphaned author line at the start. */
  const at = (fact: Fact): number => (fact.nodeId === null ? -1 : (index.get(fact.nodeId) ?? end))

  const dated = input.facts
    .filter((fact) => !fact.hidden && isFieldFact(fact))
    .map((fact, input) => ({ fact, input }))
    .sort(
      (a, b) =>
        at(a.fact) - at(b.fact) ||
        a.fact.createdAt.localeCompare(b.fact.createdAt) ||
        a.input - b.input
    )
    .map(({ fact }) => fact)

  const attributes = [...input.attributes]
  for (const fact of dated)
    if (!attributes.includes(fact.attribute)) attributes.push(fact.attribute)

  return attributes.map((attribute) => {
    const groups = new Map<
      string,
      { value: FactValueAt; first: number; canonLast: number; canonLastAt: string }
    >()
    for (const fact of dated) {
      if (fact.attribute !== attribute) continue
      const key = factKey(attribute, fact.value)
      const where = at(fact)
      const source: FactSourceAt = {
        factId: fact.id,
        nodeId: fact.nodeId,
        quote: fact.quote,
        origin: fact.origin
      }
      const held = groups.get(key)
      // Only a canon statement at or before the position decides `current` (plan and idea never do).
      const counts = fact.status === 'canon' && where <= position
      if (held === undefined) {
        groups.set(key, {
          value: {
            value: fact.value,
            factIds: [fact.id],
            sources: [source],
            origin: fact.origin,
            status: fact.status
          },
          first: where,
          canonLast: counts ? where : -2,
          canonLastAt: counts ? fact.createdAt : ''
        })
        continue
      }
      held.value.factIds.push(fact.id)
      held.value.sources.push(source)
      if (fact.origin === 'author') held.value.origin = 'author'
      if (counts && where >= held.canonLast) {
        held.canonLast = where
        held.canonLastAt = fact.createdAt
      }
    }
    const values = [...groups.values()]
    const reached = values.filter((group) => group.first <= position)
    const mode = fieldMode(attribute)
    const current =
      mode === 'replace'
        ? (values
            .filter((group) => group.canonLast >= 0)
            .sort((a, b) => b.canonLast - a.canonLast || b.canonLastAt.localeCompare(a.canonLastAt))
            .map((group): FactValueAt => ({ ...group.value, status: 'canon' }))[0] ?? null)
        : null
    const baseline = input.fields[attribute]
    return {
      attribute,
      mode,
      baseline: baseline === undefined || baseline === '' ? null : baseline,
      current,
      details:
        mode === 'accumulate'
          ? reached.map((group) => ({
              ...group.value,
              sources: group.value.sources.filter(
                (source) =>
                  (source.nodeId === null ? -1 : (index.get(source.nodeId) ?? end)) <= position
              )
            }))
          : [],
      history: values.map((group) => ({ ...group.value, later: group.first > position }))
    }
  })
}
