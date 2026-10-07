/**
 * Project image assets (F-6.2 backgrounds, F-9.3 entity images, F-9.6 pinned reference images,
 * the Book details cover image of Compile v2):
 * the files under the project's
 * `assets/<dir>/`, served to the renderer on one custom scheme. One owner for the scheme, the
 * folders it serves, the accepted image types and size, and the stored file naming, so the
 * backgrounds, the entity images, and the pinned images never drift apart.
 */

/** The custom scheme main serves project assets on (`mythscribe-asset://<dir>/<file>`). */
export const ASSET_SCHEME = 'mythscribe-asset'

/** The folders under the project's `assets/` the scheme serves; anything else is a 404. */
export const ASSET_DIRS = ['backgrounds', 'entities', 'references', 'covers'] as const
export type AssetDir = (typeof ASSET_DIRS)[number]

/** The image types an asset may be, matched against the file extension (any case). */
export const IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'webp', 'gif'] as const
export type ImageExtension = (typeof IMAGE_EXTENSIONS)[number]
/** Largest image copied into the project; anything bigger is refused before it is read. */
export const IMAGE_MAX_BYTES = 20 * 1024 * 1024

/** Whether `dir` is one of the served asset folders. */
export function isAssetDir(dir: string): dir is AssetDir {
  return (ASSET_DIRS as readonly string[]).includes(dir)
}

/** The lower-cased extension of a file name when it is one of `IMAGE_EXTENSIONS`, else null. */
export function imageExtension(fileName: string): ImageExtension | null {
  const dot = fileName.lastIndexOf('.')
  if (dot <= 0) return null
  const ext = fileName.slice(dot + 1).toLowerCase()
  return (IMAGE_EXTENSIONS as readonly string[]).includes(ext) ? (ext as ImageExtension) : null
}

/** The asset URL of a file in one of the served folders; `assetPathFor` in main is its inverse. */
export function assetUrl(dir: AssetDir, fileName: string): string {
  return `${ASSET_SCHEME}://${dir}/${encodeURIComponent(fileName)}`
}

/** Eight hex characters from a UUID: enough to keep two copies of one image apart. */
export const ASSET_ID_CHARS = 8
const STEM_MAX = 40

/**
 * The stored file name for an imported image: the original stem, reduced to letters, digits,
 * `_` and `-` (spaces become `-`) and capped, then a short id, then the extension, so the
 * author still recognises `sunset-over-harbor.png` where the name is shown. `fallbackStem`
 * stands in when nothing of the stem survives. `ext` defaults to the image extension of the name
 * (`png` for none); the context library (F-9.8) passes the document's own.
 */
export function assetFileName(
  originalName: string,
  shortId: string,
  fallbackStem: string,
  ext: string = imageExtension(originalName) ?? 'png'
): string {
  const dot = originalName.lastIndexOf('.')
  const rawStem = dot > 0 ? originalName.slice(0, dot) : ''
  const stem =
    rawStem
      .replace(/\s+/g, '-')
      .replace(/[^A-Za-z0-9_-]/g, '')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, STEM_MAX) || fallbackStem
  return `${stem}.${shortId}.${ext}`
}

/** The name the author sees: the stored file name without its short id (`sunset.png`). */
export function assetDisplayName(fileName: string): string {
  const match = /^(.+)\.([0-9a-f]{8})\.([A-Za-z0-9]+)$/.exec(fileName)
  return match ? `${match[1]}.${match[3]}` : fileName
}
