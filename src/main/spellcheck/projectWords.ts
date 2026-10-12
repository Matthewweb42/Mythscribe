import { eq } from 'drizzle-orm'
import { spellcheckWords } from '@shared/dictionary'
import { recordKindOf } from '@shared/memory/records'
import { isNamedKind } from '@shared/memory/topics'
import type { StoryMemoryVersion } from '@shared/storyMemory'
import { storyNameWords } from '@shared/storyNames'
import { alias, record } from '../db/schema'
import { listEntities } from '../entity/entityStore'
import { getProjectDictionary } from '../project/settingsStore'
import { listTags } from '../tag/tagStore'
import type { TreeDb } from '../tree/treeStore'

/**
 * The words of the open project's story names (F-3.14): in v1 its entities' and its tags', in v2
 * (F-16.4) its named records' names and nicknames (never a secret's or thread's label, P2b-D2),
 * as the author spells them, read fresh on every call so a renamed or deleted name leaves no word
 * behind. Local string work: no AI, whatever the dial.
 */
export function projectNameWords(db: TreeDb, memory: StoryMemoryVersion): string[] {
  if (memory === 'v2') {
    // P2b-D2: a secret's or thread's label is not a name the spellchecker should accept.
    return storyNameWords(
      db
        .select({ text: alias.text, categoryId: record.categoryId })
        .from(alias)
        .innerJoin(record, eq(record.id, alias.recordId))
        .all()
        .filter((row) => isNamedKind(recordKindOf(row.categoryId)))
        .map((row) => row.text)
    )
  }
  const names = [
    ...listEntities(db).flatMap((entity) => [entity.name, ...entity.aliases]),
    // F-4.14: an alias is a story name the author spells on purpose.
    ...listTags(db).flatMap((tag) => [tag.name, ...tag.aliases])
  ]
  return storyNameWords(names)
}

/**
 * What the spellchecker accepts while the project is open (F-3.14): its dictionary and the words
 * of its story names. One owner for the spellchecker's sync and for proofread's "keep as
 * written" list (F-14.12).
 */
export function projectSpellingWords(db: TreeDb, memory: StoryMemoryVersion): string[] {
  return spellcheckWords(getProjectDictionary(db), projectNameWords(db, memory))
}
