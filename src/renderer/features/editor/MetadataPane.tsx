import { useEffect, useId, useMemo, useState } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { useShallow } from 'zustand/react/shallow'
import { FACT_STATUSES, FACT_STATUS_LABEL, FactStatus } from '@shared/facts'
import {
  EMPTY_SCENE_META,
  SCENE_BRIEF_FIELDS,
  SCENE_BRIEF_FIELD_MAX,
  SCENE_SYNOPSIS_MAX,
  type SceneBriefField,
  type SceneMeta
} from '@shared/sceneMeta'
import { STRUCTURE_TEMPLATES, isTemplateBeat, type StructureTemplateId } from '@shared/structure'
import type { TagCategory } from '@shared/tags'
import { eventForText, eventText } from '@shared/timeline'
import { useTreeStore } from '@renderer/features/manuscript/treeStore'
import { StatusSelect } from '@renderer/features/outline/status'
import { useStructureStore } from '@renderer/features/outline/structureStore'
import { toast } from '@renderer/features/shell/dialogs/dialogStore'
import { useTagStore } from '@renderer/features/tags/tagStore'
import { useTimelineStore } from '@renderer/features/timeline/timelineStore'
import { describeError } from '@renderer/lib/errors'
import { useSceneMetaStore } from './sceneMetaStore'
import { BriefDraftButton, SuggestButton, SynopsisSuggestion } from './SceneSuggestions'
import { SuggestInput } from './SuggestInput'
import { SummaryBlock } from './SummaryBlock'

const BUTTON =
  'flex shrink-0 items-center gap-1 rounded-md whitespace-nowrap px-1.5 py-1 text-xs text-fg-muted hover:bg-surface-raised hover:text-fg aria-expanded:text-fg disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-fg-muted'
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
 * The scene details (F-4.5) for a scene, chapter, or part, behind the "Scene details" disclosure
 * of the notes column since 2026-10-06 (they were the left half of the tag bar): Location
 * (autocomplete from the setting tags), POV (from the character tags), the timeline position
 * (autocomplete from the project's timeline events, F-11.2: picking one links the node, free
 * text unlinks), the outline's status (F-11.1), and the scene brief (F-14.3) behind a
 * disclosure. The synopsis is not here: it is the box at the top of the notes column
 * (`SynopsisBox`). Takes only `id`: it loads the node's metadata through `useSceneMetaStore` on
 * mount (and again when `id` changes) and unloads on unmount; every change goes through the
 * store's `edit`, so it debounces and flushes like notes do (Ctrl+S, close, quit). The fields
 * are disabled until the load resolves. Draft beside the Brief disclosure drafts it with AI
 * (`BriefDraftButton`, `briefDraftStore`; the draft shows in the assistant). Under the brief, `SummaryBlock` shows the scene summary main keeps up
 * to date in the background (F-5.6) for a manuscript document. While the project has a
 * structure template (F-11.1b) and the node is in the manuscript, a Beat picker after Status
 * sets the beat the node sits on in that template (stored per template in `meta.beats`).
 */
export function MetadataPane({ id }: { id: string }): React.JSX.Element {
  const meta = useSceneMetaStore((s) => s.docs[id]?.content ?? null)
  const load = useSceneMetaStore((s) => s.load)
  const unload = useSceneMetaStore((s) => s.unload)
  const edit = useSceneMetaStore((s) => s.edit)
  const settings = useTagNames('setting')
  const characters = useTagNames('character')
  const briefId = useId()
  const [briefOpen, setBriefOpen] = useState(false)
  const template = useStructureStore((s) => s.template)
  const events = useTimelineStore((s) => s.events)
  const eventTexts = useMemo(() => events.map(eventText), [events])
  const inManuscript = useTreeStore((s) => s.sectionOf[id] === 'manuscript')

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
  /**
   * The Timeline field (F-11.2): picking an event's text links the node to the event (main keeps
   * the text in step when the event changes); typing anything else is free text and unlinks it.
   */
  const setTimeline = (text: string): void => {
    if (meta === null) return
    const next: SceneMeta = { ...meta, timeline: text }
    const linked = eventForText(events, text)
    if (linked === null) delete next.eventId
    else next.eventId = linked.id
    edit(id, next)
  }
  /** Puts the node on `beatId` in `on`'s template, or takes it off that template's beats for null. */
  const setBeat = (on: StructureTemplateId, beatId: string | null): void => {
    if (meta === null) return
    const beats = { ...meta.beats }
    if (beatId === null) delete beats[on]
    else beats[on] = beatId
    edit(id, { ...meta, beats })
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
      <SuggestInput
        label="Timeline"
        value={value.timeline}
        onChange={setTimeline}
        options={eventTexts}
        placeholder="e.g. Day 3, after the storm"
        disabled={disabled}
      />
      <StatusSelect
        value={value.status}
        onChange={(status) => set({ status })}
        disabled={disabled}
      />
      {template !== null && inManuscript ? (
        <BeatSelect
          template={template}
          value={value.beats[template] ?? null}
          onChange={(beatId) => setBeat(template, beatId)}
          disabled={disabled}
        />
      ) : null}
      <div className="flex items-center justify-between gap-1">
        <button
          type="button"
          aria-expanded={briefOpen}
          aria-controls={briefOpen ? briefId : undefined}
          onClick={() => setBriefOpen(!briefOpen)}
          className={BUTTON}
        >
          {briefOpen ? (
            <ChevronDown size={14} aria-hidden="true" />
          ) : (
            <ChevronRight size={14} aria-hidden="true" />
          )}
          <span className="font-medium">Brief</span>
        </button>
        <BriefDraftButton id={id} />
      </div>
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
      <SummaryBlock id={id} />
    </div>
  )
}

