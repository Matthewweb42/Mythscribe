import { useMemo, useState } from 'react'
import { Loader2, Sparkles } from 'lucide-react'
import { isFeatureAllowed } from '@shared/aiSettings'
import { docToText } from '@shared/docText'
import { BRIEF_TEXT_MIN } from '@shared/sceneMeta'
import { SCENE_SUGGEST_TEXT_MIN } from '@shared/sceneSuggest'
import { openAssistant } from '@renderer/features/ai/aiActions'
import { useAiSettingsStore } from '@renderer/features/ai/aiSettingsStore'
import { RequestCost } from '@renderer/features/ai/RequestCost'
import { useTreeStore } from '@renderer/features/manuscript/treeStore'
import { useBriefDraftStore } from './briefDraftStore'
import { useDocumentStore } from './documentStore'
import { useSceneSuggestStore, type SuggestionCost, type SuggestionKind } from './sceneSuggestStore'

const SUGGEST_BUTTON =
  'flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-xs text-fg-muted hover:bg-surface-raised hover:text-fg disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-fg-muted'
const LINK_BUTTON = 'rounded px-1 text-xs text-fg-muted hover:bg-surface-raised hover:text-fg'
const PRIMARY_LINK = 'rounded px-1 text-xs font-medium text-accent hover:bg-surface-raised'
const CARD = 'flex flex-col gap-1 rounded-md border border-dashed border-accent/60 p-1.5'

const FEATURE: Record<SuggestionKind, 'synopsis' | 'notesSuggest'> = {
  synopsis: 'synopsis',
  notes: 'notesSuggest'
}

/**
 * The small Suggest button beside the Synopsis label and the Notes heading (F-5.20): asks for a
 * suggested synopsis or key points for node `id`, shown under the box for the author to accept.
 * Not rendered at all while the dial or the feature's toggle forbids it, or for anything but a
 * manuscript document; disabled with the reason while the scene is too short or a suggestion is
 * on its way.
 */
export function SuggestButton({
  id,
  kind,
  compact = false
}: {
  id: string
  kind: SuggestionKind
  /** Icon only (the notes column's heading is narrow); the label stays as the accessible name. */
  compact?: boolean
}): React.JSX.Element | null {
  const settings = useAiSettingsStore((s) => s.settings)
  const scene = useTreeStore(
    (s) => s.byId[id]?.kind === 'document' && s.sectionOf[id] === 'manuscript'
  )
  const content = useDocumentStore((s) => s.docs[id]?.content ?? null)
  const length = useMemo(() => (content ? docToText(content).length : null), [content])
  const pending = useSceneSuggestStore((s) => s[kind][id]?.status === 'pending')
  if (!scene || settings === null || !isFeatureAllowed(settings, FEATURE[kind])) return null
  let reason: string | null = null
  if (pending) reason = 'A suggestion is already on the way'
  else if (length !== null && length < SCENE_SUGGEST_TEXT_MIN) {
    reason = `Write ${SCENE_SUGGEST_TEXT_MIN} characters first`
  }
  const what = kind === 'synopsis' ? 'a synopsis' : 'key points for the notes'
  return (
    <button
      type="button"
      data-testid={`suggest-${kind}`}
      aria-label={kind === 'synopsis' ? 'Suggest synopsis' : 'Suggest notes'}
      disabled={reason !== null}
      title={reason ?? `Suggest ${what} from the scene, to accept or dismiss`}
      onClick={() => {
        const store = useSceneSuggestStore.getState()
        if (kind === 'synopsis') store.suggestSynopsis(id)
        else store.suggestNotes(id, null)
      }}
      className={SUGGEST_BUTTON}
    >
      {pending ? (
        <Loader2 size={12} aria-hidden="true" className="animate-spin" />
      ) : (
        <Sparkles size={12} aria-hidden="true" />
      )}
      {compact ? null : 'Suggest'}
    </button>
  )
}

/**
 * The small Draft button beside the Brief disclosure (F-14.3; since the 2026-10-06 panel polish
 * removed the assistant's Actions menu, the one way to draft a brief): asks for a brief of node
 * `id`, which shows in the assistant panel's results for the author to use or discard. Hidden
 * like `SuggestButton` while the dial or the toggle forbids it or for anything but a manuscript
 * document; disabled with the reason while the scene is too short or a draft is on its way.
 */
export function BriefDraftButton({ id }: { id: string }): React.JSX.Element | null {
  const settings = useAiSettingsStore((s) => s.settings)
  const scene = useTreeStore(
    (s) => s.byId[id]?.kind === 'document' && s.sectionOf[id] === 'manuscript'
  )
  const content = useDocumentStore((s) => s.docs[id]?.content ?? null)
  const length = useMemo(() => (content ? docToText(content).length : null), [content])
  const pending = useBriefDraftStore((s) => s.draft?.status === 'pending')
  if (!scene || settings === null || !isFeatureAllowed(settings, 'brief')) return null
  let reason: string | null = null
  if (pending) reason = 'A brief draft is already on the way'
  else if (length !== null && length < BRIEF_TEXT_MIN) {
    reason = `Write ${BRIEF_TEXT_MIN} characters first`
  }
  return (
    <button
      type="button"
      data-testid="draft-brief"
      aria-label="Draft scene brief"
      disabled={reason !== null}
      title={reason ?? 'Draft the brief from the scene, shown in the assistant to use or discard'}
      onClick={() => {
        useBriefDraftStore.getState().start(id)
        openAssistant()
      }}
      className={SUGGEST_BUTTON}
    >
      {pending ? (
        <Loader2 size={12} aria-hidden="true" className="animate-spin" />
      ) : (
        <Sparkles size={12} aria-hidden="true" />
      )}
      Draft
    </button>
  )
}

