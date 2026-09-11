import type { NovelFormat } from '@shared/ipc/contract'

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
    label: 'Novel',
    summary: 'One standalone book.',
    structure:
      'Manuscript → Part 1–2 → Chapter 1–3 → Scene 1. Manuscript formatting: double-spaced, indented paragraphs, * * * scene breaks.'
  },
  {
    id: 'epic',
    label: 'Epic',
    summary: 'A multi-book series in one project.',
    structure: 'Series → Part 1–2 → Chapter 1–3 → Scene 1. Manuscript formatting, same as Novel.'
  },
  {
    id: 'webnovel',
    label: 'Web novel',
    summary: 'Serialized fiction posted chapter by chapter.',
    structure:
      'Volume 1 → Arc 1–2 → Chapter 1–3 → Scene 1. Web formatting: no indent, a blank line between paragraphs, ~~~ scene breaks.'
  }
]
