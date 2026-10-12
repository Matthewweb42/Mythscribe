import { useEffect, useState } from 'react'
import { X } from 'lucide-react'
import { useShallow } from 'zustand/react/shallow'
import type { StoryRecordSummary, RecordKind } from '@shared/memory/records'
import {
  ALSO_HERE_MAX,
  emptySceneDetails,
  parseStoryYear,
  STORY_YEAR_MAX,
  STORY_YEAR_MIN,
  type SceneDetails
} from '@shared/memory/sceneDetails'
import { SCENE_META_FIELD_MAX } from '@shared/sceneMeta'
import { LabelPicker } from '@renderer/features/labels/LabelPicker'
import { useRecordStore } from '@renderer/features/records/recordStore'
import { toast } from '@renderer/features/shell/dialogs/dialogStore'
import { describeError } from '@renderer/lib/errors'
import { useSceneDetailStore } from './sceneDetailStore'

const FIELD =
  'min-w-0 flex-1 rounded-md border border-line bg-bg px-2 py-px text-xs leading-5 disabled:opacity-50'
const ROW = 'flex min-w-0 items-center gap-2'
const LABEL = 'w-16 shrink-0 text-xs text-fg-muted'

/** The records of one kind, by name. */
function useRecordsOfKind(kind: RecordKind | null): StoryRecordSummary[] {
  return useRecordStore(
    useShallow((s) =>
      s.ids.flatMap((id) => {
        const record = s.byId[id]
        return record !== undefined && (kind === null || record.kind === kind) ? [record] : []
      })
    )
  )
}

/**
 * Story memory v2's typed scene details (F-16.11), in the scene details of a manuscript scene,
 * chapter or part: POV (a Characters record), Place (a place record plus free text), Time (free
 * text), Story year (one typed year per time jump, decision 5), *+ also here* (records present
 * without being named) and Labels (F-16.7). Each change saves at once through the scene detail
 * store; a text field saves when it loses focus or on Enter. Synopsis, brief, beats and status
 * stay in the scene meta beside them. Outside the manuscript only the labels show.
 */
export function SceneDetailsFields({
  id,
  inManuscript
}: {
  id: string
  inManuscript: boolean
}): React.JSX.Element {
  return (
    <div role="group" aria-label="Typed details" className="flex min-w-0 flex-col gap-1">
      {inManuscript ? <TypedDetails id={id} /> : null}
      <div className={ROW}>
        <span className={LABEL}>Labels</span>
        <LabelPicker nodeId={id} />
      </div>
    </div>
  )
}

