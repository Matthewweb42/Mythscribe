import { useEffect, useId, useRef, useState } from 'react'
import { Settings2 } from 'lucide-react'
import {
  SCENE_BREAK_PRESETS,
  defaultEditorSettings,
  type EditorSettings
} from '@shared/editorSettings'
import type { NovelFormat } from '@shared/ipc/contract'
import { useEditorSettings, useEditorSettingsStore } from './settingsStore'

type NumberKey = Exclude<keyof EditorSettings, 'sceneBreak'>

interface NumberControl {
  key: NumberKey
  label: string
  min: number
  max: number
  step: number
}

/** The five numeric settings (F-3.6) with the ranges the schema allows. */
const NUMBER_CONTROLS: NumberControl[] = [
  { key: 'fontSize', label: 'Font size', min: 12, max: 24, step: 1 },
  { key: 'lineHeight', label: 'Line height', min: 1, max: 2.5, step: 0.1 },
  { key: 'paragraphSpacing', label: 'Paragraph spacing', min: 0, max: 2, step: 0.1 },
  { key: 'paragraphIndent', label: 'First-line indent', min: 0, max: 3, step: 0.1 },
  { key: 'maxWidth', label: 'Max width', min: 500, max: 1000, step: 10 }
]

const CUSTOM = 'custom'
const SCENE_BREAK_MAX = 20

const isPreset = (text: string): boolean =>
  (SCENE_BREAK_PRESETS as readonly string[]).includes(text)

const BUTTON =
  'rounded-md p-1.5 text-fg-muted hover:bg-surface-raised hover:text-fg aria-expanded:bg-surface-raised aria-expanded:text-accent'
const FIELD = 'w-24 rounded-md border border-line bg-bg px-2 py-1 text-sm'
const ROW = 'flex items-center justify-between gap-3'

/**
 * The formatting settings (F-3.6) as a popover under a toolbar button. Every control updates
 * the settings store at once, so the editor previews the change live; the store debounces the
 * write. Out-of-range numbers are clamped when the field commits, so a half-typed value never
 * jumps under the author's fingers. F-7.5 moves these controls into the Settings dialog.
 */
export function EditorSettingsPanel({ format }: { format: NovelFormat }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const settings = useEditorSettings(format)
  const update = useEditorSettingsStore((s) => s.update)
  const root = useRef<HTMLDivElement>(null)
  const panelId = useId()

  useEffect(() => {
    if (!open) return
    const onMouseDown = (event: MouseEvent): void => {
      if (event.target instanceof Node && root.current?.contains(event.target)) return
      setOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onMouseDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('mousedown', onMouseDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  return (
    <div ref={root} className="relative">
      <button
        type="button"
        aria-label="Formatting settings"
        title="Formatting"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        onClick={() => setOpen((v) => !v)}
        className={BUTTON}
      >
        <Settings2 size={16} aria-hidden="true" />
      </button>
      {open ? (
        <div
          id={panelId}
          role="group"
          aria-label="Formatting settings"
          className="absolute top-full right-0 z-30 mt-1 flex w-72 flex-col gap-2 rounded-md border border-line bg-surface-raised p-3 text-sm shadow-panel"
        >
          {NUMBER_CONTROLS.map((control) => (
            <NumberField
              key={control.key}
              control={control}
              value={settings[control.key]}
              onCommit={(value) => update({ [control.key]: value })}
            />
          ))}
          <SceneBreakField
            value={settings.sceneBreak}
            onCommit={(sceneBreak) => update({ sceneBreak })}
          />
          <button
            type="button"
            onClick={() => update(defaultEditorSettings(format))}
            className="mt-1 self-start rounded-md border border-line px-2 py-1 hover:bg-surface"
          >
            Reset to format defaults
          </button>
        </div>
      ) : null}
    </div>
  )
}

const clamp = (n: number, min: number, max: number): number =>
  Math.round(Math.min(max, Math.max(min, n)) * 100) / 100

/**
 * A number input that previews in-range values as they are typed and clamps anything else when
 * the field commits (blur or Enter). `draft` holds only text that is not (yet) the value, and
 * is dropped when the value changes underneath (a reset), so the field always follows the store.
 */
function NumberField({
  control,
  value,
  onCommit
}: {
  control: NumberControl
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
    const clamped = clamp(n, control.min, control.max)
    if (clamped !== value) onCommit(clamped)
  }

  return (
    <label className={ROW}>
      <span>{control.label}</span>
      <input
        type="number"
        min={control.min}
        max={control.max}
        step={control.step}
        value={shown}
        onChange={(event) => {
          const text = event.target.value
          const n = Number(text)
          if (text.trim() !== '' && !Number.isNaN(n) && n >= control.min && n <= control.max) {
            const rounded = clamp(n, control.min, control.max)
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

/** The scene-break presets plus "Custom…", which reveals a text field committed on blur or Enter. */
function SceneBreakField({
  value,
  onCommit
}: {
  value: string
  onCommit: (value: string) => void
}): React.JSX.Element {
  const [custom, setCustom] = useState(!isPreset(value))
  const [draft, setDraft] = useState<string | null>(null)
  const [seen, setSeen] = useState(value)
  if (seen !== value) {
    setSeen(value)
    setCustom(!isPreset(value))
    setDraft(null)
  }

  const commit = (): void => {
    if (draft === null) return
    const text = draft.trim()
    setDraft(null)
    if (text === '' || text.length > SCENE_BREAK_MAX || text === value) return
    onCommit(text)
  }

  return (
    <>
      <label className={ROW}>
        <span>Scene break</span>
        <select
          value={custom ? CUSTOM : value}
          onChange={(event) => {
            const choice = event.target.value
            if (choice === CUSTOM) {
              setCustom(true)
              return
            }
            setCustom(false)
            setDraft(null)
            if (choice !== value) onCommit(choice)
          }}
          className={FIELD}
        >
          {SCENE_BREAK_PRESETS.map((preset) => (
            <option key={preset} value={preset}>
              {preset}
            </option>
          ))}
          <option value={CUSTOM}>Custom…</option>
        </select>
      </label>
      {custom ? (
        <label className={ROW}>
          <span>Custom scene break</span>
          <input
            type="text"
            maxLength={SCENE_BREAK_MAX}
            value={draft ?? value}
            onChange={(event) => setDraft(event.target.value)}
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
      ) : null}
    </>
  )
}
