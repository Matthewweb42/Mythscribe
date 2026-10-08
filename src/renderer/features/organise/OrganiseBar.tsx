import { useEffect } from 'react'
import { Sparkles } from 'lucide-react'
import { isFeatureAllowed } from '@shared/aiSettings'
import { describeCandidates } from '@shared/organise'
import { useAiSettingsStore } from '@renderer/features/ai/aiSettingsStore'
import { useEntityStore } from '@renderer/features/entities/entityStore'
import { useTagStore } from '@renderer/features/tags/tagStore'
import { offerShowing, useOrganiseStore } from './organiseStore'

/** How long the tags and sheets must sit still before the local pass looks again. */
const SETTLE_MS = 1_500

/**
 * The Organise button and its quiet offer (F-9.10), at the top of the Tags section and of every
 * story-bible section. The button asks the AI for a plan of everything; the offer shows only
 * when the local pass finds likely duplicates or a few loose ends (unused tags, empty sheets), and
 * opening it runs the same plan. "Not now" hides it until the findings change. Nothing is ever
 * applied from here; both need Use AI on (and Organise's own toggle).
 */
export function OrganiseBar(): React.JSX.Element | null {
  const settings = useAiSettingsStore((s) => s.settings)
  const allowed = settings !== null && isFeatureAllowed(settings, 'organise')
  const tagCount = useTagStore((s) => s.ids.length)
  const sheetCount = useEntityStore((s) => s.ids.length)
  const showing = useOrganiseStore(offerShowing)
  const candidates = useOrganiseStore((s) => s.candidates)
  const running = useOrganiseStore((s) => s.phase === 'running')
  const start = useOrganiseStore((s) => s.start)
  const dismiss = useOrganiseStore((s) => s.dismissOffer)

  useEffect(() => {
    if (!allowed) return undefined
    const timer = window.setTimeout(() => {
      void useOrganiseStore.getState().refreshCandidates()
    }, SETTLE_MS)
    return () => window.clearTimeout(timer)
  }, [allowed, tagCount, sheetCount])

  if (!allowed) return null
  const begin = (): void => {
    void start({ instruction: '', scope: [] })
  }
  return (
    <div className="shrink-0 px-2 pt-2">
      {showing && candidates !== null ? (
        <div
          role="status"
          data-testid="organise-offer"
          className="mb-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 rounded-md border border-line bg-surface-raised px-2 py-1 text-xs text-fg-muted"
        >
          <span className="min-w-0 flex-1">Organise? {describeCandidates(candidates)}.</span>
          <button type="button" className="text-accent hover:underline" onClick={begin}>
            Review
          </button>
          <button type="button" className="hover:text-fg hover:underline" onClick={dismiss}>
            Not now
          </button>
        </div>
      ) : null}
      <button
        type="button"
        data-testid="organise-button"
        disabled={running}
        title="Let the AI propose a tidier story bible: merge duplicates, fix categories, fill and tidy sheets, sort notes. You review every change; scene text is never rewritten."
        onClick={begin}
        className="flex w-full items-center justify-center gap-1.5 rounded-md border border-line px-2 py-1 text-xs text-fg-muted hover:bg-surface-raised hover:text-fg disabled:opacity-60"
      >
        <Sparkles size={12} aria-hidden="true" /> Organise…
      </button>
    </div>
  )
}
