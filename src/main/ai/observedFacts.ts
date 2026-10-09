import { builtinCategory } from '@shared/categories'
import { entityTagName, toEntityNameKey } from '@shared/entities'
import type { Entity } from '@shared/ipc/contract'
import { nameWords } from '@shared/mentions'
import {
  OBSERVED_KINDS,
  ObservedKind,
  isObservedAttribute,
  isObservedDismissed,
  type ExtractedFact
} from '@shared/observedFacts'
import { SUMMARY_KNOWN_NAMES_MAX } from '@shared/summary'
import { THREAD_KIND } from '@shared/threads'
import { classifyTagTerm, mayAutoCreateTag } from '@shared/tagTerms'
import { createEntity, listEntities, type EntityWrite } from '../entity/entityStore'
import type { Fact, FactStatus } from '@shared/facts'
import { applySceneFacts, type SceneFactInput } from '../entity/factStore'
import { getObservedDismissed } from '../project/settingsStore'
import { manuscriptTexts } from '../tag/proposedTags'
import { findTagByNameOrAlias, listTags } from '../tag/tagStore'
import type { TreeDb } from '../tree/treeStore'

/**
 * The automatic story bible's write side (F-5.16): which story-bible names a scene contains
 * (what the summary request lists and its content hash covers), and how the facts the model
 * answered become rows — each name resolved to an entity, a missing entity created as AI-made
 * with its tag, and the scene's facts replaced. Everything here is local; the one request is
 * the summary's own (`summarize.ts`).
 */

/** The story-bible names occurring in a scene, by kind, each as the bible (or the scene) spells it. */
export type KnownNames = Record<ObservedKind, string[]>

/**
 * The kind a sheet's name is listed under: its own for the three the job knows, World for every
 * other library or project category (F-9.11), as a magic system was a World sheet before.
 */
const observedKindOf = (kind: string): ObservedKind => {
  const parsed = ObservedKind.safeParse(kind)
  return parsed.success ? parsed.data : 'world'
}

/**
 * `words` as they would stand in prose — separated by whitespace, on word boundaries of any
 * script (a lookaround over letters and digits, since `\b` is ASCII-only) — matched without
 * regard to case. Null for a name with no words.
 */
function wordsPattern(words: readonly string[]): RegExp | null {
  if (words.length === 0) return null
  const escaped = words.map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  return new RegExp(`(?<![\\p{L}\\p{N}])${escaped.join('\\s+')}(?![\\p{L}\\p{N}])`, 'giu')
}

/** Whether every word of a matched name starts like a proper noun (a caseless script counts as one). */
function isProperNoun(match: string): boolean {
  return match.split(/\s+/u).every((word) => {
    const first = [...word][0] ?? ''
    return first === first.toLocaleUpperCase()
  })
}

/**
 * Whether a scene names `tagName` (kebab-case, as the bank stores it): its words in order on
 * word boundaries, in any case — and, when `properNoun` is asked, at least once capitalised
 * like a name. F-4.13 uses it to keep the job from making a name tag the scene does not hold.
 */
export function sceneNamesTag(sceneText: string, tagName: string, properNoun: boolean): boolean {
  const pattern = wordsPattern(nameWords(tagName))
  if (pattern === null) return false
  for (const match of sceneText.matchAll(pattern)) {
    if (!properNoun || isProperNoun(match[0])) return true
  }
  return false
}

/**
 * The entities whose name occurs in `sceneText`: its words in order on word boundaries, in any
 * case. One owner for "this scene names that entity": the known names below and the consistency
 * checker's references (F-13.4) both read it.
 */
export function entitiesNamedIn(entities: readonly Entity[], sceneText: string): Entity[] {
  // F-4.14: an alias ("Rynna", "the High Crown") names the sheet as well as its full name does.
  return entities.filter((entity) =>
    [entity.name, ...entity.aliases].some(
      (name) => wordsPattern(toEntityNameKey(name).split(' '))?.test(sceneText) === true
    )
  )
}

