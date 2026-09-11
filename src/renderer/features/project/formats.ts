import type { NovelFormat } from '@shared/ipc/contract'
import { formatLabel, skeletonSummary } from '@shared/labels'

export interface ProjectFormatOption {
  id: NovelFormat
  label: string
  summary: string
  structure: string
}

/** The formats offered by the create-project wizard (F-1.2), in display order. */
export const PROJECT_FORMATS: readonly ProjectFormatOption[] = [
  {
    id: 'novel',
    label: formatLabel('novel'),
    summary: 'One standalone book.',
    structure: `${skeletonSummary('novel')}. Manuscript formatting: double-spaced, indented paragraphs, * * * scene breaks.`
  },
  {
    id: 'epic',
    label: formatLabel('epic'),
    summary: 'A multi-book series in one project.',
    structure: `${skeletonSummary('epic')}. Manuscript formatting, same as Novel.`
  },
  {
    id: 'webnovel',
    label: formatLabel('webnovel'),
    summary: 'Serialized fiction posted chapter by chapter.',
    structure: `${skeletonSummary('webnovel')}. Web formatting: no indent, a blank line between paragraphs, ~~~ scene breaks.`
  }
]
