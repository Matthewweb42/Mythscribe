import type { CSSProperties } from 'react'
import type { EditorSettings } from '@shared/editorSettings'
import { DEFAULT_ZOOM } from '@shared/zoom'

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
 *
 * `zoom` is the app-wide document zoom (F-7.10): the column width and the font size multiply by
 * it together, so the page grows as a page. The line height is unitless and the two spacings are
 * em, so they follow the font on their own. It defaults to 100 % for the surfaces that are
 * chrome rather than manuscript (the Settings preview), which never zoom.
 */
export function editorStyle(settings: EditorSettings, zoom: number = DEFAULT_ZOOM): CSSProperties {
  return {
    '--ms-editor-max-width': `${settings.maxWidth * zoom}px`,
    '--ms-editor-font-size': `${settings.fontSize * zoom}px`,
    '--ms-editor-line-height': `${settings.lineHeight}`,
    '--ms-editor-paragraph-spacing': `${settings.paragraphSpacing}em`,
    '--ms-editor-paragraph-indent': `${settings.paragraphIndent}em`
  } as CSSProperties
}
