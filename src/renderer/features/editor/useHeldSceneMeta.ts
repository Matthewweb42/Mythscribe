import { useEffect } from 'react'
import { useSceneMetaStore } from './sceneMetaStore'

/**
 * Holds the scene metadata of every node in `ids` while the calling view is on screen: one
 * holder-counted `load` per id on mount (so the metadata pane, outline rows, and cards can hold
 * the same ids) and the matching `unload` on unmount or when `ids` changes. Pass a memoised
 * array. Shared by the beat board (F-11.1b) and the timeline tab (F-11.2); read the records from
 * `useSceneMetaStore((s) => s.docs)`.
 */
export function useHeldSceneMeta(ids: readonly string[]): void {
  const load = useSceneMetaStore((s) => s.load)
  const unload = useSceneMetaStore((s) => s.unload)
  useEffect(() => {
    for (const id of ids) void load(id)
    return () => {
      for (const id of ids) unload(id)
    }
  }, [ids, load, unload])
}
