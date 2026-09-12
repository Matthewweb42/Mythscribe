import { EMPTY_SCENE_META, type SceneMeta } from '@shared/sceneMeta'
import { ipc } from '@renderer/lib/ipc'
import { createAutosaveStore, type LoadedRecord } from './autosaveStore'

export { AUTOSAVE_DELAY_MS } from './autosaveStore'

/** One loaded scene metadata record (F-4.5). */
export type LoadedSceneMeta = LoadedRecord<SceneMeta>

/**
 * The one owner of the loaded scene metadata (F-4.5) and its autosave: a third autosave store,
 * over `sceneMeta:get` and `sceneMeta:set`, so the three fields of the metadata pane debounce
 * and flush like notes do (Ctrl+S, close, and quit go through the pending-save registry) and a
 * failure never blocks the document or the notes saving beside it. Loaded per node by the pane.
 */
const sceneMetaStore = createAutosaveStore({
  empty: EMPTY_SCENE_META,
  get: async (id) => (await ipc().invoke('sceneMeta:get', { id })).meta,
  save: (id, meta) => ipc().invoke('sceneMeta:set', { id, meta })
})

export const useSceneMetaStore = sceneMetaStore.useStore

/** Drops the pending jobs, timers, in-flight write, load tokens, and registration, then empties the store. For tests only. */
export const resetSceneMetaStore = sceneMetaStore.reset
