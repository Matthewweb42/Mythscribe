import { count } from 'drizzle-orm'
import type { StoryCategory } from '@shared/categories'
import type { Entity, Tag } from '@shared/ipc/contract'
import type { Fact } from '@shared/facts'
import {
  findOrganiseCandidates,
  type CandidateSheet,
  type CandidateTag,
  type OrganiseCandidates
} from '@shared/organise'
import { loadAgentProject, type AgentProject } from '../ai/agentTools'
import { tagMention } from '../db/schema'
import { listCategories } from '../entity/categoryStore'
import { factsForEntities } from '../entity/factStore'
import { listTags } from '../tag/tagStore'
import type { TreeDb } from '../tree/treeStore'

/**
 * The project as one Organise run sees it (F-9.10): the agent's view of the binder (documents
 * as `n1`, `n2`, … in tree order, `loadAgentProject`), every tag as `t1`, … and every sheet as
 * `s1`, … in list order, the categories, the visible observed facts per sheet, and what uses each
 * tag. Built once per run; the refs hold for the whole run.
 */
export interface OrganiseProject {
  agent: AgentProject
  tags: Tag[]
  tagRef: Map<string, string>
  tagByRef: Map<string, Tag>
  sheets: Entity[]
  sheetRef: Map<string, string>
  sheetByRef: Map<string, Entity>
  categories: StoryCategory[]
  /** Documents whose text mentions each tag (F-4.12), by tag id. */
  mentions: Map<string, number>
  /** Tags nested under each tag, by tag id. */
  children: Map<string, number>
  /** Sheets linked to each tag (F-9.4), by tag id. */
  sheetsOfTag: Map<string, number>
  /** The visible AI facts of each sheet (F-5.16, F-9.13), by sheet id. */
  facts: Map<string, Fact[]>
}

function refs<T extends { id: string }>(
  items: readonly T[],
  prefix: string
): { refOf: Map<string, string>; byRef: Map<string, T> } {
  const refOf = new Map<string, string>()
  const byRef = new Map<string, T>()
  items.forEach((item, index) => {
    const ref = `${prefix}${index + 1}`
    refOf.set(item.id, ref)
    byRef.set(ref, item)
  })
  return { refOf, byRef }
}

const tally = (ids: Iterable<string | null>): Map<string, number> => {
  const counts = new Map<string, number>()
  for (const id of ids) if (id !== null) counts.set(id, (counts.get(id) ?? 0) + 1)
  return counts
}

export function loadOrganiseProject(db: TreeDb): OrganiseProject {
  const agent = loadAgentProject(db)
  const tags = listTags(db)
  const sheets = agent.entities
  const tagRefs = refs(tags, 't')
  const sheetRefs = refs(sheets, 's')
  const mentions = new Map(
    db
      .select({ tagId: tagMention.tagId, n: count() })
      .from(tagMention)
      .groupBy(tagMention.tagId)
      .all()
      .map((row) => [row.tagId, row.n] as const)
  )
  const facts = new Map<string, Fact[]>()
  for (const fact of factsForEntities(
    db,
    sheets.map((sheet) => sheet.id)
  )) {
    if (fact.origin !== 'ai') continue
    facts.set(fact.entityId, [...(facts.get(fact.entityId) ?? []), fact])
  }
  return {
    agent,
    tags,
    tagRef: tagRefs.refOf,
    tagByRef: tagRefs.byRef,
    sheets,
    sheetRef: sheetRefs.refOf,
    sheetByRef: sheetRefs.byRef,
    categories: listCategories(db),
    mentions,
    children: tally(tags.map((tag) => tag.parentId)),
    sheetsOfTag: tally(sheets.map((sheet) => sheet.tagId)),
    facts
  }
}

/** Whether a sheet has nothing in it: no field value, no page text, no picture. */
export function isEmptySheet(sheet: Entity): boolean {
  return (
    Object.values(sheet.fields).every((value) => (value ?? '').trim() === '') &&
    (sheet.body ?? '').trim() === '' &&
    sheet.image === null
  )
}

/** The local pass (`findOrganiseCandidates`) over the loaded project. */
export function organiseCandidates(project: OrganiseProject): OrganiseCandidates {
  const tags: CandidateTag[] = project.tags.map((tag) => ({
    id: tag.id,
    name: tag.name,
    aliases: tag.aliases,
    usageCount: tag.usageCount,
    mentions: project.mentions.get(tag.id) ?? 0,
    children: project.children.get(tag.id) ?? 0,
    sheets: project.sheetsOfTag.get(tag.id) ?? 0
  }))
  const sheets: CandidateSheet[] = project.sheets.map((sheet) => ({
    id: sheet.id,
    kind: sheet.kind,
    name: sheet.name,
    aliases: sheet.aliases,
    empty: isEmptySheet(sheet)
  }))
  return findOrganiseCandidates(tags, sheets)
}
