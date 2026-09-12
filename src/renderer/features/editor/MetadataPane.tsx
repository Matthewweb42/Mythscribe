import { useEffect, useId } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { EMPTY_SCENE_META, type SceneMeta } from '@shared/sceneMeta'
import type { TagCategory } from '@shared/tags'
import { toast } from '@renderer/features/shell/dialogs/dialogStore'
import { useTagStore } from '@renderer/features/tags/tagStore'
import { describeError } from '@renderer/lib/errors'
import { useSceneMetaStore } from './sceneMetaStore'
import { SuggestInput } from './SuggestInput'

/** The names of the bank's tags in `category`, in bank order, for the autocomplete. */
function useTagNames(category: TagCategory): string[] {
  return useTagStore(
    useShallow((s) =>
      s.ids.flatMap((id) => {
        const tag = s.byId[id]
        return tag?.category === category ? [tag.name] : []
      })
    )
  )
}

/**
 * The metadata pane of the tag bar (F-4.5) for a scene, chapter, or part: Location (autocomplete
 * from the setting tags), POV (from the character tags), and the timeline position (free text
 * until F-11.2). Takes only `id`: it loads the node's metadata through `useSceneMetaStore` on
 * mount (and again when `id` changes) and unloads on unmount; every change goes through the
 * store's `edit`, so it debounces and flushes like notes do (Ctrl+S, close, quit). The fields
 * are disabled until the load resolves.
 */
export function MetadataPane({ id }: { id: string }): React.JSX.Element {
  const meta = useSceneMetaStore((s) => s.docs[id]?.content ?? null)
  const load = useSceneMetaStore((s) => s.load)
  const unload = useSceneMetaStore((s) => s.unload)
  const edit = useSceneMetaStore((s) => s.edit)
  const settings = useTagNames('setting')
  const characters = useTagNames('character')
  const timelineId = useId()

  useEffect(() => {
    load(id).catch((err: unknown) => toast.error(describeError(err)))
    return () => unload(id)
  }, [id, load, unload])

  const value = meta ?? EMPTY_SCENE_META
  const disabled = meta === null
  const set = (patch: Partial<SceneMeta>): void => {
    if (meta !== null) edit(id, { ...meta, ...patch })
  }

  return (
    <div role="group" aria-label="Scene metadata" className="flex min-w-0 flex-col gap-1">
      <SuggestInput
        label="Location"
        value={value.location}
        onChange={(location) => set({ location })}
        options={settings}
        placeholder="e.g. dark-forest"
        disabled={disabled}
      />
      <SuggestInput
        label="POV"
        value={value.pov}
        onChange={(pov) => set({ pov })}
        options={characters}
        placeholder="Whose eyes"
        disabled={disabled}
      />
      <div className="flex items-center gap-2">
        <label htmlFor={timelineId} className="w-16 shrink-0 text-xs text-fg-muted">
          Timeline
        </label>
        <input
          id={timelineId}
          type="text"
          value={value.timeline}
          placeholder="e.g. Day 3, after the storm"
          disabled={disabled}
          onChange={(event) => set({ timeline: event.target.value })}
          className="min-w-0 flex-1 rounded-md border border-line bg-bg px-2 py-px text-xs leading-5 disabled:opacity-50"
        />
      </div>
    </div>
  )
}
