import { useEffect } from 'react'
import { emptySceneDetails, type SceneDetails } from '@shared/memory/sceneDetails'
import { useRecordStore } from '@renderer/features/records/recordStore'
import { toast } from '@renderer/features/shell/dialogs/dialogStore'
import { describeError } from '@renderer/lib/errors'
import { useSceneDetailStore } from './sceneDetailStore'

/** What the typed details of one scene hold and how to change them: the one save rule. */
export interface SceneDetailsEditor {
  id: string
  /** The details as the store holds them (empty while they load). */
  details: SceneDetails
  /** True until the scene's details have loaded. */
  disabled: boolean
  /**
   * Saves a change over the details as the store holds them at that moment (a picker answers
   * later), through the scene detail store; a refusal toasts.
   */
  save: (patch: Partial<SceneDetails> | ((current: SceneDetails) => Partial<SceneDetails>)) => void
  /** The creation dialog for `categoryId`; the record made (or picked as the same) is chosen. */
  createFor: (categoryId: string, choose: (recordId: string) => void) => void
}

/**
 * Loads scene `id`'s typed details and answers them with the one way to change them (F-16.11),
 * shared by the scene details and the This scene panel's *Here* (F-16.12).
 */
export function useSceneDetailsEditor(id: string): SceneDetailsEditor {
  const view = useSceneDetailStore((s) => s.docs[id])

  useEffect(() => {
    useSceneDetailStore
      .getState()
      .load(id)
      .catch((err: unknown) => toast.error(describeError(err)))
  }, [id])

  const save: SceneDetailsEditor['save'] = (patch) => {
    const now = useSceneDetailStore.getState().docs[id]
    if (now === undefined) return
    const current: SceneDetails = {
      povRecordId: now.povRecordId,
      place: now.place,
      time: now.time,
      storyYear: now.storyYear,
      alsoHere: now.alsoHere
    }
    const change = typeof patch === 'function' ? patch(current) : patch
    useSceneDetailStore
      .getState()
      .save(id, { ...current, ...change })
      .catch((err: unknown) => toast.error(describeError(err)))
  }
  return {
    id,
    details: view ?? emptySceneDetails(),
    disabled: view === undefined,
    save,
    createFor: (categoryId, choose) => useRecordStore.getState().startCreate(categoryId, choose)
  }
}
