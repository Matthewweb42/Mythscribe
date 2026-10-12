import type { LabelKind } from '@shared/storyLabels'

/** Each kind's name, as the Labels dialog says it (F-16.7). */
export const LABEL_KIND_LABEL: Record<LabelKind, string> = {
  tone: 'Tone',
  content: 'Content',
  theme: 'Theme',
  custom: 'Custom'
}

/**
 * What each kind does today. Every label only filters until the prompts read them (P1 slice 5's
 * Story notes block and its data-sharing rows); that change rewords these in the same commit.
 * Custom labels will never steer (decision P1-D6).
 */
export const LABEL_KIND_HINT: Record<LabelKind, string> = {
  tone: 'A tone, to filter by',
  content: 'A content note, to filter by',
  theme: 'A theme, to filter by',
  custom: 'Your own label, to filter by'
}
