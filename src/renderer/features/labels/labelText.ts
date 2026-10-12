import type { LabelKind } from '@shared/storyLabels'

/** Each kind's name, as the Labels dialog says it (F-16.7). */
export const LABEL_KIND_LABEL: Record<LabelKind, string> = {
  tone: 'Tone',
  content: 'Content',
  theme: 'Theme',
  custom: 'Custom'
}

/**
 * What each kind does (F-16.7, F-16.14): every label filters; tone, content and theme labels also
 * steer the AI's prose for the scenes that carry them (lines of the Story notes block). Custom
 * labels never leave the machine (decision P1-D6).
 */
export const LABEL_KIND_HINT: Record<LabelKind, string> = {
  tone: 'A tone: filters, and the AI writes in it',
  content: 'A content note: filters, and the AI keeps to it',
  theme: 'A theme: filters, and the AI keeps it in view',
  custom: 'Your own label: filters only; never sent to the AI'
}
