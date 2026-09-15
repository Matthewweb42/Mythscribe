import { z } from 'zod'

/** Settings-table key under which the focus-mode settings (F-6.2 onwards) are stored as JSON. */
export const FOCUS_SETTINGS_KEY = 'focus'

/** The custom scheme main serves project assets on (`mythscribe-asset://backgrounds/<file>`). */
export const ASSET_SCHEME = 'mythscribe-asset'
/** The folder under the project's `assets/` that holds the focus-mode backgrounds. */
export const BACKGROUNDS_DIR = 'backgrounds'

/** The image types a background may be, matched against the file extension (any case). */
export const BACKGROUND_EXTENSIONS = ['png', 'jpg', 'jpeg', 'webp', 'gif'] as const
export type BackgroundExtension = (typeof BACKGROUND_EXTENSIONS)[number]
/** Largest file `background:add` copies; anything bigger is refused before it is read. */
export const BACKGROUND_MAX_BYTES = 20 * 1024 * 1024

/**
 * Focus-mode settings (F-6.2), persisted per project: the id of the current background or null
 * for none. Later fields (F-6.3 rotation, F-6.4 overlay) join with `.default` so a row written
 * before them keeps parsing.
 */
export const ROTATION_MINUTES = { min: 1, max: 60, default: 5 } as const
export const OVERLAY_DARKNESS = { min: 0, max: 100, default: 60 } as const
export const OVERLAY_WIDTH = { min: 35, max: 100, default: 70 } as const

/** F-6.3: cycle through the uploaded backgrounds every `intervalMinutes` while in focus mode. */
export const FocusRotation = z.object({
  enabled: z.boolean().default(false),
  intervalMinutes: z
    .number()
    .int()
    .min(ROTATION_MINUTES.min)
    .max(ROTATION_MINUTES.max)
    .default(ROTATION_MINUTES.default)
})
export type FocusRotation = z.infer<typeof FocusRotation>

/** F-6.4: the writing area over the background: scrim darkness in percent and column width in percent of the pane. */
export const FocusOverlay = z.object({
  darkness: z
    .number()
    .int()
    .min(OVERLAY_DARKNESS.min)
    .max(OVERLAY_DARKNESS.max)
    .default(OVERLAY_DARKNESS.default),
  width: z
    .number()
    .int()
    .min(OVERLAY_WIDTH.min)
    .max(OVERLAY_WIDTH.max)
    .default(OVERLAY_WIDTH.default)
})
export type FocusOverlay = z.infer<typeof FocusOverlay>

export const FocusSettings = z.object({
  backgroundId: z.string().nullable().default(null),
  // zod 4: `.default` takes the output shape, so the full defaults are spelled out.
  rotation: FocusRotation.default({ enabled: false, intervalMinutes: ROTATION_MINUTES.default }),
  overlay: FocusOverlay.default({
    darkness: OVERLAY_DARKNESS.default,
    width: OVERLAY_WIDTH.default
  })
})
export type FocusSettings = z.infer<typeof FocusSettings>
export type FocusSettingsInput = z.input<typeof FocusSettings>

export function defaultFocusSettings(): FocusSettings {
  return {
    backgroundId: null,
    rotation: { enabled: false, intervalMinutes: ROTATION_MINUTES.default },
    overlay: { darkness: OVERLAY_DARKNESS.default, width: OVERLAY_WIDTH.default }
  }
}

/** Clamps a number into a `{ min, max }` range, rounding to an integer; NaN becomes `min`. */
export function clampInt(value: number, range: { min: number; max: number }): number {
  if (!Number.isFinite(value)) return range.min
  return Math.min(range.max, Math.max(range.min, Math.round(value)))
}

/**
 * One uploaded background (F-6.2): the minted id, the file name shown as its name (the list
 * reads the folder, nothing else is stored), and the URL the renderer loads it from.
 */
export const Background = z.object({ id: z.string(), name: z.string(), url: z.string() })
export type Background = z.infer<typeof Background>

/** The lower-cased extension of a file name when it is one of `BACKGROUND_EXTENSIONS`, else null. */
export function backgroundExtension(fileName: string): BackgroundExtension | null {
  const dot = fileName.lastIndexOf('.')
  if (dot <= 0) return null
  const ext = fileName.slice(dot + 1).toLowerCase()
  return (BACKGROUND_EXTENSIONS as readonly string[]).includes(ext)
    ? (ext as BackgroundExtension)
    : null
}

/** The asset URL of a file in the backgrounds folder; `assetPathFor` in main is its inverse. */
export function backgroundUrl(fileName: string): string {
  return `${ASSET_SCHEME}://${BACKGROUNDS_DIR}/${encodeURIComponent(fileName)}`
}

/** Eight hex characters from a UUID: enough to keep two copies of one image apart. */
export const BACKGROUND_ID_CHARS = 8
const STEM_MAX = 40

/**
 * The stored file name for an imported image: the original stem, reduced to letters, digits,
 * `_` and `-` (spaces become `-`) and capped, then a short id, then the extension, so the
 * author still recognises `sunset-over-harbor.png` in the manager. The id is what the
 * settings row and the URL carry.
 */
export function backgroundFileName(originalName: string, shortId: string): string {
  const ext = backgroundExtension(originalName) ?? 'png'
  const dot = originalName.lastIndexOf('.')
  const rawStem = dot > 0 ? originalName.slice(0, dot) : ''
  const stem =
    rawStem
      .replace(/\s+/g, '-')
      .replace(/[^A-Za-z0-9_-]/g, '')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, STEM_MAX) || 'background'
  return `${stem}.${shortId}.${ext}`
}

/** The name the author sees: the stored file name without its short id (`sunset.png`). */
export function backgroundDisplayName(fileName: string): string {
  const match = /^(.+)\.([0-9a-f]{8})\.([A-Za-z0-9]+)$/.exec(fileName)
  return match ? `${match[1]}.${match[3]}` : fileName
}
