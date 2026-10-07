import { useEffect, useId, useState } from 'react'
import type { VoiceConsistencyReport } from '@shared/ipc/contract'
import { RULE_MIN_WORDS } from '@shared/stylometry'
import {
  EXEMPLAR_KIND_LABEL,
  VOICE_AUTO_EXEMPLAR_MAX,
  VOICE_EXEMPLAR_MAX,
  VOICE_NOTES_MIN_WORDS,
  VOICE_NOTES_REFRESH_WORDS,
  type VoiceNotes
} from '@shared/voice'
import { useTreeStore } from '@renderer/features/manuscript/treeStore'
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
 * come from the store the project loaded (the toolbar's mark button is gone since 2026-10-06;
 * the voice job picks exemplars, F-14.14, and `voice:addExemplar` stays for a hand mark). The
 * consistency report (F-14.7) is on demand: the button scores every scene against the profile
 * and lists the drifting ones first; a title selects that scene in the tree. Since F-14.14 the
 * section also shows what was learned automatically: the AI-made style notes with Clear, and
 * the exemplars the voice job picked, marked "Picked automatically"; it re-lists the
 * exemplars and loads the notes on mount, since both change in the background.
 */
export function VoiceSection(): React.JSX.Element | null {
  const profile = useVoiceStore((s) => s.profile)
  const exemplars = useVoiceStore((s) => s.exemplars)
  const consistency = useVoiceStore((s) => s.report)
  const loadProfile = useVoiceStore((s) => s.loadProfile)
  const loadReport = useVoiceStore((s) => s.loadReport)
  const remove = useVoiceStore((s) => s.remove)
  const notes = useVoiceStore((s) => s.notes)
  const load = useVoiceStore((s) => s.load)
  const loadNotes = useVoiceStore((s) => s.loadNotes)
  const clearNotes = useVoiceStore((s) => s.clearNotes)
  const select = useTreeStore((s) => s.select)
  const [checking, setChecking] = useState(false)
  const headingId = useId()
  const confidenceId = useId()

  useEffect(() => {
    loadProfile().catch(report)
    load().catch(report)
    loadNotes().catch(report)
  }, [loadProfile, load, loadNotes])

  const check = (): void => {
    setChecking(true)
    loadReport()
      .catch(report)
      .finally(() => setChecking(false))
  }

  if (profile === null) return null
  const list = exemplars ?? profile.exemplars
  const percent = Math.round(profile.confidence * 100)
  const marked = list.filter((exemplar) => exemplar.source === 'author').length
  const picked = list.length - marked

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
        Learned from your manuscript as you write: the rules and the example passages are worked out
        on this machine, and the style notes come from the AI when it is on. Ghost text and the
        other writing features carry the profile so suggestions sound like you.
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
          Built from {profile.wordCount.toLocaleString()} words of manuscript, {marked} of{' '}
          {VOICE_EXEMPLAR_MAX} marked exemplars, and {picked} picked automatically. It rises as you
          write.
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

      <LearnedNotes
        notes={notes}
        onClear={() => {
          clearNotes().catch(report)
        }}
      />

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
                    {exemplar.source === 'auto' ? ' · Picked automatically' : ''}
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
          <p className="m-0 text-xs text-fg-muted">No exemplars yet.</p>
        )}
        <p className="m-0 text-xs text-fg-muted">
          MythScribe picks up to {VOICE_AUTO_EXEMPLAR_MAX} passages of your own prose (never text
          accepted from the AI) as you write; removing one keeps it from being picked again.
        </p>
      </div>

      <div className="flex flex-col gap-1">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="font-medium">Consistency</span>
          <button type="button" onClick={check} disabled={checking} className={BUTTON}>
            Check voice consistency
          </button>
        </div>
        <p className="m-0 text-xs text-fg-muted">
          Scores every scene against the profile, on this machine, to find the ones that drift.
        </p>
        {consistency !== null ? <ConsistencyList report={consistency} onOpen={select} /> : null}
      </div>
    </section>
  )
}

/**
 * The learned style notes (F-14.14): AI-made, so labelled as such with the date and model, and
 * removable with Clear; before the first refresh, a line saying when they will come.
 */
