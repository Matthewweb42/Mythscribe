import { aliasKey } from '@shared/aliases'
import type { Tag } from '@shared/ipc/contract'
import {
  AUTO_TAG_BANK_CATEGORIES,
  AUTO_TAG_CATEGORIES,
  SUMMARY_BANK_TAGS_MAX,
  SUMMARY_NEW_TAGS_MAX,
  type ExtractedTag
} from '@shared/summary'
import { classifyTagTerm, mayAutoCreateTag } from '@shared/tagTerms'
import { toTagName, type TagCategory } from '@shared/tags'
import type { EntityWrite } from '../entity/entityStore'
import { ensureRecordForTag } from '../knowledge/records'
import { getDismissedNames } from '../project/settingsStore'
import { aiLinkedTagIds, replaceAutoTags } from '../tag/documentTagStore'
import { manuscriptTexts } from '../tag/proposedTags'
import { createTag, getTagWithUsage, listTags } from '../tag/tagStore'
import type { TreeDb } from '../tree/treeStore'
import { sceneNamesTag } from './observedFacts'
import type { SummaryBankTags } from './prompts/summary.v3'

/**
 * Background AI tagging's write side (F-4.13): which bank names the summary request lists, and
 * how the tags the model answered become links. Auto-applied tags are derived data like the
 * summary itself (author-control rule 1): stored as `ai` links apart from the author's own,
 * removable in one click, never re-applied to a scene the author took them off, and nothing
 * enters the manuscript. Everything here is local; the one request is the summary's own
 * (`summarize.ts`).
 */

const CREATABLE: readonly TagCategory[] = AUTO_TAG_CATEGORIES
/** The categories whose new tag must be a name the scene holds; a character's a proper noun. */
const NAME_CATEGORIES: readonly TagCategory[] = ['character', 'setting', 'worldBuilding']

/**
 * The bank's tone, content, plot-thread, and custom names for the prompt, most used first (ties
 * by name) and capped at `SUMMARY_BANK_TAGS_MAX` in category order. Deliberately outside the
 * summary's content hash, like the scene brief: a tone tag added for one scene must not mark
 * every other scene out of date.
 */
export function bankTagNames(db: TreeDb): SummaryBankTags {
  const bank: SummaryBankTags = { tone: [], content: [], plotThread: [], custom: [] }
  const tags = listTags(db).sort(
    (a, b) => b.usageCount - a.usageCount || a.name.localeCompare(b.name)
  )
  let room = SUMMARY_BANK_TAGS_MAX
  for (const category of AUTO_TAG_BANK_CATEGORIES) {
    const names = tags.filter((tag) => tag.category === category).map((tag) => tag.name)
    bank[category] = names.slice(0, room)
    room -= bank[category].length
  }
  return bank
}

/** What a run did to the tags: who to tell, and about what. */
export interface AutoTagsChange {
  /** The tags the job added to the bank, each as it stands after the links. */
  created: Tag[]
  /** Every tag whose link to the scene was added or dropped, the created ones included, with its usage count after. */
  moved: Tag[]
  /** F-9.12: the records (AI-made sheets) the created name tags got, in the same transaction. */
  records: EntityWrite[]
  /** F-9.13: the tags newly put on the scene by this run (the Changes log lists them). */
  linked: Tag[]
}

/**
 * Applies what the model answered for one scene (F-4.13), in one transaction (a savepoint
 * inside the caller's): a name the bank has is linked whatever category the model gave it; a
 * missing one is created as AI-made in the answered category — only in a category the job may
 * add to, at most `SUMMARY_NEW_TAGS_MAX` per run, never a name the author dismissed or deleted
 * (`DISMISSED_NAMES_KEY`), and a character, place, or in-world term only when `sceneText` (the
 * scene as sent) names it. The author's tag rule (2026-10-08, `classifyTagTerm`) comes on top
 * for every category: a new tag must be a name the manuscript always capitalises or a phrase it
 * keeps repeating; an ordinary word ("custom", "trial") is never created, and one the text
 * capitalises often ("the Trial") is left to the proposals (F-4.12b). Then the scene's job links are replaced (`replaceAutoTags`: the
 * author's links and removals win). An empty list clears the job's links and creates nothing.
 */
export function applyAutoTags(
  db: TreeDb,
  nodeId: string,
  tags: readonly ExtractedTag[],
  sceneText: string
): AutoTagsChange {
  return db.transaction((tx) => {
    // F-4.14: an alias the model answered ("Rynna") links its tag, never makes a second one.
    const byName = new Map(
      listTags(tx).flatMap((tag) => [
        ...tag.aliases.map((alias): [string, string] => [aliasKey(alias), tag.id]),
        [tag.name, tag.id] as [string, string]
      ])
    )
    const dismissed = new Set(getDismissedNames(tx).names)
    // Read once, and only when a name is missing from the bank: the rule needs the whole text.
    let texts: string[] | null = null
    const isNameOrTerm = (name: string): boolean => {
      texts ??= manuscriptTexts(tx, { nodeId, text: sceneText })
      return mayAutoCreateTag(classifyTagTerm(name, texts))
    }
    const createdIds: string[] = []
    const records: EntityWrite[] = []
    const wanted: string[] = []
    for (const answered of tags) {
      const name = toTagName(answered.name)
      if (name.length === 0) continue
      const known = byName.get(name)
      if (known !== undefined) {
        wanted.push(known)
        continue
      }
      if (
        createdIds.length === SUMMARY_NEW_TAGS_MAX ||
        !CREATABLE.includes(answered.category) ||
        dismissed.has(name) ||
        (NAME_CATEGORIES.includes(answered.category) &&
          !sceneNamesTag(sceneText, name, answered.category === 'character')) ||
        !isNameOrTerm(name)
      ) {
        continue
      }
      const made = createTag(tx, { name, category: answered.category }, 'ai')
      // F-9.12 (D8): a new name has its record from the start, marked as AI-made. Not a plot
      // thread (F-9.14): the reading's thread events make thread records, under one cap
      // (`SUMMARY_NEW_THREADS_MAX`); the tag stays a label until one names it.
      const record = answered.category === 'plotThread' ? null : ensureRecordForTag(tx, made, 'ai')
      if (record !== null) records.push(record)
      byName.set(name, made.id)
      createdIds.push(made.id)
      wanted.push(made.id)
    }
    const before = new Set(aiLinkedTagIds(tx, nodeId))
    const movedIds = new Set([...replaceAutoTags(tx, nodeId, wanted), ...createdIds])
    const after = aiLinkedTagIds(tx, nodeId).filter((id) => !before.has(id))
    const read = (ids: Iterable<string>): Tag[] =>
      [...ids].flatMap((id) => {
        const tag = getTagWithUsage(tx, id)
        return tag ? [tag] : []
      })
    return { created: read(createdIds), moved: read(movedIds), records, linked: read(after) }
  })
}