/**
 * The synopsis box at the top of the notes column (2026-10-06): the node's index-card synopsis
 * (F-11.1, the same `sceneMeta.synopsis` the cork board's cards edit), a few lines tall, for a
 * scene, chapter, or part. Loads and unloads the node's metadata like `MetadataPane` (the store
 * counts holders, so both can show the same node), edits through the store's debounced `edit`,
 * and is disabled until the load resolves. For a manuscript scene, Suggest (F-5.20) asks the AI
 * for a synopsis, shown under the box until the author accepts or dismisses it.
 */
export function SynopsisBox({ id }: { id: string }): React.JSX.Element {
  const meta = useSceneMetaStore((s) => s.docs[id]?.content ?? null)
  const load = useSceneMetaStore((s) => s.load)
  const unload = useSceneMetaStore((s) => s.unload)
  const edit = useSceneMetaStore((s) => s.edit)
  const synopsisId = useId()

  useEffect(() => {
    load(id).catch((err: unknown) => toast.error(describeError(err)))
    return () => unload(id)
  }, [id, load, unload])

  return (
    // The top section of the notes, flush with the column (2026-10-06), on its own tinted band in
    // italic with a strong rule under it, so it never reads as part of the notes (2026-10-07, the
    // author's call).
    <div className="flex shrink-0 flex-col border-b-2 border-line-strong bg-surface-raised">
      <div className="flex items-center gap-1 px-4 pt-2">
        <label
          htmlFor={synopsisId}
          className="min-w-0 flex-1 text-xs font-semibold tracking-wide text-fg-muted uppercase"
        >
          Synopsis
        </label>
        <SuggestButton id={id} kind="synopsis" />
      </div>
      <textarea
        id={synopsisId}
        rows={4}
        value={meta?.synopsis ?? ''}
        placeholder="The index card: what happens here"
        maxLength={SCENE_SYNOPSIS_MAX}
        disabled={meta === null}
        onChange={(event) => {
          if (meta !== null) edit(id, { ...meta, synopsis: event.target.value })
        }}
        className="field-sizing-content max-h-48 min-h-16 w-full resize-none border-0 bg-transparent px-4 py-1.5 text-sm leading-5 italic placeholder:text-fg-muted focus:outline-none disabled:opacity-50"
      />
      <SynopsisSuggestion id={id} />
    </div>
  )
}

/**
 * Where the node's notes stand (F-5.24, D7): Plan (the default), Canon, or Idea, beside the
 * notes' heading. The chat agent labels the notes with it, so a plan is never told as something
 * that happened. Loads the node's metadata through the same autosave store as the synopsis.
 */
export function NotesStatusSelect({ id }: { id: string }): React.JSX.Element {
  const meta = useSceneMetaStore((s) => s.docs[id]?.content ?? null)
  const load = useSceneMetaStore((s) => s.load)
  const unload = useSceneMetaStore((s) => s.unload)
  const edit = useSceneMetaStore((s) => s.edit)

  useEffect(() => {
    load(id).catch((err: unknown) => toast.error(describeError(err)))
    return () => unload(id)
  }, [id, load, unload])

  return (
    <select
      aria-label="Notes status"
      title="Plan: not on the page yet. Canon: true of the story. Idea: a maybe."
      value={meta?.notesStatus ?? 'plan'}
      disabled={meta === null}
      onChange={(event) => {
        const next = FactStatus.safeParse(event.target.value)
        if (meta !== null && next.success) edit(id, { ...meta, notesStatus: next.data })
      }}
      className="shrink-0 rounded-md border border-line bg-bg px-1 py-px text-xs leading-5 text-fg-muted disabled:opacity-50"
    >
      {FACT_STATUSES.map((status) => (
        <option key={status} value={status}>
          {FACT_STATUS_LABEL[status]}
        </option>
      ))}
    </select>
  )
}

/**
 * The beat picker (F-11.1b): "No beat", then each act of the template as an option group. A
 * stored beat id the template does not have reads as no beat.
 */
function BeatSelect({
  template,
  value,
  onChange,
  disabled
}: {
  template: StructureTemplateId
  value: string | null
  onChange: (beatId: string | null) => void
  disabled: boolean
}): React.JSX.Element {
  const selectId = useId()
  const current = value !== null && isTemplateBeat(template, value) ? value : ''
  return (
    <div className="flex items-center gap-2">
      <label htmlFor={selectId} className="w-16 shrink-0 text-xs text-fg-muted">
        Beat
      </label>
      <select
        id={selectId}
        value={current}
        disabled={disabled}
        onChange={(event) => {
          const next = event.target.value
          onChange(next !== '' && isTemplateBeat(template, next) ? next : null)
        }}
        className="min-w-0 flex-1 rounded-md border border-line bg-bg px-1 py-px text-xs leading-5 disabled:opacity-50"
      >
        <option value="">No beat</option>
        {STRUCTURE_TEMPLATES[template].acts.map((act) => (
          <optgroup key={act.name} label={act.name}>
            {act.beats.map((beat) => (
              <option key={beat.id} value={beat.id} title={beat.hint}>
                {beat.name}
              </option>
            ))}
          </optgroup>
        ))}
      </select>
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