/** The pending line with Cancel, or an expected failure with its next step and Dismiss. */
function Waiting({
  kind,
  id,
  status
}: {
  kind: SuggestionKind
  id: string
  status: { status: 'pending' } | { status: 'error'; message: string; nextStep: string }
}): React.JSX.Element {
  const store = useSceneSuggestStore.getState()
  if (status.status === 'pending') {
    return (
      <p role="status" className="m-0 flex items-center gap-2 text-xs text-fg-muted">
        <span>{kind === 'synopsis' ? 'Suggesting a synopsis…' : 'Suggesting notes…'}</span>
        <button type="button" onClick={() => store.cancel(kind, id)} className={LINK_BUTTON}>
          Cancel
        </button>
      </p>
    )
  }
  return (
    <p
      role="status"
      data-testid={`suggest-${kind}-error`}
      className="m-0 flex flex-wrap items-center gap-2 text-xs text-danger"
    >
      <span>
        {status.message} {status.nextStep}
      </span>
      <button type="button" onClick={() => store.dismiss(kind, id)} className={LINK_BUTTON}>
        Dismiss
      </button>
    </p>
  )
}

/** The cost line of a suggestion, with the head-cut note when the scene was cut. */
function CostLine({ cost }: { cost: SuggestionCost }): React.JSX.Element {
  return (
    <span data-testid="suggest-cost" className="text-xs text-fg-subtle">
      <RequestCost request={cost} />
      {cost.truncated ? ' · from the opening of the scene' : ''}
    </span>
  )
}

/**
 * The suggested synopsis under the Synopsis box (F-5.20): marked as AI-made, with its cost,
 * Accept (writes it into the box through the scene-metadata store, replacing what is there) and
 * Dismiss. Nothing while there is no suggestion for `id`.
 */
export function SynopsisSuggestion({ id }: { id: string }): React.JSX.Element | null {
  const suggestion = useSceneSuggestStore((s) => s.synopsis[id] ?? null)
  if (suggestion === null) return null
  if (suggestion.status !== 'ready') {
    return <Waiting kind="synopsis" id={id} status={suggestion} />
  }
  const store = useSceneSuggestStore.getState()
  return (
    <div role="group" aria-label="Suggested synopsis" className={CARD}>
      <p className="m-0 text-xs font-medium text-accent">Suggested by AI</p>
      <p data-testid="suggested-synopsis" className="m-0 text-sm whitespace-pre-wrap">
        {suggestion.value}
      </p>
      <p className="m-0 flex flex-wrap items-center gap-2">
        <CostLine cost={suggestion} />
        <button
          type="button"
          onClick={() => void store.acceptSynopsis(id)}
          className={PRIMARY_LINK}
        >
          Accept
        </button>
        <button type="button" onClick={() => store.dismiss('synopsis', id)} className={LINK_BUTTON}>
          Dismiss
        </button>
      </p>
    </div>
  )
}

/**
 * The suggested key points over the notes (F-5.20): one checkbox each (all ticked), Add to notes
 * (appends the ticked points to the notes, one "• " line each) and
 * Dismiss. Nothing while there is no suggestion for `id`.
 */
export function NotesSuggestion({ id }: { id: string }): React.JSX.Element | null {
  const suggestion = useSceneSuggestStore((s) => s.notes[id] ?? null)
  if (suggestion === null) return null
  if (suggestion.status !== 'ready') {
    return (
      <div className="shrink-0 px-4 pb-2">
        <Waiting kind="notes" id={id} status={suggestion} />
      </div>
    )
  }
  return (
    <div className="shrink-0 px-4 pb-2">
      <PointsCard key={suggestion.proposalId} id={id} points={suggestion.value} cost={suggestion} />
    </div>
  )
}

function PointsCard({
  id,
  points,
  cost
}: {
  id: string
  points: readonly string[]
  cost: SuggestionCost
}): React.JSX.Element {
  const [picked, setPicked] = useState<readonly number[]>(() => points.map((_, index) => index))
  const store = useSceneSuggestStore.getState()
  const toggle = (index: number): void =>
    setPicked((current) =>
      current.includes(index) ? current.filter((i) => i !== index) : [...current, index]
    )
  return (
    <div role="group" aria-label="Suggested notes" className={CARD}>
      <p className="m-0 text-xs font-medium text-accent">Suggested by AI</p>
      {points.length === 0 ? (
        <p className="m-0 text-xs text-fg-muted">No key points came back. Try again.</p>
      ) : (
        <ul className="m-0 flex list-none flex-col gap-0.5 p-0">
          {points.map((point, index) => (
            <li key={`${index}-${point}`}>
              <label className="flex items-start gap-1.5 text-sm">
                <input
                  type="checkbox"
                  data-testid="suggested-note"
                  checked={picked.includes(index)}
                  onChange={() => toggle(index)}
                  className="mt-1 shrink-0"
                />
                <span>{point}</span>
              </label>
            </li>
          ))}
        </ul>
      )}
      <p className="m-0 flex flex-wrap items-center gap-2">
        <CostLine cost={cost} />
        <button
          type="button"
          disabled={picked.length === 0}
          onClick={() => void store.addNotes(id, picked)}
          className={`${PRIMARY_LINK} disabled:opacity-40`}
        >
          Add to notes
        </button>
        <button type="button" onClick={() => store.dismiss('notes', id)} className={LINK_BUTTON}>
          Dismiss
        </button>
      </p>
    </div>
  )
}
