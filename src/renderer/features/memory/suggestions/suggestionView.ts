import type { SuggestionView } from '@shared/memory/views'
import type { ReviewDeckGroup } from '@renderer/features/review/reviewDeckModel'

/**
 * The words of story memory's suggestions (F-16.17, plan `Suggestions.md`): pure, so the panel,
 * the side-work review and the rebuild's review say them the same way.
 */

/** "Mara · Eyes: grey" with who says it when that is not the narration ("Orrin says"). */
export function suggestionText(suggestion: Pick<SuggestionView, 'name' | 'line' | 'note'>): string {
  const who = suggestion.name === '' ? '' : `${suggestion.name} · `
  return `${who}${suggestion.line}${suggestion.note === null ? '' : ` (${suggestion.note})`}`
}

/** How the line was proved, as the review card says it. */
export function proofText(proof: SuggestionView['proof']): string {
  return proof === 'literal' ? 'Stated word for word' : 'Read by the AI and checked'
}

/** The status bar's item: "1 suggestion", "4 suggestions". */
export function suggestionCountText(count: number): string {
  return `${count} suggestion${count === 1 ? '' : 's'}`
}

/** The review's groups: one per record, in the order the suggestions first name them. */
export function suggestionGroups(suggestions: readonly SuggestionView[]): ReviewDeckGroup[] {
  const seen = new Map<string, ReviewDeckGroup>()
  for (const suggestion of suggestions) {
    const id = suggestion.recordId ?? ''
    if (!seen.has(id)) {
      seen.set(id, {
        id,
        label: suggestion.name === '' ? 'Unnamed' : suggestion.name,
        noun: 'Suggestion'
      })
    }
  }
  return [...seen.values()]
}

/** The group accept's words: "Accept all for Mara (3)". */
export const acceptAllLabel = (count: number, group: ReviewDeckGroup): string =>
  `Accept all for ${group.label} (${count})`

/** The Apply button's words for what the deck decided. */
export function applyText(accepted: number, dismissed: number): string {
  const parts = [
    ...(accepted > 0 ? [`accept ${accepted}`] : []),
    ...(dismissed > 0 ? [`dismiss ${dismissed}`] : [])
  ]
  return parts.length === 0 ? 'Apply' : `Apply: ${parts.join(', ')}`
}
