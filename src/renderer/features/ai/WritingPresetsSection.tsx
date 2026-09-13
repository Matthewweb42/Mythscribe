import { useId, useRef, useState } from 'react'
import {
  CUSTOM_PRESET_BLURB,
  MAX_SUGGESTION_TOKENS_MAX,
  MAX_SUGGESTION_TOKENS_MIN,
  PRESET_IDS,
  PRESETS,
  STYLE_INSTRUCTION_MAX,
  TEMPERATURE_MAX,
  TEMPERATURE_MIN,
  builtinParams,
  presetLabel,
  type PresetId,
  type PresetParams
} from '@shared/presets'
import { usePresetsStore } from './presetsStore'

const RADIO =
  'flex min-w-0 flex-col gap-0.5 rounded-md border border-line px-2 py-1.5 text-left hover:bg-surface focus-visible:outline-2 focus-visible:outline-accent aria-checked:border-accent aria-checked:bg-surface-raised'
const FIELD = 'min-w-0 flex-1 rounded-md border border-line bg-bg px-2 py-1 text-sm'
const ROW = 'flex items-center gap-3'

const clamp = (n: number, min: number, max: number): number =>
  Math.round(Math.min(max, Math.max(min, n)) * 100) / 100

/**
 * The "Writing presets" section of the AI tab (F-5.2), directly under the dial: the seven
 * presets as a vertical radiogroup (roving tabindex, arrow keys move and select, like the dial),
 * each with its blurb. The checked preset expands beneath its blurb: a built-in shows its
 * parameters read-only, Custom shows the four editable fields (instruction committed on blur
 * with a counter, temperature and max length clamped on commit like the editor's number fields,
 * the new-elements checkbox written at once). Selecting and editing go through
 * `usePresetsStore.update`, always with the whole `custom` object. Nothing renders until the
 * project's presets have loaded.
 */
export function WritingPresetsSection(): React.JSX.Element | null {
  const settings = usePresetsStore((s) => s.settings)
  const update = usePresetsStore((s) => s.update)
  const radios = useRef(new Map<PresetId, HTMLButtonElement>())
  const headingId = useId()

  if (settings === null) return null
  const { active, custom } = settings

  const select = (id: PresetId): void => {
    update({ active: id })
    radios.current.get(id)?.focus()
  }

  const onKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>): void => {
    const index = PRESET_IDS.indexOf(active)
    let next: number
    switch (event.key) {
      case 'ArrowRight':
      case 'ArrowDown':
        next = (index + 1) % PRESET_IDS.length
        break
      case 'ArrowLeft':
      case 'ArrowUp':
        next = (index - 1 + PRESET_IDS.length) % PRESET_IDS.length
        break
      case 'Home':
        next = 0
        break
      case 'End':
        next = PRESET_IDS.length - 1
        break
      default:
        return
    }
    event.preventDefault()
    const target = PRESET_IDS[next]
    if (target !== undefined) select(target)
  }

  const setParam = <K extends keyof PresetParams>(key: K, value: PresetParams[K]): void => {
    update({ custom: { ...custom, [key]: value } })
  }

  return (
    <section
      aria-labelledby={headingId}
      data-testid="writing-presets-section"
      className="flex min-w-0 flex-col gap-3"
    >
      <h3 id={headingId} className="m-0 text-sm font-medium">
        Writing presets
      </h3>
      <p className="m-0 text-xs text-fg-muted">
        How ghost text and drafting continue your scene: temperature, suggestion length, a style
        instruction, and whether the AI may introduce new plot elements. Your voice and the AI dial
        always come first.
      </p>
      <div role="radiogroup" aria-label="Writing preset" className="flex flex-col gap-1.5">
        {PRESET_IDS.map((id) => (
          <div key={id} className="flex flex-col gap-1.5">
            <PresetRadio
              id={id}
              checked={id === active}
              register={(element) => {
                if (element) radios.current.set(id, element)
                else radios.current.delete(id)
              }}
              onSelect={select}
              onKeyDown={onKeyDown}
            />
            {id !== active ? null : id === 'custom' ? (
              <CustomFields custom={custom} onChange={setParam} />
            ) : (
              <BuiltinParams params={builtinParams(id)} />
            )}
          </div>
        ))}
      </div>
    </section>
  )
}

/** One preset: the label is the accessible name, the blurb its description. */
function PresetRadio({
  id,
  checked,
  register,
  onSelect,
  onKeyDown
}: {
  id: PresetId
  checked: boolean
  register: (element: HTMLButtonElement | null) => void
  onSelect: (id: PresetId) => void
  onKeyDown: (event: React.KeyboardEvent<HTMLButtonElement>) => void
}): React.JSX.Element {
  const labelId = useId()
  const blurbId = useId()
  const label = presetLabel(id)
  const blurb = id === 'custom' ? CUSTOM_PRESET_BLURB : PRESETS[id].blurb
  return (
    <button
      ref={register}
      type="button"
      role="radio"
      aria-checked={checked}
      aria-labelledby={labelId}
      aria-describedby={blurbId}
      tabIndex={checked ? 0 : -1}
      onClick={() => onSelect(id)}
      onKeyDown={onKeyDown}
      className={RADIO}
    >
      <span id={labelId} className="font-medium">
        {label}
      </span>
      <span id={blurbId} className="text-xs text-fg-muted">
        {blurb}
      </span>
    </button>
  )
}

