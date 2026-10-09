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
import { createEntity, listEntities, type EntityWrite } from '../entity/entityStore'
import type { Fact, FactStatus } from '@shared/facts'
import { applySceneFacts, type SceneFactInput } from '../entity/factStore'
import { getObservedDismissed } from '../project/settingsStore'
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
  for (const entity of entitiesNamedIn(entities, sceneText))
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
 * The entity a fact's name stands for, or undefined when the story bible has none: the entity
 * of the stated kind with that name, else one of another kind (the model took Ash the place
 * for a person: attach, do not create a twin), else the entity linked to the tag the name
 * makes (`entityTagName`: the sheet reads "Dr. Vell" and the scene says "Dr Vell", one tag
 * `dr-vell`), the stated kind first.
 */
function resolveEntity(
  db: TreeDb,
  entities: readonly Entity[],
  fact: ExtractedFact
): Entity | undefined {
  const key = toEntityNameKey(fact.entity)
  const named = entities.filter((entity) => toEntityNameKey(entity.name) === key)
  const byName = named.find((entity) => entity.kind === fact.kind) ?? named[0]
  if (byName !== undefined) return byName
  // F-4.14: a fact about "Rynna" belongs on the sheet that has Rynna as an alias.
  const aliased = entities.filter((entity) =>
    entity.aliases.some((alias) => toEntityNameKey(alias) === key)
  )
  const byAlias = aliased.find((entity) => entity.kind === fact.kind) ?? aliased[0]
  if (byAlias !== undefined) return byAlias
  const tagName = entityTagName(fact.entity)
  const tagId = tagName === '' ? undefined : findTagByNameOrAlias(db, tagName)
  if (tagId === undefined) return undefined
  const tagged = entities.filter((entity) => entity.tagId === tagId)
  return tagged.find((entity) => entity.kind === fact.kind) ?? tagged[0]
}

/**
 * Stores what one scene states (F-5.16, F-9.13), in one transaction (it nests as a savepoint
 * inside the caller's): each fact's name is resolved to an entity (`resolveEntity`); a name with
 * no entity gets one — AI-made, blank template, with its tag through the F-9.4 link — unless the
 * author deleted an entity of that kind and name (`observedFacts.dismissed`), in which case the
 * fact is left out; a fact that landed on an entity of another kind is kept only when that kind
 * carries the attribute. Then the scene's dated facts are applied, sticky (`applySceneFacts`):
 * new statements added with `status`, tombstones honoured, and a fact whose quote left
 * `sceneText` removed. An empty list with an empty text clears the scene's AI facts.
 */
export function applyObservedFacts(
  db: TreeDb,
  nodeId: string,
  facts: readonly ExtractedFact[],
  sceneText: string,
  status: FactStatus = 'canon'
): ObservedFactsChange {
  return db.transaction((tx) => {
    const entities = listEntities(tx)
    const dismissed = getObservedDismissed(tx)
    const created: EntityWrite[] = []
    const rows: SceneFactInput[] = []
    let skipped = 0
    for (const fact of facts) {
      let entity = resolveEntity(tx, entities, fact)
      if (entity === undefined) {
        if (isObservedDismissed(dismissed, fact.kind, fact.entity)) {
          skipped += 1
          continue
        }
        const write = createEntity(
          tx,
          { kind: fact.kind, name: fact.entity, template: 'blank' },
          'ai'
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
    const diff = applySceneFacts(tx, nodeId, rows, sceneText, status)
    return { entityIds: diff.entityIds, added: diff.added, created, skipped }
  })
}
