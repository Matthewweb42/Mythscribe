import { z } from 'zod'
import { builtinCategory, categoryFieldLabel } from './categories'
import { ENTITY_NAME_MAX, EntityKind, toEntityNameKey, type EntityFieldId } from './entities'

/**
 * Observed facts (F-5.16): what the manuscript states about a character, a place, or an in-world
 * thing, logged by the background story-bible job with each scene's summary. A fact is derived
 * index data (author-control rule 1): it lives in `observed_fact`, never in the entity's own
 * fields, always carries the passage it was read from, and one click hides a wrong one for good.
 * This file owns the attribute vocabulary, the limits, the shapes both sides share, and the pure
 * merge the entity page, the reference card, and the prompt builders all read the facts through.
 */

/** Longest stored value of one fact; the parser cuts here. */
export const OBSERVED_FACT_VALUE_MAX = 160
/** Longest stored quote: enough of the passage to find it again in the scene. */
export const OBSERVED_FACT_QUOTE_MAX = 160

/**
 * The categories the story-bible job logs facts about and creates sheets in (F-5.16): the three
 * of F-9.1. The library's other categories (F-9.11) are the author's and the context import's.
 */
export const OBSERVED_KINDS = ['character', 'setting', 'world'] as const
export const ObservedKind = z.enum(OBSERVED_KINDS)
export type ObservedKind = z.infer<typeof ObservedKind>

/**
 * What a fact can be about, per kind: a fixed list, so the same thing said in two scenes lands
 * under the same attribute and can be merged or seen to differ. Every attribute is a field of
 * the kind's structured template under the same id, which is where `Add to sheet` writes it. The
 * fields left out (`notes`, `associatedCharacters`) are the author's own.
 */
export const OBSERVED_ATTRIBUTES = {
  character: ['age', 'gender', 'appearance', 'personality', 'background', 'goals', 'relationships'],
  setting: ['type', 'description', 'atmosphere', 'features'],
  world: ['category', 'description', 'rules', 'impact']
} as const satisfies Record<ObservedKind, readonly EntityFieldId[]>

/** Whether `attribute` is one a fact about an entity of `kind` may carry. */
export function isObservedAttribute(
  kind: EntityKind,
  attribute: string
): attribute is EntityFieldId {
  const parsed = ObservedKind.safeParse(kind)
  if (!parsed.success) return false
  const allowed: readonly string[] = OBSERVED_ATTRIBUTES[parsed.data]
  return allowed.includes(attribute)
}

/**
 * The sheet field `Add to sheet` writes an attribute into, or null for an attribute the kind
 * does not carry (a row written under an older vocabulary): then there is no field to fill.
 */
export function observedAttributeField(kind: EntityKind, attribute: string): EntityFieldId | null {
  return isObservedAttribute(kind, attribute) ? attribute : null
}

/** The attribute as the sheet names it ("Goals / motivations"); the raw id when the kind has no such field. */
export function observedAttributeLabel(kind: EntityKind, attribute: string): string {
  const category = builtinCategory(kind)
  return category === undefined ? attribute : categoryFieldLabel(category, attribute)
}

/** A stored fact: one statement of one scene about one entity. */
export const ObservedFact = z.object({
  id: z.string(),
  entityId: z.string(),
  /** The manuscript document the fact was read from. */
  nodeId: z.string(),
  /** A field id of the entity's kind (`OBSERVED_ATTRIBUTES`); a plain string so an old row still reads. */
  attribute: z.string(),
  value: z.string(),
  /** The words of the scene that state it; what `Go to passage` selects. */
  quote: z.string(),
  /** The author hid it as wrong; kept as a tombstone so a re-read does not bring it back. */
  hidden: z.boolean(),
  createdAt: z.string()
})
export type ObservedFact = z.infer<typeof ObservedFact>

/**
 * A fact as the model answers it, before its name is resolved to an entity: the name as the
 * scene spells it and the kind the model took it for. The summary parser keeps only the facts
 * that fit this shape, whose attribute is one of the kind's, and whose quote is in the scene.
 */
export const ExtractedFact = z.object({
  entity: z.string().trim().min(1).max(ENTITY_NAME_MAX),
  kind: ObservedKind,
  attribute: z.string().trim().min(1),
  value: z.string().trim().min(1).max(OBSERVED_FACT_VALUE_MAX),
  quote: z.string().trim().min(1).max(OBSERVED_FACT_QUOTE_MAX)
})
export type ExtractedFact = z.infer<typeof ExtractedFact>

/**
 * The key two facts about one entity are the same statement under: the attribute and the value,
 * NFC, lower-cased, whitespace collapsed, and the closing punctuation dropped, so "Grey eyes."
 * and "grey  eyes" merge. The same key decides a tombstone: a hidden fact keeps its twin out of
 * every scene of the entity.
 */
export function factKey(attribute: string, value: string): string {
  const normalized = value
    .normalize('NFC')
    .trim()
    .replace(/\s+/gu, ' ')
    .replace(/[.!?,;:\s]+$/u, '')
    .toLocaleLowerCase()
  return `${attribute.trim().toLocaleLowerCase()}\u0000${normalized}`
}

/** One passage a merged fact was read from. */
export interface FactSource {
  /** The stored fact this passage belongs to. */
  factId: string
  nodeId: string
  quote: string
}

/**
 * One row of "From the manuscript": a value of one attribute of one entity, with every scene
 * that states it. `differs` marks a row whose entity and attribute carry at least one other,
 * different value — both rows are shown, in reading order, and neither is called wrong.
 */