/** A built-in preset's parameters, read-only, beneath its radio. */
function BuiltinParams({ params }: { params: PresetParams }): React.JSX.Element {
  return (
    <dl
      data-testid="preset-params"
      className="m-0 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 pl-2 text-xs"
    >
      <dt className="text-fg-muted">Temperature</dt>
      <dd className="m-0 tabular-nums">{params.temperature}</dd>
      <dt className="text-fg-muted">Max length</dt>
      <dd className="m-0 tabular-nums">{params.maxSuggestionTokens} tokens</dd>
      <dt className="text-fg-muted">New elements</dt>
      <dd className="m-0">{params.allowNewElements ? 'Yes' : 'No'}</dd>
      <dt className="text-fg-muted">Instruction</dt>
      <dd className="m-0">{params.styleInstruction}</dd>
    </dl>
  )
}

/** Custom's four fields; every change hands the parent one key and value, which it merges into the whole object. */
function CustomFields({
  custom,
  onChange
}: {
  custom: PresetParams
  onChange: <K extends keyof PresetParams>(key: K, value: PresetParams[K]) => void
}): React.JSX.Element {
  return (
    <div data-testid="preset-custom" className="flex flex-col gap-2 pl-2">
      <InstructionField
        value={custom.styleInstruction}
        onCommit={(text) => onChange('styleInstruction', text)}
      />
      <ParamNumberField
        label="Temperature"
        min={TEMPERATURE_MIN}
        max={TEMPERATURE_MAX}
        step={0.1}
        value={custom.temperature}
        onCommit={(n) => onChange('temperature', n)}
      />
      <ParamNumberField
        label="Max length (tokens)"
        min={MAX_SUGGESTION_TOKENS_MIN}
        max={MAX_SUGGESTION_TOKENS_MAX}
        step={1}
        value={custom.maxSuggestionTokens}
        onCommit={(n) => onChange('maxSuggestionTokens', n)}
      />
      <label className="flex items-center gap-2">
        <input
          type="checkbox"
          checked={custom.allowNewElements}
          onChange={(event) => onChange('allowNewElements', event.target.checked)}
        />
        <span>May introduce new plot elements</span>
      </label>
    </div>
  )
}

/**
 * The style instruction, committed on blur with a live character count. `draft` holds only
 * text that is not (yet) the value and is dropped when the value changes underneath (a revert),
 * so the field always follows the store; a blank or unchanged commit restores the saved value
 * without a write, and an over-long one is cut to the cap.
 */
function InstructionField({
  value,
  onCommit
}: {
  value: string
  onCommit: (text: string) => void
}): React.JSX.Element {
  const counterId = useId()
  const [draft, setDraft] = useState<string | null>(null)
  const [seen, setSeen] = useState(value)
  if (seen !== value) {
    setSeen(value)
    setDraft(null)
  }
  const shown = draft ?? value

  const commit = (): void => {
    if (draft === null) return
    const text = draft.trim().slice(0, STYLE_INSTRUCTION_MAX)
    setDraft(null)
    if (text === '' || text === value) return
    onCommit(text)
  }

  return (
    <div className="flex flex-col gap-1">
      <label className="flex flex-col gap-1">
        <span>Style instruction</span>
        <textarea
          rows={3}
          maxLength={STYLE_INSTRUCTION_MAX}
          spellCheck={false}
          aria-describedby={counterId}
          value={shown}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={commit}
          className={`${FIELD} resize-y`}
        />
      </label>
      <span id={counterId} className="self-end text-xs text-fg-muted tabular-nums">
        {shown.length}/{STYLE_INSTRUCTION_MAX}
      </span>
    </div>
  )
}

/**
 * A number input that previews in-range values as they are typed and clamps anything else when
 * the field commits (blur or Enter), the editor tab's number-field pattern: `draft` holds only
 * text that is not (yet) the value and is dropped when the value changes underneath.
 */
function ParamNumberField({
  label,
  min,
  max,
  step,
  value,
  onCommit
}: {
  label: string
  min: number
  max: number
  step: number
  value: number
  onCommit: (value: number) => void
}): React.JSX.Element {
  const [draft, setDraft] = useState<string | null>(null)
  const [seen, setSeen] = useState(value)
  if (seen !== value) {
    setSeen(value)
    setDraft(null)
  }
  const shown = draft ?? String(value)

  const commit = (): void => {
    if (draft === null) return
    const n = Number(draft)
    setDraft(null)
    if (draft.trim() === '' || Number.isNaN(n)) return
    const clamped = clamp(n, min, max)
    if (clamped !== value) onCommit(clamped)
  }

  return (
    <label className={ROW}>
      <span className="w-36 shrink-0">{label}</span>
      <input
        type="number"
        min={min}
        max={max}
        step={step}
        value={shown}
        onChange={(event) => {
          const text = event.target.value
          const n = Number(text)
          if (text.trim() !== '' && !Number.isNaN(n) && n >= min && n <= max) {
            const rounded = clamp(n, min, max)
            setDraft(String(rounded) === text ? null : text)
            if (rounded !== value) onCommit(rounded)
            return
          }
          setDraft(text)
        }}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault()
            commit()
          }
        }}
        className={FIELD}
      />
    </label>
  )
}
