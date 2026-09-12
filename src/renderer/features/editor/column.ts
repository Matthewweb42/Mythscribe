import type { CSSProperties } from 'react'
import type { EditorSettings } from '@shared/editorSettings'

/**
 * The book-like column (F-3.4): centered, full width up to `--ms-editor-max-width`, with side
 * padding so text never touches the pane edge. One owner for every editing surface (the single
 * document, the stacked regions and their headings and separators).
 */
export const COLUMN = 'mx-auto w-full max-w-(--ms-editor-max-width) px-6'

/**
 * Turns the project's formatting settings (F-3.6) into the custom properties an editing pane
 * sets: the column width (F-3.4), font size, line height, paragraph spacing, and first-line
 * indent. `app.css` reads them on `.ms-editor`, so a change restyles the text in place with no
 * remount. The values are truly dynamic, so this is the one inline style the editor uses; the
 * cast is the only way to pass a custom property through React's `style`.
 */
export function editorStyle(settings: EditorSettings): CSSProperties {
  return {
    '--ms-editor-max-width': `${settings.maxWidth}px`,
    '--ms-editor-font-size': `${settings.fontSize}px`,
    '--ms-editor-line-height': `${settings.lineHeight}`,
    '--ms-editor-paragraph-spacing': `${settings.paragraphSpacing}em`,
    '--ms-editor-paragraph-indent': `${settings.paragraphIndent}em`
  } as CSSProperties
}