function LearnedNotes({
  notes,
  onClear
}: {
  notes: VoiceNotes | null
  onClear: () => void
}): React.JSX.Element {
  const headingId = useId()
  const learned = notes?.notes ?? []
  return (
    <div className="flex flex-col gap-1" data-testid="voice-notes">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span id={headingId} className="font-medium">
          What MythScribe has learned about your style
        </span>
        {learned.length > 0 ? (
          <button type="button" onClick={onClear} className={BUTTON}>
            Clear
          </button>
        ) : null}
      </div>
      {notes !== null && learned.length > 0 ? (
        <>
          <ul
            aria-labelledby={headingId}
            className="m-0 flex list-disc flex-col gap-0.5 pl-5 text-xs"
          >
            {learned.map((note) => (
              <li key={note}>{note}</li>
            ))}
          </ul>
          <p data-testid="voice-notes-updated" className="m-0 text-xs text-fg-muted">
            AI-made{notes.model === null ? '' : ` by ${notes.model}`}, updated{' '}
            {new Date(notes.updated).toLocaleDateString()}. Refreshed about every{' '}
            {VOICE_NOTES_REFRESH_WORDS.toLocaleString()} words you write.
          </p>
        </>
      ) : (
        <p className="m-0 text-xs text-fg-muted">
          {notes === null
            ? `Nothing yet. With the AI switch at Ask or Auto, MythScribe notes how you write once the manuscript holds ${VOICE_NOTES_MIN_WORDS.toLocaleString()} words.`
            : `Cleared. MythScribe learns again after about ${VOICE_NOTES_REFRESH_WORDS.toLocaleString()} more words.`}
        </p>
      )}
    </div>
  )
}

/** The report's scored documents, drifting ones first, with the skipped short scenes as one line. */
function ConsistencyList({
  report: result,
  onOpen
}: {
  report: VoiceConsistencyReport
  onOpen: (id: string) => void
}): React.JSX.Element {
  const scored = result.documents.filter((doc) => doc.status !== 'short')
  const ordered = [
    ...scored.filter((doc) => doc.status === 'drift'),
    ...scored.filter((doc) => doc.status === 'ok')
  ]
  const skipped = result.documents.length - scored.length
  return (
    <div data-testid="voice-consistency" className="flex flex-col gap-1">
      {ordered.length > 0 ? (
        <ul
          role="list"
          aria-label="Voice consistency"
          className="m-0 flex list-none flex-col gap-1.5 p-0"
        >
          {ordered.map((doc) => (
            <li
              key={doc.id}
              data-status={doc.status}
              className="flex min-w-0 flex-col gap-0.5 rounded-md border border-line px-2 py-1.5"
            >
              <div className="flex min-w-0 items-center justify-between gap-2">
                <button
                  type="button"
                  onClick={() => onOpen(doc.id)}
                  className="min-w-0 truncate text-left text-xs font-medium hover:underline"
                >
                  {doc.title}
                </button>
                <span
                  className={`shrink-0 text-xs ${doc.status === 'drift' ? 'text-warning' : 'text-fg-muted'}`}
                >
                  {doc.status === 'drift' ? 'Drifts' : 'Matches'} · {doc.wordCount.toLocaleString()}{' '}
                  words
                </span>
              </div>
              {doc.violations.length > 0 ? (
                <ul
                  aria-label={`Drift in ${doc.title}`}
                  className="m-0 flex list-disc flex-col gap-0.5 pl-5 text-xs"
                >
                  {doc.violations.map((violation) => (
                    <li key={violation}>{violation}</li>
                  ))}
                </ul>
              ) : null}
            </li>
          ))}
        </ul>
      ) : (
        <p className="m-0 text-xs text-fg-muted">
          Nothing to score yet: every scene is under {RULE_MIN_WORDS} words.
        </p>
      )}
      {skipped > 0 ? (
        <p data-testid="voice-consistency-skipped" className="m-0 text-xs text-fg-muted">
          {skipped === 1
            ? `1 scene under ${RULE_MIN_WORDS} words was skipped.`
            : `${skipped} scenes under ${RULE_MIN_WORDS} words were skipped.`}
        </p>
      ) : null}
    </div>
  )
}
