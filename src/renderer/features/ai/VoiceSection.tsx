import { useEffect, useId } from 'react'
import {
  EXEMPLAR_KIND_LABEL,
  VOICE_EXEMPLAR_MAX,
  VOICE_EXEMPLAR_TEXT_MAX,
  VOICE_EXEMPLAR_TEXT_MIN
} from '@shared/voice'
import { toast } from '@renderer/features/shell/dialogs/dialogStore'
import { describeError } from '@renderer/lib/errors'
import { useVoiceStore } from './voiceStore'

const BUTTON =
  'shrink-0 rounded-md border border-line px-2 py-1 text-xs hover:bg-surface disabled:opacity-50 disabled:hover:bg-transparent'

/** How much of an exemplar the list shows. */
const PREVIEW_CHARS = 80

const report = (err: unknown): void => {
  toast.error(describeError(err))
}

const preview = (text: string): string =>
  text.length > PREVIEW_CHARS ? `${text.slice(0, PREVIEW_CHARS).trimEnd()}…` : text

/**
 * The "Voice profile" section of the AI tab (F-14.1), under the writing presets: the
 * confidence (a meter with the words it was built from and how to raise it), the rules the
 * profile currently renders into prompts, and the exemplar list with Remove. The profile is
 * loaded on mount (local, cached in main) and nothing renders until it lands; the exemplars
 * come from the store the project loaded, so a mark from the toolbar shows here at once.
 */
export function VoiceSection(): React.JSX.Element | null {
  const profile = useVoiceStore((s) => s.profile)
  const exemplars = useVoiceStore((s) => s.exemplars)
  const loadProfile = useVoiceStore((s) => s.loadProfile)
  const remove = useVoiceStore((s) => s.remove)
  const headingId = useId()
  const confidenceId = useId()

  useEffect(() => {
    loadProfile().catch(report)
  }, [loadProfile])

  if (profile === null) return null
  const list = exemplars ?? profile.exemplars
  const percent = Math.round(profile.confidence * 100)

  return (
    <section
      aria-labelledby={headingId}
      data-testid="voice-section"
      className="flex min-w-0 flex-col gap-3"
    >
      <h3 id={headingId} className="m-0 text-sm font-medium">
        Voice profile
      </h3>
      <p className="m-0 text-xs text-fg-muted">
        Built on this machine from your manuscript and the passages you mark; ghost text carries it
        so continuations sound like you. Nothing here calls the AI.
      </p>

      <div className="flex flex-col gap-1">
        <div className="flex items-center justify-between gap-3">
          <span id={confidenceId}>Confidence</span>
          <span data-testid="voice-confidence" className="font-medium tabular-nums">
            {percent}%
          </span>
        </div>
        <progress
          aria-labelledby={confidenceId}
          value={profile.confidence}
          max={1}
          className="h-1.5 w-full"
        />
        <p data-testid="voice-words" className="m-0 text-xs text-fg-muted">
          Built from {profile.wordCount.toLocaleString()} words of manuscript and {list.length} of{' '}
          {VOICE_EXEMPLAR_MAX} exemplars. Add more scenes or mark exemplars to raise this.
        </p>
      </div>

      <div className="flex flex-col gap-1">
        <span className="font-medium">Rules</span>
        {profile.rules.length > 0 ? (
          <ul aria-label="Voice rules" className="m-0 flex list-disc flex-col gap-0.5 pl-5 text-xs">
            {profile.rules.map((rule) => (
              <li key={rule}>{rule}</li>
            ))}
          </ul>
        ) : (
          <p className="m-0 text-xs text-fg-muted">
            No rules yet: the manuscript is too short to say much about your style.
          </p>
        )}
      </div>

      <div className="flex flex-col gap-1">
        <span className="font-medium">Exemplars</span>
        {list.length > 0 ? (
          <ul aria-label="Voice exemplars" className="m-0 flex list-none flex-col gap-1.5 p-0">
            {list.map((exemplar, index) => (
              <li
                key={exemplar.id}
                className="flex min-w-0 items-start gap-2 rounded-md border border-line px-2 py-1.5"
              >
                <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="text-xs text-fg-muted">
                    {EXEMPLAR_KIND_LABEL[exemplar.kind]} · POV {exemplar.pov ?? '—'}
                  </span>
                  <span className="text-xs break-words">{preview(exemplar.text)}</span>
                </div>
                <button
                  type="button"
                  aria-label={`Remove exemplar ${index + 1}`}
                  onClick={() => {
                    remove(exemplar.id).catch(report)
                  }}
                  className={BUTTON}
                >
                  Remove
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="m-0 text-xs text-fg-muted">No exemplars marked yet.</p>
        )}
        <p className="m-0 text-xs text-fg-muted">
          Select {VOICE_EXEMPLAR_TEXT_MIN}–{VOICE_EXEMPLAR_TEXT_MAX.toLocaleString()} characters in
          the editor and use Mark voice exemplar in the toolbar. Up to {VOICE_EXEMPLAR_MAX}.
        </p>
      </div>
    </section>
  )
}
