import { useEffect, useId, useState } from 'react'
import {
  DEFAULT_READING_IDLE_MINUTES,
  READING_IDLE_MINUTES_MAX,
  READING_IDLE_MINUTES_MIN
} from '@shared/aiSettings'
import { CLOUD_CAP_MAX_USD, CLOUD_CAP_STEP_USD, type CloudCapState } from '@shared/memory/cloudCap'
import type { MemoryHealthReport } from '@shared/memory/views'
import { useAiSettingsStore } from '@renderer/features/ai/aiSettingsStore'
import { formatCents } from '@renderer/features/ai/usageFormat'
import { toast } from '@renderer/features/shell/dialogs/dialogStore'
import { describeError } from '@renderer/lib/errors'
import { ipc } from '@renderer/lib/ipc'
import { agreementLine, capFromText, percentOf } from './memoryView'

const FIELD = 'w-20 rounded-md border border-line bg-bg px-2 py-1 text-sm'

/**
 * Settings › AI › **Story memory** (F-16.16, F-16.17, F-16.19; story memory v2 only), under the
 * project's toggles (where the one *Story memory reading* switch is): after how many minutes
 * without a save the open scene is read (2–5, committed on blur or Enter, P2a-D5); on MythScribe
 * Cloud, the monthly cap for background reading in quarter-dollar steps and what it spent this
 * month; the spot checks' "proof agreement: 48 of 50 checked"; how often readings were cut off at
 * their cap; and each model's health (quotes found, checks passed, paused or not).
 */
export function MemorySettings(): React.JSX.Element | null {
  const settings = useAiSettingsStore((s) => s.settings)
  const update = useAiSettingsStore((s) => s.update)
  const headingId = useId()
  const [health, setHealth] = useState<MemoryHealthReport | null>(null)
  const cloud = settings?.source === 'cloud'

  useEffect(() => {
    let live = true
    ipc()
      .invoke('memory:health', undefined)
      .then((report) => {
        if (live) setHealth(report)
      })
      .catch((err: unknown) => {
        if (live) toast.error(describeError(err))
      })
    return () => {
      live = false
    }
  }, [])

  if (settings === null) return null
  const idle = settings.reading.idleMinutes
  const agreement = health === null ? null : agreementLine(health)
  return (
    <section
      aria-labelledby={headingId}
      data-testid="memory-settings"
      className="flex min-w-0 flex-col gap-2"
    >
      <h3 id={headingId} className="m-0 text-sm font-medium">
        Story memory
      </h3>
      <IdleMinutesField
        minutes={idle}
        onCommit={(idleMinutes) => update({ reading: { ...settings.reading, idleMinutes } })}
      />
      {cloud ? <CloudCapField /> : null}
      {health === null ? null : (
        <div className="flex flex-col gap-0.5 text-xs text-fg-muted" data-testid="memory-health">
          {agreement === null ? (
            <span>No spot checks yet: they run after Rebuild memory.</span>
          ) : (
            <span>{agreement}</span>
          )}
          <span>Readings cut off at their limit: {percentOf(health.cutRate)} of the last 100</span>
          {health.models.length === 0 ? null : (
            <details>
              <summary className="cursor-pointer">Health per model</summary>
              <ul className="m-0 list-none p-0">
                {health.models.map((model) => (
                  <li key={model.model}>
                    {model.model}:{' '}
                    {model.judged
                      ? `${percentOf(model.quotes)} of quotes found, ${percentOf(model.verified)} of checks passed`
                      : `not judged yet (${model.readings} readings, ${model.items} facts)`}
                    {model.paused ? (model.keepReading ? ' · kept reading' : ' · paused') : ''}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </div>
      )}
    </section>
  )
}

/** "Read after a pause of [3] minutes", clamped to 2–5 on commit. */
function IdleMinutesField({
  minutes,
  onCommit
}: {
  minutes: number
  onCommit: (minutes: number) => void
}): React.JSX.Element {
  const hintId = useId()
  const [draft, setDraft] = useState<string | null>(null)
  const [seen, setSeen] = useState(minutes)
  if (seen !== minutes) {
    setSeen(minutes)
    setDraft(null)
  }
  const commit = (): void => {
    if (draft === null) return
    const value = Number(draft.trim())
    setDraft(null)
    if (draft.trim() === '' || !Number.isFinite(value)) return
    const clamped = Math.min(
      READING_IDLE_MINUTES_MAX,
      Math.max(READING_IDLE_MINUTES_MIN, Math.round(value))
    )
    if (clamped !== minutes) onCommit(clamped)
  }
  return (
    <div className="flex flex-col gap-1">
      <label className="flex items-center gap-2">
        <span className="shrink-0">Read after a pause of</span>
        <input
          type="number"
          inputMode="numeric"
          min={READING_IDLE_MINUTES_MIN}
          max={READING_IDLE_MINUTES_MAX}
          step="1"
          aria-label="Read after a pause of (minutes)"
          aria-describedby={hintId}
          value={draft ?? String(minutes)}
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
        <span>minutes</span>
      </label>
      <p id={hintId} className="m-0 text-xs text-fg-muted">
        {`A scene is read when you leave it, or after you stop typing for this long (${READING_IDLE_MINUTES_MIN}–${READING_IDLE_MINUTES_MAX} minutes, ${DEFAULT_READING_IDLE_MINUTES} by default). Only what changed is sent.`}
      </p>
    </div>
  )
}

/** On Cloud: the monthly cap for background reading, and what it spent this month (app-wide). */
function CloudCapField(): React.JSX.Element {
  const [state, setState] = useState<CloudCapState | null>(null)
  const [draft, setDraft] = useState<string | null>(null)
  useEffect(() => {
    let live = true
    ipc()
      .invoke('cloudCap:get', undefined)
      .then((answer) => {
        if (live) setState(answer)
      })
      .catch((err: unknown) => {
        if (live) toast.error(describeError(err))
      })
    return () => {
      live = false
    }
  }, [])
  if (state === null) return <span className="text-xs text-fg-muted">Reading the Cloud cap…</span>
  const commit = (): void => {
    if (draft === null) return
    const capUsd = capFromText(draft)
    setDraft(null)
    if (capUsd === null || capUsd === state.capUsd) return
    ipc()
      .invoke('cloudCap:set', { capUsd })
      .then(setState)
      .catch((err: unknown) => toast.error(describeError(err)))
  }
  return (
    <div className="flex flex-col gap-1" data-testid="cloud-cap">
      <label className="flex items-center gap-2">
        <span className="shrink-0">Background reading on Cloud, up to $</span>
        <input
          type="number"
          inputMode="decimal"
          min={0}
          max={CLOUD_CAP_MAX_USD}
          step={CLOUD_CAP_STEP_USD}
          aria-label="Monthly Cloud cap for background reading (dollars)"
          value={draft ?? state.capUsd.toFixed(2)}
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
        <span>a month</span>
      </label>
      <p className="m-0 text-xs text-fg-muted">
        This month: {formatCents(state.backgroundUsd)} of {formatCents(state.limitUsd)} in the
        background, {formatCents(state.askedUsd)} you asked for (Read now, Rebuild memory). What you
        ask for is never held back by the cap.
      </p>
    </div>
  )
}
