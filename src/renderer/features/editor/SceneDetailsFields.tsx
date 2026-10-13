import { useState } from 'react'
import { X } from 'lucide-react'
import { useShallow } from 'zustand/react/shallow'
import type { StoryRecordSummary, RecordKind } from '@shared/memory/records'
import {
  ALSO_HERE_MAX,
  parseStoryYear,
  STORY_YEAR_MAX,
  STORY_YEAR_MIN
} from '@shared/memory/sceneDetails'
import { isTopicKind } from '@shared/memory/topics'
import { SCENE_META_FIELD_MAX, SCENE_META_TIMELINE_MAX } from '@shared/sceneMeta'
import { LabelPicker } from '@renderer/features/labels/LabelPicker'
import { useRecordStore } from '@renderer/features/records/recordStore'
import { toast } from '@renderer/features/shell/dialogs/dialogStore'
import { useSceneDetailsEditor, type SceneDetailsEditor } from './sceneDetailsEditor'

const FIELD =
  'min-w-0 flex-1 rounded-md border border-line bg-bg px-2 py-px text-xs leading-5 disabled:opacity-50'
const ROW = 'flex min-w-0 items-center gap-2'
const LABEL = 'w-16 shrink-0 text-xs text-fg-muted'
/** A picker's "New character…" choice; never a record id (those are UUIDs). */
const NEW_RECORD = 'new:'

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
 * store; a text field saves when it loses focus or on Enter. POV and Place offer *New
 * character…* and *New place…*, the record creation dialog (twin gate included), whose record is
 * then chosen. Synopsis, brief, beats and status stay in the scene meta beside them. Outside the
 * manuscript only the labels show.
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

/** The POV picker: a Characters record, or *New character…* through the creation dialog. */
export function PovField({
  editor,
  inputId
}: {
  editor: SceneDetailsEditor
  inputId: string
}): React.JSX.Element {
  const characters = useRecordsOfKind('character')
  const byId = useRecordStore((s) => s.byId)
  const { details, disabled, save, createFor } = editor
  return (
    <RecordSelect
      id={inputId}
      value={details.povRecordId}
      options={characters}
      byId={byId}
      none="Nobody chosen"
      create="New character…"
      disabled={disabled}
      onChange={(povRecordId) => save({ povRecordId })}
      onCreate={() => createFor('character', (povRecordId) => save({ povRecordId }))}
    />
  )
}

/** *+ also here*: the chips of the records present without being named, each removable, and the picker. */
export function AlsoHereField({ editor }: { editor: SceneDetailsEditor }): React.JSX.Element {
  const everyone = useRecordsOfKind(null)
  const byId = useRecordStore((s) => s.byId)
  const { details, disabled, save } = editor
  // A secret or a thread (F-16.22) is never present in a scene.
  const addable = everyone.filter(
    (record) => !isTopicKind(record.kind) && !details.alsoHere.includes(record.id)
  )
  return (
    <>
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
            onClick={() => save({ alsoHere: details.alsoHere.filter((each) => each !== recordId) })}
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
    </>
  )
}

function TypedDetails({ id }: { id: string }): React.JSX.Element {
  const editor = useSceneDetailsEditor(id)
  const places = useRecordsOfKind('place')
  const byId = useRecordStore((s) => s.byId)
  const { details, disabled, save, createFor } = editor

  return (
    <>
      <div className={ROW}>
        <label htmlFor={`${id}-pov`} className={LABEL}>
          POV
        </label>
        <PovField editor={editor} inputId={`${id}-pov`} />
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
          create="New place…"
          disabled={disabled}
          onChange={(recordId) => save({ place: { ...details.place, recordId } })}
          onCreate={() =>
            createFor('setting', (recordId) =>
              save((current) => ({ place: { ...current.place, recordId } }))
            )
          }
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
          maxLength={SCENE_META_TIMELINE_MAX}
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
        <AlsoHereField editor={editor} />
      </div>
    </>
  )
}

/**
 * A record picker: None, then the options by name, then `create` (a new record, made through
 * `onCreate`); a chosen record that is gone reads "Gone".
 */
function RecordSelect({
  id,
  value,
  options,
  byId,
  none,
  create,
  disabled,
  onChange,
  onCreate
}: {
  id: string
  value: string | null
  options: readonly StoryRecordSummary[]
  byId: Readonly<Record<string, StoryRecordSummary>>
  none: string
  create: string
  disabled: boolean
  onChange: (recordId: string | null) => void
  onCreate: () => void
}): React.JSX.Element {
  const listed = value === null || options.some((record) => record.id === value)
  return (
    <select
      id={id}
      value={value ?? ''}
      disabled={disabled}
      onChange={(event) => {
        const picked = event.target.value
        if (picked === NEW_RECORD) onCreate()
        else onChange(picked === '' ? null : picked)
      }}
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
      <option value={NEW_RECORD}>{create}</option>
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
  maxLength = SCENE_META_FIELD_MAX,
  onCommit
}: {
  label: string
  placeholder: string
  value: string
  disabled: boolean
  inputMode?: 'numeric'
  maxLength?: number
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
      maxLength={maxLength}
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