export interface FactGroup {
  entityId: string
  attribute: string
  /** The value as the earliest scene in reading order words it. */
  value: string
  /** Every stored fact merged into this row; hiding the row hides them all. */
  factIds: string[]
  /** One passage per scene, in reading order. */
  sources: FactSource[]
  differs: boolean
}

/** Where an attribute sorts: template order, an attribute no template knows last. */
function attributeRank(attribute: string): number {
  const at = ATTRIBUTE_ORDER.indexOf(attribute)
  return at === -1 ? ATTRIBUTE_ORDER.length : at
}

/** Every field of the observed kinds' templates, in order (character, place, world). */
const ATTRIBUTE_ORDER: readonly string[] = [
  ...new Set(
    OBSERVED_KINDS.flatMap((kind) => (builtinCategory(kind)?.fields ?? []).map((field) => field.id))
  )
]

/**
 * Merges the visible facts for display (F-5.16), with no AI: facts of one entity and attribute
 * whose values share a `factKey` become one row carrying every source passage (one per scene),
 * and an entity and attribute left with two or more rows has them all marked `differs`.
 * `readingOrder` is the manuscript's document ids in reading order; a fact of a scene outside it
 * sorts after the rest. Rows come entity by entity in the order the entities first appear in
 * `facts`, then by attribute in template order, then by the reading position of their first
 * source. Hidden facts are left out.
 */
export function groupFacts(
  facts: readonly ObservedFact[],
  readingOrder: readonly string[]
): FactGroup[] {
  const position = new Map(readingOrder.map((nodeId, at) => [nodeId, at]))
  const at = (nodeId: string): number => position.get(nodeId) ?? readingOrder.length
  const ordered = facts
    .filter((fact) => !fact.hidden)
    .map((fact, input) => ({ fact, input }))
    .sort(
      (a, b) =>
        at(a.fact.nodeId) - at(b.fact.nodeId) ||
        a.fact.createdAt.localeCompare(b.fact.createdAt) ||
        a.input - b.input
    )
    .map(({ fact }) => fact)

  const entityOrder = new Map<string, number>()
  for (const fact of facts) {
    if (!entityOrder.has(fact.entityId)) entityOrder.set(fact.entityId, entityOrder.size)
  }

  // Insertion order is reading order, so a group's first fact is its earliest statement.
  const groups = new Map<string, FactGroup>()
  const perAttribute = new Map<string, number>()
  for (const fact of ordered) {
    const attributeKey = `${fact.entityId}\u0000${fact.attribute.trim().toLocaleLowerCase()}`
    const key = `${fact.entityId}\u0000${factKey(fact.attribute, fact.value)}`
    const group = groups.get(key)
    if (group === undefined) {
      groups.set(key, {
        entityId: fact.entityId,
        attribute: fact.attribute,
        value: fact.value,
        factIds: [fact.id],
        sources: [{ factId: fact.id, nodeId: fact.nodeId, quote: fact.quote }],
        differs: false
      })
      perAttribute.set(attributeKey, (perAttribute.get(attributeKey) ?? 0) + 1)
      continue
    }
    group.factIds.push(fact.id)
    if (!group.sources.some((source) => source.nodeId === fact.nodeId)) {
      group.sources.push({ factId: fact.id, nodeId: fact.nodeId, quote: fact.quote })
    }
  }

  return [...groups.values()]
    .map((group, reading) => ({
      group: {
        ...group,
        differs:
          (perAttribute.get(
            `${group.entityId}\u0000${group.attribute.trim().toLocaleLowerCase()}`
          ) ?? 0) > 1
      },
      reading
    }))
    .sort(
      (a, b) =>
        (entityOrder.get(a.group.entityId) ?? 0) - (entityOrder.get(b.group.entityId) ?? 0) ||
        attributeRank(a.group.attribute) - attributeRank(b.group.attribute) ||
        a.reading - b.reading
    )
    .map(({ group }) => group)
}

/** Settings-table key under which the names of deleted AI-logged entities are stored as JSON. */
export const OBSERVED_DISMISSED_KEY = 'observedFacts.dismissed'

/**
 * The entities the author deleted while the manuscript had facts about them (F-5.16): the kind
 * and the name key (`toEntityNameKey`). The story-bible job creates no entity for a name listed
 * here; creating the entity by hand takes its entry out again.
 */
export const ObservedDismissed = z.object({
  names: z.array(z.object({ kind: EntityKind, nameKey: z.string() })).default([])
})
export type ObservedDismissed = z.infer<typeof ObservedDismissed>

/** The empty list a project without a stored row (or with an unreadable one) starts from. */
export function defaultObservedDismissed(): ObservedDismissed {
  return { names: [] }
}

/** Whether the author deleted the entity of this kind and name, so it is not to be re-created. */
export function isObservedDismissed(
  dismissed: ObservedDismissed,
  kind: EntityKind,
  name: string
): boolean {
  const nameKey = toEntityNameKey(name)
  return dismissed.names.some((entry) => entry.kind === kind && entry.nameKey === nameKey)
}

/** The list with this kind and name on it, once. */
export function withObservedDismissed(
  dismissed: ObservedDismissed,
  kind: EntityKind,
  name: string
): ObservedDismissed {
  if (isObservedDismissed(dismissed, kind, name)) return dismissed
  return { names: [...dismissed.names, { kind, nameKey: toEntityNameKey(name) }] }
}

/** The list without this kind and name. */
export function withoutObservedDismissed(
  dismissed: ObservedDismissed,
  kind: EntityKind,
  name: string
): ObservedDismissed {
  if (!isObservedDismissed(dismissed, kind, name)) return dismissed
  const nameKey = toEntityNameKey(name)
  return {
    names: dismissed.names.filter((entry) => !(entry.kind === kind && entry.nameKey === nameKey))
  }
}
