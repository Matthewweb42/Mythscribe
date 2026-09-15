import { useEffect, useId, useState } from 'react'
import { ChevronDown, ChevronRight, Loader2, Sparkles } from 'lucide-react'
import { useShallow } from 'zustand/react/shallow'
import { TAG_BAR_BRIEF_HEIGHT } from '@shared/layout'
import {
  EMPTY_SCENE_META,
  SCENE_BRIEF_FIELDS,
  SCENE_BRIEF_FIELD_MAX,
  type SceneBriefField,
  type SceneMeta
} from '@shared/sceneMeta'
import type { TagCategory } from '@shared/tags'
import { toast } from '@renderer/features/shell/dialogs/dialogStore'
import { useLayoutStore } from '@renderer/features/shell/layoutStore'
import { useTagStore } from '@renderer/features/tags/tagStore'
import { describeError } from '@renderer/lib/errors'
import { useBriefDraft } from './briefDraft'
import { BriefDraftPanel } from './BriefDraftPanel'
import { useSceneMetaStore } from './sceneMetaStore'
import { SuggestInput } from './SuggestInput'

const BUTTON =
  'flex items-center gap-1 rounded-md px-1.5 py-1 text-xs text-fg-muted hover:bg-surface-raised hover:text-fg aria-expanded:text-fg disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-fg-muted'
const FIELD =
  'min-w-0 flex-1 rounded-md border border-line bg-bg px-2 py-px text-xs leading-5 disabled:opacity-50'

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
 * from the setting tags), POV (from the character tags), the timeline position (free text until
 * F-11.2), and the scene brief (F-14.3) behind a disclosure. Takes only `id`: it loads the
 * node's metadata through `useSceneMetaStore` on mount (and again when `id` changes) and unloads
 * on unmount; every change goes through the store's `edit`, so it debounces and flushes like
 * notes do (Ctrl+S, close, quit). The fields are disabled until the load resolves. The pane
 * scrolls inside its column (the suggestion lists are fixed-positioned, so the scroll box never
 * clips them), and opening the brief grows the tag bar to `TAG_BAR_BRIEF_HEIGHT` when it is
 * shorter, never shrinking a taller one. For a document, "Draft with AI" asks main for a brief
 * drafted from the scene (`useBriefDraft`); the author reviews the five lines and fills the
 * fields with one click.
 */
export function MetadataPane({ id }: { id: string }): React.JSX.Element {
  const meta = useSceneMetaStore((s) => s.docs[id]?.content ?? null)
  const load = useSceneMetaStore((s) => s.load)
  const unload = useSceneMetaStore((s) => s.unload)
  const edit = useSceneMetaStore((s) => s.edit)
  const settings = useTagNames('setting')
  const characters = useTagNames('character')
  const timelineId = useId()
  const briefId = useId()
  const [briefOpen, setBriefOpen] = useState(false)
  const tagBarHeight = useLayoutStore((s) => s.layout.tagBar.height)
  const setTagBarHeight = useLayoutStore((s) => s.setTagBarHeight)
  const openBrief = (): void => {
    setBriefOpen(true)
    if (tagBarHeight < TAG_BAR_BRIEF_HEIGHT) setTagBarHeight(TAG_BAR_BRIEF_HEIGHT)
  }
  const draft = useBriefDraft(id, openBrief)

  useEffect(() => {
    load(id).catch((err: unknown) => toast.error(describeError(err)))
    return () => unload(id)
  }, [id, load, unload])

  const value = meta ?? EMPTY_SCENE_META
  const disabled = meta === null
  const set = (patch: Partial<SceneMeta>): void => {
    if (meta !== null) edit(id, { ...meta, ...patch })
  }
  const setBriefField = (field: SceneBriefField, text: string): void => {
    if (meta !== null) edit(id, { ...meta, brief: { ...meta.brief, [field]: text } })
  }

  return (
    <div
      role="group"
      aria-label="Scene metadata"
      className="flex h-full min-w-0 flex-col gap-1 overflow-y-auto"
    >
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
          className={FIELD}
        />
      </div>
      <div className="flex items-center gap-1">
        <button
          type="button"
          aria-expanded={briefOpen}
          aria-controls={briefOpen ? briefId : undefined}
          onClick={() => (briefOpen ? setBriefOpen(false) : openBrief())}
          className={BUTTON}
        >
          {briefOpen ? (
            <ChevronDown size={14} aria-hidden="true" />
          ) : (
            <ChevronRight size={14} aria-hidden="true" />
          )}
          <span className="font-medium">Brief</span>
        </button>
        {draft.available ? (
          <button
            type="button"
            onClick={draft.start}
            disabled={draft.blocked !== null}
            title={draft.blocked ?? "Draft this scene's brief for you to correct"}
            className={`ml-auto ${BUTTON}`}
          >
            {draft.pending ? (
              <Loader2 size={14} aria-hidden="true" className="animate-spin" />
            ) : (
              <Sparkles size={14} aria-hidden="true" />
            )}
            Draft with AI
          </button>
        ) : null}
      </div>
      <BriefDraftPanel draft={draft} />
      {briefOpen ? (
        <div id={briefId} className="flex flex-col gap-1">
          {SCENE_BRIEF_FIELDS.map(({ key, label, hint }) => (
            <BriefField
              key={key}
              label={label}
              hint={hint}
              value={value.brief[key]}
              disabled={disabled}
              onChange={(text) => setBriefField(key, text)}
            />
          ))}
        </div>
      ) : null}
    </div>
  )
}

/** One line of the brief (F-14.3): its label, the hint as the placeholder, capped like the store. */
function BriefField({
  label,
  hint,
  value,
  disabled,
  onChange
}: {
  label: string
  hint: string
  value: string
  disabled: boolean
  onChange: (text: string) => void
}): React.JSX.Element {
  const id = useId()
  return (
    <div className="flex items-center gap-2">
      <label htmlFor={id} className="w-28 shrink-0 text-xs text-fg-muted">
        {label}
      </label>
      <input
        id={id}
        type="text"
        value={value}
        placeholder={hint}
        maxLength={SCENE_BRIEF_FIELD_MAX}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
        className={FIELD}
      />
    </div>
  )
}