/**
 * The story-bible names a scene contains (F-5.16, decision 3 of the plan): the entities of all
 * three kinds whose name occurs in `sceneText`, as the author spells them, and then the
 * character, setting, and world-building tags no entity carries, as the scene spells them (a
 * tag name is kebab-case, and the entity a fact creates takes the name the model answers). A
 * character tag must read as a proper noun, the F-4.12 rule that tells Rose from a rose. Case
 * is otherwise ignored, each name is listed once per kind, and the whole list is capped at
 * `SUMMARY_KNOWN_NAMES_MAX` in kind order. Only names the scene contains are listed, so an
 * entity created from one scene changes nothing for a scene that never names it.
 */
export function knownNames(db: TreeDb, sceneText: string): KnownNames {
  const known: KnownNames = { character: [], setting: [], world: [] }
  const keys = new Set<string>()
  const add = (kind: ObservedKind, name: string): void => {
    const key = `${kind}\u0000${toEntityNameKey(name)}`
    if (keys.has(key)) return
    keys.add(key)
    known[kind].push(name)
  }

  const entities = listEntities(db)
  // F-9.14: a thread record is no character, place, or thing; the prompt lists threads apart.
  const things = entities.filter((entity) => entity.kind !== THREAD_KIND)
  for (const entity of entitiesNamedIn(things, sceneText))
    add(observedKindOf(entity.kind), entity.name)

  const linked = new Set(entities.map((entity) => entity.tagId))
  for (const tag of listTags(db)) {
    if (linked.has(tag.id)) continue
    const kind = OBSERVED_KINDS.find(
      (candidate) => builtinCategory(candidate)?.tagCategory === tag.category
    )
    if (kind === undefined) continue
    const pattern = wordsPattern(nameWords(tag.name))
    if (pattern === null) continue
    for (const match of sceneText.matchAll(pattern)) {
      if (kind === 'character' && !isProperNoun(match[0])) continue
      add(kind, match[0].replace(/\s+/gu, ' '))
      break
    }
  }

  let room = SUMMARY_KNOWN_NAMES_MAX
  for (const kind of OBSERVED_KINDS) {
    known[kind] = known[kind].slice(0, room)
    room -= known[kind].length
  }
  return known
}

/** What a run did to the story bible: who to tell, and about what. */
export interface ObservedFactsChange {
  /** The entities whose visible facts may have changed, for `fact:changed`. */
  entityIds: string[]
  /** F-9.13: the facts the run added, as stored (what the Changes log lists). */
  added: Fact[]
  /** The entities created for a name that had none, each with what its tag did to the bank. */
  created: EntityWrite[]
  /** Facts left out here: a dismissed name, or an attribute the resolved entity's kind does not carry. */
  skipped: number
}

/**
 * The record a name stands for, or undefined when the story bible has none: the record of the
 * stated kind with that name, else one of another kind (the model took Ash the place for a
 * person: attach, do not create a twin), else one with that name as an alias (F-4.14), else the
 * record linked to the tag the name makes (`entityTagName`: the sheet reads "Dr. Vell" and the
 * scene says "Dr Vell", one tag `dr-vell`), the stated kind first each time. `kind` null takes
 * any kind alike (a relationship names its two ends without one).
 */
export function resolveName(
  db: TreeDb,
  entities: readonly Entity[],
  name: string,
  kind: string | null
): Entity | undefined {
  const pick = (found: Entity[]): Entity | undefined =>
    (kind === null ? undefined : found.find((entity) => entity.kind === kind)) ?? found[0]
  const key = toEntityNameKey(name)
  const byName = pick(entities.filter((entity) => toEntityNameKey(entity.name) === key))
  if (byName !== undefined) return byName
  const byAlias = pick(
    entities.filter((entity) => entity.aliases.some((alias) => toEntityNameKey(alias) === key))
  )
  if (byAlias !== undefined) return byAlias
  const tagName = entityTagName(name)
  const tagId = tagName === '' ? undefined : findTagByNameOrAlias(db, tagName)
  if (tagId === undefined) return undefined
  return pick(entities.filter((entity) => entity.tagId === tagId))
}

