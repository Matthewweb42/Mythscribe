import { BOOK_LIST_MAX, BookDetails } from '@shared/bookDetails'

/**
 * The Book details page's working copy (Compile v2, CV3): the details with the also-by list and
 * the keywords as the text the author types, and the checks Save runs.
 */

/** The details being edited, with the two lists as the text the author types. */
export interface BookDraft {
  details: BookDetails
  alsoBy: string
  keywords: string
}

export const toDraft = (details: BookDetails): BookDraft => ({
  details,
  alsoBy: details.alsoBy.join('\n'),
  keywords: details.keywords.join(', ')
})

/** The draft as `BookDetails`: the also-by list one title a line, keywords split on commas. */
export function draftDetails(draft: BookDraft): BookDetails {
  return {
    ...draft.details,
    alsoBy: draft.alsoBy
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== ''),
    keywords: draft.keywords
      .split(',')
      .map((word) => word.trim())
      .filter((word) => word !== '')
  }
}

/** Why the details cannot be saved, or null. */
export function detailsProblem(details: BookDetails): string | null {
  const parsed = BookDetails.safeParse(details)
  if (parsed.success) return null
  const issue = parsed.error.issues[0]
  if (issue?.path[0] === 'language') return 'Language: a code like en, en-GB, or fr'
  if (issue?.path[0] === 'alsoBy' || issue?.path[0] === 'keywords')
    return `${issue.path[0] === 'alsoBy' ? 'Also by' : 'Keywords'}: at most ${BOOK_LIST_MAX}, each short`
  return issue?.message ?? 'A field is not valid'
}
