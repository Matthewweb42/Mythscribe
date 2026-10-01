import fs from 'node:fs'
import path from 'node:path'
import { REFERENCES_DIR, type ReferencePin } from '@shared/references'
import { getEntity } from '../entity/entityStore'
import { getNode, type TreeDb } from '../tree/treeStore'
import { addImageAsset, assetDir, removeImageAsset } from './imageAssets'

/**
 * The main side of the quick reference panel (F-9.6). The pins themselves are a `settings` row
 * (`settingsStore.ts`); this is what touches the things they point at: whether an entity, a
 * node, or an image file still exists, and the pinned image files in
 * `<Project>.mythscribe/assets/references/`, copied in and out through `imageAssets.ts` like the
 * backgrounds and the entity images.
 */
export function referencesDir(folder: string): string {
  return assetDir(folder, REFERENCES_DIR)
}

/** Whether the thing a pin points at still exists. */
function pinTargetExists(db: TreeDb, folder: string, pin: ReferencePin): boolean {
  switch (pin.type) {
    case 'entity':
      return getEntity(db, pin.id) !== undefined
    case 'note':
      return getNode(db, pin.id) !== undefined
    case 'image':
      return fs.existsSync(path.join(referencesDir(folder), pin.file))
  }
}

/**
 * The pins whose target still exists, in order: an entity or a node deleted since it was pinned,
 * or an image file removed from the folder by hand, takes its pin with it. Answers the same array
 * when nothing was dropped, so the caller can tell by identity whether to rewrite the row.
 */
export function pruneReferencePins(
  db: TreeDb,
  folder: string,
  pins: readonly ReferencePin[]
): readonly ReferencePin[] {
  const kept = pins.filter((pin) => pinTargetExists(db, folder, pin))
  return kept.length === pins.length ? pins : kept
}

/**
 * Copies `source` into `assets/references/` under a minted name and answers that name. The
 * refusals are `addImageAsset`'s: VALIDATION for a type or size it does not take, NOT_FOUND for
 * a missing source.
 */
export function addReferenceImage(folder: string, source: string): string {
  return addImageAsset(folder, REFERENCES_DIR, source, 'reference')
}

/** Deletes a pinned image's file; one that is already gone is not an error. */
export function removeReferenceImage(folder: string, fileName: string): void {
  removeImageAsset(folder, REFERENCES_DIR, fileName)
}
