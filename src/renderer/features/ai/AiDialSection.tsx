import { useId, useState } from 'react'
import { AI_PROVIDER_LABEL, type AiFeatureId } from '@shared/ai'
import {
  AI_DATA_SHARING,
  AI_FEATURES_BY_LEVEL,
  GHOST_IDLE_MS_MAX,
  GHOST_IDLE_MS_MIN,
  USE_AI_LABEL,
  USE_AI_MEANING
} from '@shared/aiSettings'
import { useAiSettingsStore } from './aiSettingsStore'
import { providerOf, useAiStore } from './aiStore'
import { useAssistantName } from '@renderer/features/shell/viewStore'
import { nameAssistant } from '@shared/assistantName'

const FIELD = 'w-24 rounded-md border border-line bg-bg px-2 py-1 text-sm'

/**
 * The "This project" section at the top of the AI tab (F-14.4, F-5.21): Use AI, the one on/off
 * control (decided by the author 2026-10-07; the chat's Auto/Ask/Plan sits under the chat box),
 * the per-feature toggles beneath it (disabled and greyed while AI is off, since nothing runs
 * then), the
 * data-sharing table, and the note that nothing is sent until a row is allowed and used. Every
 * row reads `AI_DATA_SHARING`, the same registry `isFeatureAllowed` reads, so the panel cannot
 * disagree with the gate. The ghost-text idle delay (F-5.3) sits under the toggles. Nothing
 * renders until the project's settings have loaded.
 */
export function AiDialSection(): React.JSX.Element | null {
  const settings = useAiSettingsStore((s) => s.settings)
  const update = useAiSettingsStore((s) => s.update)
  const assistantName = useAssistantName()
  // F-15.4: the Provider column names where the text actually goes, which is the project's
  // AI source, not a fixed provider id.
  const source = useAiSettingsStore((s) => s.settings?.source ?? 'ownKey')
  const status = useAiStore((s) => s.status)
  const provider = providerOf(status, source)
  const headingId = useId()
  const useAiHintId = useId()

  if (settings === null) return null
  const { dial, features, ghostText } = settings

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

      <div className="flex flex-col gap-0.5">
        <label className="flex items-center gap-2 font-medium">
          <input
            type="checkbox"
            role="switch"
            aria-describedby={useAiHintId}
            checked={dial !== 0}
            onChange={(event) => update({ dial: event.target.checked ? 1 : 0 })}
          />
          <span>{USE_AI_LABEL}</span>
        </label>
        <p id={useAiHintId} className="m-0 text-xs text-fg-muted">
          {nameAssistant(dial === 0 ? USE_AI_MEANING.off : USE_AI_MEANING.on, assistantName)}
        </p>
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
              <span>{nameAssistant(label, assistantName)}</span>
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
          </tr>
        </thead>
        <tbody className="align-top">
          {AI_FEATURES_BY_LEVEL.map((id) => {
            const { label, sends } = AI_DATA_SHARING[id]
            return (
              <tr key={id}>
                <th scope="row" className="pr-2 text-left font-normal whitespace-nowrap">
                  {nameAssistant(label, assistantName)}
                </th>
                <td className="pr-2">{nameAssistant(sends, assistantName)}</td>
                <td className="whitespace-nowrap">{AI_PROVIDER_LABEL[provider]}</td>
              </tr>
            )
          })}
        </tbody>
      </table>

      <p className="m-0 text-xs text-fg-muted">
        Nothing is sent while {USE_AI_LABEL} is off, or until a feature's row above is allowed and
        you use it.
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
