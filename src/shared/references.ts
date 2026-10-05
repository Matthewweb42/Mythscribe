import { z } from 'zod'
import { assetUrl } from './assets'
import { moveItem } from './listMove'

/**
 * The quick reference panel (F-9.6): what the author pinned beside the page, as one ordered list
 * per project. A pin is a pointer, never a copy: an entity by id, a node's notes (F-3.7) by node
 * id, or an image file in the project's `assets/references/`. The list is stored in the project
 * `settings` row under `REFERENCE_PINS_KEY`; one owner for the shape, the cap, and the list
 * arithmetic, so main and the renderer never disagree on what a duplicate or a move is.
 */

/** The `settings` row key the pins live under. */
export const REFERENCE_PINS_KEY = 'references'

/** Most pins a project keeps: a side panel is for the handful in use, not a second bible. */
export const REFERENCE_PINS_MAX = 50

/** The folder under the project's `assets/` that holds the pinned images. */
export const REFERENCES_DIR = 'references' as const

/** The asset URL the renderer loads a pinned image from. */
export function referenceImageUrl(fileName: string): string {
  return assetUrl(REFERENCES_DIR, fileName)
}

/** A stored image name is one plain path segment: it can never point outside `assets/references/`. */
const isPlainFileName = (file: string): boolean =>
  file !== '.' &&
  file !== '..' &&
  !file.includes('/') &&
  !file.includes('\\') &&
  !file.includes('\0')

export const ReferencePin = z.discriminatedUnion('type', [
  /** An entity of the story bible (F-9.1), by id. */
  z.object({ type: z.literal('entity'), id: z.string().min(1) }),
  /** The notes of a tree node (F-3.7), by node id. */
  z.object({ type: z.literal('note'), id: z.string().min(1) }),
  /** An image file in `assets/references/`; the pin is the only record of it. */
  z.object({ type: z.literal('image'), file: z.string().min(1).refine(isPlainFileName) })
])
export type ReferencePin = z.infer<typeof ReferencePin>
export type ReferencePinType = ReferencePin['type']

export const ReferencePins = z.object({
  pins: z.array(ReferencePin).max(REFERENCE_PINS_MAX)
})
export type ReferencePins = z.infer<typeof ReferencePins>

/** The empty list a project without a stored row (or with an unreadable one) starts from. */
export function defaultReferencePins(): ReferencePins {
  return { pins: [] }
}

/** What makes two pins the same pin: `entity:<id>`, `note:<id>`, `image:<file>`. */
export function pinKey(pin: ReferencePin): string {
  return pin.type === 'image' ? `image:${pin.file}` : `${pin.type}:${pin.id}`
}

/** Whether `pin` is already in the list. */
export function hasPin(pins: readonly ReferencePin[], pin: ReferencePin): boolean {
  const key = pinKey(pin)
  return pins.some((other) => pinKey(other) === key)
}

/**
 * The list with `pin` appended. A pin already in it, or a list already at `REFERENCE_PINS_MAX`,
 * answers the same array, so a caller can tell "nothing changed" by identity.
 */
export function addPin(pins: readonly ReferencePin[], pin: ReferencePin): readonly ReferencePin[] {
  if (hasPin(pins, pin) || pins.length >= REFERENCE_PINS_MAX) return pins
  return [...pins, pin]
}

/** The list without `pin`; the same array when it was not in it. */
export function removePin(
  pins: readonly ReferencePin[],
  pin: ReferencePin
): readonly ReferencePin[] {
  if (!hasPin(pins, pin)) return pins
  const key = pinKey(pin)
  return pins.filter((other) => pinKey(other) !== key)
}

/**
 * The list with the pin at `from` moved to position `to` (clamped into the list). The same array
 * when `from` is not a position in it or the pin would land where it already is.
 */
export function movePin(
  pins: readonly ReferencePin[],
  from: number,
  to: number
): readonly ReferencePin[] {
  return moveItem(pins, from, to)
}

/** The list with every later copy of a pin dropped; the first one keeps its place. */
export function dedupePins(pins: readonly ReferencePin[]): ReferencePin[] {
  const seen = new Set<string>()
  const result: ReferencePin[] = []
  for (const pin of pins) {
    const key = pinKey(pin)
    if (seen.has(key)) continue
    seen.add(key)
    result.push(pin)
  }
  return result
}
