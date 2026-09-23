import { z } from 'zod'
import {
  ASSET_ID_CHARS,
  IMAGE_EXTENSIONS,
  IMAGE_MAX_BYTES,
  assetDisplayName,
  assetFileName,
  assetUrl,
  imageExtension,
  type ImageExtension
} from './assets'

/** Settings-table key under which the focus-mode settings (F-6.2 onwards) are stored as JSON. */
export const FOCUS_SETTINGS_KEY = 'focus'

export { ASSET_SCHEME } from './assets'
/** The folder under the project's `assets/` that holds the focus-mode backgrounds. */
export const BACKGROUNDS_DIR = 'backgrounds' as const

/** The image types a background may be (the project-wide `IMAGE_EXTENSIONS`, F-9.3 shares them). */
export const BACKGROUND_EXTENSIONS = IMAGE_EXTENSIONS
export type BackgroundExtension = ImageExtension
/** Largest file `background:add` copies; anything bigger is refused before it is read. */
export const BACKGROUND_MAX_BYTES = IMAGE_MAX_BYTES

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
export const backgroundExtension = imageExtension

/** The asset URL of a file in the backgrounds folder; `assetPathFor` in main is its inverse. */
export function backgroundUrl(fileName: string): string {
  return assetUrl(BACKGROUNDS_DIR, fileName)
}

/** Eight hex characters from a UUID: enough to keep two copies of one image apart. */
export const BACKGROUND_ID_CHARS = ASSET_ID_CHARS

/**
 * The stored file name for an imported background (`assetFileName` with `background` as the
 * fallback stem): the original stem, a short id, the extension. The id is what the settings row
 * and the URL carry.
 */
export function backgroundFileName(originalName: string, shortId: string): string {
  return assetFileName(originalName, shortId, 'background')
}

/** The name the author sees: the stored file name without its short id (`sunset.png`). */
export const backgroundDisplayName = assetDisplayName