/**
 * The author's tag rule (2026-10-08) for a sheet the reading makes for a new name: a tag the bank
 * already has is always linked; a new one only for a name or a repeated term (`classifyTagTerm`
 * over the whole manuscript, read once and only when asked).
 */
export function sheetTagRule(
  db: TreeDb,
  nodeId: string,
  sceneText: string
): (name: string) => boolean {
  let texts: string[] | null = null
  return (name) => {
    const tagName = entityTagName(name)
    if (tagName !== '' && findTagByNameOrAlias(db, tagName) !== undefined) return true
    texts ??= manuscriptTexts(db, { nodeId, text: sceneText })
    return mayAutoCreateTag(classifyTagTerm(name, texts))
  }
}

/** The facts of one scene resolved to records, ready for `applySceneFacts`. */
export interface ResolvedSceneFacts {
  rows: SceneFactInput[]
  /** The records created for a name that had none, each with what its tag did to the bank. */
  created: EntityWrite[]
  /** Facts left out: a dismissed name, or an attribute the resolved record's kind does not carry. */
  skipped: number
}

/**
 * Resolves what one scene states (F-5.16, F-9.13) to records, in the caller's transaction: each
 * fact's name to a record (`resolveName`); a name with no record gets one — AI-made, blank
 * template, with its tag under the author's tag rule (`sheetTagRule`) — unless the author deleted
 * a record of that kind and name (`observedFacts.dismissed`), in which case the fact is left out;
 * a fact that landed on a record of another kind is kept only when that kind carries the
 * attribute. Nothing is stored yet: the caller hands the rows to `applySceneFacts` with the
 * scene's other statements (F-9.14's relationships and thread events), in one call.
 */
export function resolveObservedFacts(
  tx: TreeDb,
  nodeId: string,
  facts: readonly ExtractedFact[],
  sceneText: string
): ResolvedSceneFacts {
  const entities = listEntities(tx)
  const dismissed = getObservedDismissed(tx)
  const created: EntityWrite[] = []
  const rows: SceneFactInput[] = []
  let skipped = 0
  const mayTag = sheetTagRule(tx, nodeId, sceneText)
  for (const fact of facts) {
    let entity = resolveName(tx, entities, fact.entity, fact.kind)
    if (entity === undefined) {
      if (isObservedDismissed(dismissed, fact.kind, fact.entity)) {
        skipped += 1
        continue
      }
      const write = createEntity(
        tx,
        { kind: fact.kind, name: fact.entity, template: 'blank' },
        'ai',
        { tag: mayTag(fact.entity) }
      )
      created.push(write)
      entities.push(write.entity)
      entity = write.entity
    }
    if (!isObservedAttribute(entity.kind, fact.attribute)) {
      skipped += 1
      continue
    }
    rows.push({
      entityId: entity.id,
      attribute: fact.attribute,
      value: fact.value,
      quote: fact.quote
    })
  }
  return { rows, created, skipped }
}

/**
 * Stores what one scene states (F-5.16, F-9.13), in one transaction (it nests as a savepoint
 * inside the caller's): the facts resolved (`resolveObservedFacts`), then applied, sticky
 * (`applySceneFacts`): new statements added with `status`, tombstones honoured, and a fact whose
 * quote left `sceneText` removed. An empty list with an empty text clears the scene's AI facts.
 */
export function applyObservedFacts(
  db: TreeDb,
  nodeId: string,
  facts: readonly ExtractedFact[],
  sceneText: string,
  status: FactStatus = 'canon'
): ObservedFactsChange {
  return db.transaction((tx) => {
    const resolved = resolveObservedFacts(tx, nodeId, facts, sceneText)
    const diff = applySceneFacts(tx, nodeId, resolved.rows, sceneText, status)
    return {
      entityIds: diff.entityIds,
      added: diff.added,
      created: resolved.created,
      skipped: resolved.skipped
    }
  })
}
