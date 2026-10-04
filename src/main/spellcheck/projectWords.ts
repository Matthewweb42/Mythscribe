import { spellcheckWords } from '@shared/dictionary'
import { storyNameWords } from '@shared/storyNames'
import { listEntities } from '../entity/entityStore'
import { getProjectDictionary } from '../project/settingsStore'
import { listTags } from '../tag/tagStore'
import type { TreeDb } from '../tree/treeStore'

/**
 * The words of the open project's story names (F-3.14): its entities' and its tags', as the
 * author spells them, read fresh on every call so a renamed or deleted name leaves no word
 * behind. Local string work: no AI, whatever the dial.
 */
export function projectNameWords(db: TreeDb): string[] {
  const names = [
    ...listEntities(db).map((entity) => entity.name),
    ...listTags(db).map((tag) => tag.name)
  ]
  return storyNameWords(names)
}

/**
 * What the spellchecker accepts while the project is open (F-3.14): its dictionary and the words
 * of its story names. One owner for the spellchecker's sync and for proofread's "keep as
 * written" list (F-14.12).
 */
export function projectSpellingWords(db: TreeDb): string[] {
  return spellcheckWords(getProjectDictionary(db), projectNameWords(db))
}
