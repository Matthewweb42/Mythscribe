import type { CSSProperties } from 'react'

/**
 * The book-like column (F-3.4): centered, full width up to `--ms-editor-max-width`, with side
 * padding so text never touches the pane edge. One owner for every editing surface (the single
 * document, the stacked regions and their headings and separators).
 */
export const COLUMN = 'mx-auto w-full max-w-(--ms-editor-max-width) px-6'

/**
 * Sets the column width on an editing pane. The value comes from the project's formatting
 * settings (F-3.6; format defaults until then), so it is truly dynamic and the one inline style
 * the editor uses. The cast is the only way to pass a custom property through React's `style`.
 */
export function columnStyle(maxWidth: number): CSSProperties {
  return { '--ms-editor-max-width': `${maxWidth}px` } as CSSProperties
}
