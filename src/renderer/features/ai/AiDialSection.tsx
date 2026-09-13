import { useId, useRef, useState } from 'react'
import { AI_PROVIDER_LABEL, type AiFeatureId } from '@shared/ai'
import {
  AI_DATA_SHARING,
  AI_DIAL_LABEL,
  AI_DIAL_LEVELS,
  AI_DIAL_MEANING,
  AI_FEATURES_BY_LEVEL,
  GHOST_IDLE_MS_MAX,
  GHOST_IDLE_MS_MIN,
  type AiDial
} from '@shared/aiSettings'
import { useAiSettingsStore } from './aiSettingsStore'
import { useAiStore } from './aiStore'

const RADIO =
  'flex min-w-0 flex-1 flex-col gap-0.5 rounded-md border border-line px-2 py-1.5 text-left hover:bg-surface focus-visible:outline-2 focus-visible:outline-accent aria-checked:border-accent aria-checked:bg-surface-raised'
const FIELD = 'w-24 rounded-md border border-line bg-bg px-2 py-1 text-sm'

/**
 * The "This project" section at the top of the AI tab (F-14.4): the AI dial as a radiogroup
 * (roving tabindex, arrow keys move and select, as ARIA radios do), the per-feature toggles
 * beneath it (a toggle is disabled and its row greyed while the dial is below the feature's
 * level, and its label says which level it needs), the data-sharing table, and the note that
 * nothing is sent until a row is allowed and used. Every disabled state and every row reads
 * `AI_DATA_SHARING`, the same registry `isFeatureAllowed` reads, so the panel cannot disagree
 * with the gate. The ghost-text idle delay (F-5.3) sits under the toggles. Nothing renders until
 * the project's settings have loaded.
 */
export function AiDialSection(): React.JSX.Element | null {
  const settings = useAiSettingsStore((s) => s.settings)
  const update = useAiSettingsStore((s) => s.update)
  const provider = useAiStore((s) => s.status?.provider ?? 'openai')
  const radios = useRef(new Map<AiDial, HTMLButtonElement>())
  const headingId = useId()
  const dialId = useId()

  if (settings === null) return null
  const { dial, features, ghostText } = settings

  const select = (level: AiDial): void => {
    update({ dial: level })
    radios.current.get(level)?.focus()
  }

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    const index = AI_DIAL_LEVELS.indexOf(dial)
    let next: number
    switch (event.key) {
      case 'ArrowRight':
      case 'ArrowDown':
        next = (index + 1) % AI_DIAL_LEVELS.length
        break
      case 'ArrowLeft':
      case 'ArrowUp':
        next = (index - 1 + AI_DIAL_LEVELS.length) % AI_DIAL_LEVELS.length
        break
      case 'Home':
        next = 0
        break
      case 'End':
        next = AI_DIAL_LEVELS.length - 1
        break
      default:
        return
    }
    event.preventDefault()
    const target = AI_DIAL_LEVELS[next]
    if (target !== undefined) select(target)
  }

  const toggle = (id: AiFeatureId, checked: boolean): void => {
    update({ features: { ...features, [id]: checked } })
  }

  return (
    <section
      aria-labelledby={headingId}
      data-testid="ai-dial-section"
      className="flex min-w-0 flex-col gap-3"
    >
      <h3 id={headingId} className="m-0 text-sm font-medium">
        This project
      </h3>

      <div className="flex flex-col gap-1.5">
        <span id={dialId} className="text-xs text-fg-muted">
          AI dial
        </span>
        <div
          role="radiogroup"
          aria-labelledby={dialId}
          onKeyDown={onKeyDown}
          className="flex gap-2"
        >
          {AI_DIAL_LEVELS.map((level) => (
            <DialRadio
              key={level}
              level={level}
              checked={level === dial}
              register={(element) => {
                if (element) radios.current.set(level, element)
                else radios.current.delete(level)
              }}
              onSelect={select}
            />
          ))}
        </div>
      </div>

      <fieldset className="m-0 flex min-w-0 flex-col gap-1 border-0 p-0">
        <legend className="float-left p-0 text-xs text-fg-muted">Features</legend>
        {AI_FEATURES_BY_LEVEL.map((id) => {
          const { label, minDial } = AI_DATA_SHARING[id]
          const locked = dial < minDial
          return (
            <label
              key={id}
              className={`flex items-center gap-2 ${locked ? 'text-fg-muted opacity-60' : ''}`}
            >
              <input
                type="checkbox"
                checked={features[id]}
                disabled={locked}
                onChange={(event) => toggle(id, event.target.checked)}
              />
              <span>
                {label}
                {locked ? ` (needs ${AI_DIAL_LABEL[minDial]})` : ''}
              </span>
            </label>
          )
        })}
      </fieldset>

      <GhostIdleField
        idleMs={ghostText.idleMs}
        onCommit={(idleMs) => update({ ghostText: { ...ghostText, idleMs } })}
      />

      <table aria-label="What each AI feature sends" className="w-full text-xs">
        <thead className="text-fg-muted">
          <tr>
            <th scope="col" className="text-left font-normal">
              Feature
            </th>
            <th scope="col" className="text-left font-normal">
              What it sends
            </th>
            <th scope="col" className="text-left font-normal">
              Provider
            </th>
            <th scope="col" className="text-left font-normal">
              Level needed
            </th>
          </tr>
        </thead>
        <tbody className="align-top">
          {AI_FEATURES_BY_LEVEL.map((id) => {
            const { label, sends, minDial } = AI_DATA_SHARING[id]
            return (
              <tr key={id}>
                <th scope="row" className="pr-2 text-left font-normal whitespace-nowrap">
                  {label}
                </th>
                <td className="pr-2">{sends}</td>
                <td className="pr-2 whitespace-nowrap">{AI_PROVIDER_LABEL[provider]}</td>
                <td className="whitespace-nowrap">{AI_DIAL_LABEL[minDial]}</td>
              </tr>
            )
          })}
        </tbody>
      </table>

      <p className="m-0 text-xs text-fg-muted">
        Nothing is sent until a feature's row above is allowed and you use it.
      </p>
    </section>
  )
}

