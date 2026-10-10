import { useState } from 'react'
import { AI_DATA_SHARING, isFeatureAllowed } from '@shared/aiSettings'
import type { EntityTemplate } from '@shared/entities'
import type { Entity } from '@shared/ipc/contract'
import { useAiSettingsStore } from '@renderer/features/ai/aiSettingsStore'
import { toast } from '@renderer/features/shell/dialogs/dialogStore'
import { describeError } from '@renderer/lib/errors'
import { useSheetSyncStore } from './sheetSyncStore'

const BUTTON =
  'rounded-md border border-line px-2.5 py-1 text-xs hover:bg-surface-raised disabled:opacity-60 disabled:hover:bg-transparent'

/** What the view shown says when the other one moved since they agreed. */
const OUT_OF_DATE: Record<EntityTemplate, string> = {
  structured: 'These fields do not have your latest page edits yet.',
  blank: 'This page does not have your latest field edits yet.'
}

/** The button that brings the view shown up to date now. */
const RUN_LABEL: Record<EntityTemplate, string> = {
  structured: 'File now',
  blank: 'Write up now'
}

/**
 * F-9.18: how a sheet's view stands against the other one, over the fields or the page. Out of
 * date (with why: waiting out the pause, updating, failed with the cause and next step, or AI
 * off), and on the page, how much of it the AI wrote (provenance, AI rule 1). A sync lands on its
 * own in every chat mode, with an Undo in Changes. Nothing when the views agree.
 */
export function SheetSyncBar({
  entity,
  view
}: {
  entity: Entity
  view: EntityTemplate
}): React.JSX.Element | null {
  const status = useSheetSyncStore((s) => s.byId[entity.id])
  const settings = useAiSettingsStore((s) => s.settings)
  const [busy, setBusy] = useState(false)
  const allowed = settings !== null && isFeatureAllowed(settings, 'sheetSync')
  const { sync } = entity
  const stale =
    sync.state === 'both' ||
    (view === 'structured' ? sync.state === 'fieldsStale' : sync.state === 'pageStale')

  const act = async (task: () => Promise<unknown>): Promise<void> => {
    setBusy(true)
    try {
      await task()
    } catch (err) {
      toast.error(describeError(err))
    } finally {
      setBusy(false)
    }
  }

  const runNow = (): Promise<void> =>
    act(async () => {
      const queued = await useSheetSyncStore.getState().run(entity.id)
      if (!queued) {
        toast.info('Nothing to bring up to date, or no AI provider is set up in Settings › AI.')
      }
    })

  const provenance =
    view === 'blank' && sync.aiParagraphs > 0 ? (
      <p data-testid="sheet-provenance" className="m-0 text-xs text-fg-subtle">
        {sync.aiParagraphs === sync.paragraphs
          ? 'Written up by AI from your fields.'
          : `${sync.aiParagraphs} of ${sync.paragraphs} paragraphs written up by AI from your fields.`}{' '}
        Edit freely: your changes are filed back into the fields.
      </p>
    ) : null

  if (!stale) return provenance

  let detail: React.ReactNode
  if (!allowed) {
    detail = `Turn on Use AI and “${AI_DATA_SHARING.sheetSync.label}” in Settings › AI to keep both views in step.`
  } else if (status?.phase === 'running') {
    detail = 'Updating…'
  } else if (status?.phase === 'waiting') {
    detail = 'It updates once you have left this sheet alone for 30 seconds.'
  } else if (status?.phase === 'failed' && status.failure !== null) {
    detail = `Could not update: ${status.failure.message} ${status.failure.nextStep}`
  } else {
    detail = null
  }
  const canRun = allowed && status?.phase !== 'running' && status?.phase !== 'waiting'

  return (
    <section
      aria-label="Sheet sync"
      data-testid="sheet-sync-stale"
      className="flex flex-col gap-1.5 rounded-md border border-dashed border-line p-3 text-sm"
    >
      <p className="m-0">{OUT_OF_DATE[view]}</p>
      {detail === null ? null : <p className="m-0 text-xs text-fg-muted">{detail}</p>}
      {canRun ? (
        <div>
          <button type="button" disabled={busy} onClick={() => void runNow()} className={BUTTON}>
            {status?.phase === 'failed' ? 'Try again' : RUN_LABEL[view]}
          </button>
        </div>
      ) : null}
      {provenance}
    </section>
  )
}