function TypedDetails({ id }: { id: string }): React.JSX.Element {
  const view = useSceneDetailStore((s) => s.docs[id])
  const characters = useRecordsOfKind('character')
  const places = useRecordsOfKind('place')
  const everyone = useRecordsOfKind(null)
  const byId = useRecordStore((s) => s.byId)

  useEffect(() => {
    useSceneDetailStore
      .getState()
      .load(id)
      .catch((err: unknown) => toast.error(describeError(err)))
  }, [id])

  const disabled = view === undefined
  const details: SceneDetails = view ?? emptySceneDetails()
  const save = (patch: Partial<SceneDetails>): void => {
    if (view === undefined) return
    const current: SceneDetails = {
      povRecordId: view.povRecordId,
      place: view.place,
      time: view.time,
      storyYear: view.storyYear,
      alsoHere: view.alsoHere
    }
    useSceneDetailStore
      .getState()
      .save(id, { ...current, ...patch })
      .catch((err: unknown) => toast.error(describeError(err)))
  }
  const addable = everyone.filter((record) => !details.alsoHere.includes(record.id))

  return (
    <>
      <div className={ROW}>
        <label htmlFor={`${id}-pov`} className={LABEL}>
          POV
        </label>
        <RecordSelect
          id={`${id}-pov`}
          value={details.povRecordId}
          options={characters}
          byId={byId}
          none="Nobody chosen"
          disabled={disabled}
          onChange={(povRecordId) => save({ povRecordId })}
        />
      </div>
      <div className={ROW}>
        <label htmlFor={`${id}-place`} className={LABEL}>
          Place
        </label>
        <RecordSelect
          id={`${id}-place`}
          value={details.place.recordId}
          options={places}
          byId={byId}
          none="No place chosen"
          disabled={disabled}
          onChange={(recordId) => save({ place: { ...details.place, recordId } })}
        />
      </div>
      <div className={ROW}>
        <span className={LABEL} />
        <TextField
          key={`place:${details.place.text}`}
          label="Place, in your words"
          placeholder="the north quay, at the steps"
          value={details.place.text}
          disabled={disabled}
          onCommit={(text) => save({ place: { ...details.place, text } })}
        />
      </div>
      <div className={ROW}>
        <span className={LABEL}>Time</span>
        <TextField
          key={`time:${details.time.text}`}
          label="Time"
          placeholder="December, evening"
          value={details.time.text}
          disabled={disabled}
          onCommit={(text) => save({ time: { text } })}
        />
      </div>
      <div className={ROW}>
        <span className={LABEL}>Story year</span>
        <TextField
          key={`year:${details.storyYear ?? ''}`}
          label="Story year"
          placeholder="e.g. 1814"
          value={details.storyYear === null ? '' : String(details.storyYear)}
          disabled={disabled}
          inputMode="numeric"
          onCommit={(text) => {
            const storyYear = parseStoryYear(text)
            if (storyYear === undefined) {
              toast.error(
                `A story year is a whole number from ${STORY_YEAR_MIN} to ${STORY_YEAR_MAX}.`
              )
              return false
            }
            save({ storyYear })
            return true
          }}
        />
      </div>
      <div className={`${ROW} flex-wrap`}>
        <span className={LABEL}>Also here</span>
        {details.alsoHere.map((recordId) => (
          <span
            key={recordId}
            className="inline-flex items-center gap-1 rounded-full border border-line px-2 py-0.5 text-xs"
          >
            {byId[recordId]?.name ?? 'Gone'}
            <button
              type="button"
              aria-label={`Not here: ${byId[recordId]?.name ?? 'gone record'}`}
              disabled={disabled}
              onClick={() =>
                save({ alsoHere: details.alsoHere.filter((each) => each !== recordId) })
              }
              className="flex size-4 items-center justify-center rounded-full text-fg-muted hover:bg-surface-raised hover:text-fg"
            >
              <X size={10} aria-hidden="true" />
            </button>
          </span>
        ))}
        {addable.length > 0 && details.alsoHere.length < ALSO_HERE_MAX ? (
          <select
            aria-label="Also here"
            value=""
            disabled={disabled}
            onChange={(event) => {
              const recordId = event.target.value
              if (recordId !== '') save({ alsoHere: [...details.alsoHere, recordId] })
            }}
            className="rounded-md border border-line bg-bg px-1 py-px text-xs leading-5"
          >
            <option value="">+ also here…</option>
            {addable.map((record) => (
              <option key={record.id} value={record.id}>
                {record.name}
              </option>
            ))}
          </select>
        ) : null}
      </div>
    </>
  )
}

/** A record picker: None, then the options by name; a chosen record that is gone reads "Gone". */
function RecordSelect({
  id,
  value,
  options,
  byId,
  none,
  disabled,
  onChange
}: {
  id: string
  value: string | null
  options: readonly StoryRecordSummary[]
  byId: Readonly<Record<string, StoryRecordSummary>>
  none: string
  disabled: boolean
  onChange: (recordId: string | null) => void
}): React.JSX.Element {
  const listed = value === null || options.some((record) => record.id === value)
  return (
    <select
      id={id}
      value={value ?? ''}
      disabled={disabled}
      onChange={(event) => onChange(event.target.value === '' ? null : event.target.value)}
      className={FIELD}
    >
      <option value="">{none}</option>
      {listed || value === null ? null : (
        <option value={value}>{byId[value]?.name ?? 'Gone'}</option>
      )}
      {options.map((record) => (
        <option key={record.id} value={record.id}>
          {record.name}
        </option>
      ))}
    </select>
  )
}

/**
 * A free-text detail that saves when it loses focus or on Enter, only when it changed; `onCommit`
 * answering false (a refused value) puts the stored text back.
 */
function TextField({
  label,
  placeholder,
  value,
  disabled,
  inputMode,
  onCommit
}: {
  label: string
  placeholder: string
  value: string
  disabled: boolean
  inputMode?: 'numeric'
  onCommit: (text: string) => boolean | void
}): React.JSX.Element {
  const [text, setText] = useState(value)
  const commit = (): void => {
    if (text.trim() === value.trim()) return
    if (onCommit(text.trim()) === false) setText(value)
  }
  return (
    <input
      aria-label={label}
      placeholder={placeholder}
      value={text}
      disabled={disabled}
      inputMode={inputMode}
      maxLength={SCENE_META_FIELD_MAX}
      onChange={(event) => setText(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          event.preventDefault()
          commit()
        }
      }}
      className={FIELD}
    />
  )
}