/**
 * The ghost-text idle delay (F-5.3) in seconds, committed on blur or Enter and clamped to the
 * 0.5–5 s range on commit (a value outside it is pulled to the nearest bound, not refused).
 * `draft` holds only text that is not (yet) the saved value and is dropped when the value
 * changes underneath; a blank or unparsable commit restores the value without a write.
 */
function GhostIdleField({
  idleMs,
  onCommit
}: {
  idleMs: number
  onCommit: (idleMs: number) => void
}): React.JSX.Element {
  const hintId = useId()
  const [draft, setDraft] = useState<string | null>(null)
  const [seen, setSeen] = useState(idleMs)
  if (seen !== idleMs) {
    setSeen(idleMs)
    setDraft(null)
  }

  const commit = (): void => {
    if (draft === null) return
    const seconds = Number(draft.trim())
    setDraft(null)
    if (draft.trim() === '' || !Number.isFinite(seconds)) return
    const clamped = Math.min(
      GHOST_IDLE_MS_MAX,
      Math.max(GHOST_IDLE_MS_MIN, Math.round(seconds * 1000))
    )
    if (clamped !== idleMs) onCommit(clamped)
  }

  return (
    <div className="flex flex-col gap-1">
      <label className="flex items-center gap-3">
        <span className="shrink-0">Ghost text idle delay (s)</span>
        <input
          type="number"
          inputMode="decimal"
          min={GHOST_IDLE_MS_MIN / 1000}
          max={GHOST_IDLE_MS_MAX / 1000}
          step="0.5"
          aria-describedby={hintId}
          value={draft ?? String(idleMs / 1000)}
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
      <p id={hintId} className="m-0 text-xs text-fg-muted">
        How long VibeWrite waits after you stop typing before it proposes a continuation (0.5–5 s).
        Turn VibeWrite on from the editor toolbar.
      </p>
    </div>
  )
}

/** One dial level: the label is the accessible name, the meaning line its description. */
function DialRadio({
  level,
  checked,
  register,
  onSelect
}: {
  level: AiDial
  checked: boolean
  register: (element: HTMLButtonElement | null) => void
  onSelect: (level: AiDial) => void
}): React.JSX.Element {
  const labelId = useId()
  const meaningId = useId()
  return (
    <button
      ref={register}
      type="button"
      role="radio"
      aria-checked={checked}
      aria-labelledby={labelId}
      aria-describedby={meaningId}
      tabIndex={checked ? 0 : -1}
      onClick={() => onSelect(level)}
      className={RADIO}
    >
      <span id={labelId} className="font-medium">
        {AI_DIAL_LABEL[level]}
      </span>
      <span id={meaningId} className="text-xs text-fg-muted">
        {AI_DIAL_MEANING[level]}
      </span>
    </button>
  )
}
