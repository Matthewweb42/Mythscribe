import type { LooseEnd } from '@shared/memory/views'

/**
 * Loose ends' words (F-16.29; design §2.7, P4 rule 5): the scoped lines are composed here only,
 * from where main says each was last touched and how far the book was checked; nothing here
 * reaches a request (*Ask Ms Scribe* sends the loose end's own `ask`, worded positively).
 */

/**
 * "Ashby's return: last moved in 7.3, nothing since (checked up to 18.2)", "Orrin: last named in
 * 6.2", "Planned “Mara learns about the map” sits before 14.2 and is not drafted".
 */
export function looseEndLine(end: LooseEnd): string {
  switch (end.kind) {
    case 'thread':
      return `${end.name}: last moved in ${end.lastRef ?? '?'}, nothing since (checked up to ${end.horizonRef})`
    case 'character':
      return `${end.name}: last named in ${end.lastRef ?? '?'}`
    case 'planned':
      return `Planned “${end.name}” sits before ${end.horizonRef} and is not drafted`
  }
}

/** The row's key (a later touch is a new loose end). */
export const looseEndKey = (end: LooseEnd): string =>
  `${end.kind}|${end.id}|${end.lastNodeId ?? ''}`

/** "+ 3 more" under the list. */
export const looseEndsMore = (more: number): string | null => (more > 0 ? `+ ${more} more` : null)
