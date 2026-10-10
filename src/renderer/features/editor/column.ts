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
 * Page edges (F-7.11): the column drawn as a sheet (`.ms-sheet` in `app.css`: the lighter
 * surface, a hairline, a soft shadow). The column's `px-6` becomes the sheet's margins, so the
 * text stays exactly where it is when the edges are turned off.
 */
export const SHEET = 'ms-sheet'

/** The classes an editing column takes: the bare column, or the column as a sheet. */
export function columnClass(sheet: boolean): string {
  return sheet ? `${COLUMN} ${SHEET}` : COLUMN
}

/**
 * The classes of the pane the column scrolls in: with the sheet on, the desk shows around it, a
 * gap on every side so the edge is visible even where the text is at the top. The side gap is
 * the smaller: it comes out of the pane's width, which a narrow window has little of.
 */
export function deskClass(sheet: boolean): string {
  return sheet ? 'bg-page px-4 py-6' : ''
}

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
