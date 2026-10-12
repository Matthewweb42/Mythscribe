import type { LabelKind } from '@shared/storyLabels'

/** Each kind's name, as the Labels dialog says it (F-16.7). */
export const LABEL_KIND_LABEL: Record<LabelKind, string> = {
  tone: 'Tone',
  content: 'Content',
  theme: 'Theme',
  custom: 'Custom'
}

/** What each kind does (custom labels never steer, decision P1-D6). */
export const LABEL_KIND_HINT: Record<LabelKind, string> = {
  tone: 'Filters, and asks the AI to write in this tone',
  content: 'Filters, and asks the AI to keep to it (a content warning)',
  theme: 'Filters, and asks the AI to keep the theme in view',
  custom: 'Filters only; never sent to the AI'
}
