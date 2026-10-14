import { useState } from 'react'
import { isFeatureAllowed, needsSwitchText } from '@shared/aiSettings'
import type { LooseEnd } from '@shared/memory/views'
import { CONVERSATION_BUSY_MESSAGE, openAssistant } from '@renderer/features/ai/aiActions'
import { useAiSettingsStore } from '@renderer/features/ai/aiSettingsStore'
import { useAssistantStore } from '@renderer/features/ai/assistantStore'
import { useMemoryStore } from '@renderer/features/memory/memoryStore'
import { useAssistantName } from '@renderer/features/shell/viewStore'
import { looseEndKey, looseEndLine, looseEndsMore } from './looseEndView'

const SMALL =
  'rounded px-1.5 py-0.5 text-xs text-fg-muted hover:bg-surface-raised hover:text-fg disabled:opacity-40'

/**
 * Needs a look's **Loose ends** (F-16.29, design §2.7): threads, characters and planned cards left
 * behind the furthest drafted scene, each a scoped line composed here only ("Orrin: last named in
 * 6.2"), with *Ask Ms Scribe* (sends the loose end's own question, worded positively, through the
 * chat: in v2 Ms Scribe's navigator, `ai:navigate`; disabled with its reason while Ms Scribe is off
 * or the chat is answering) and *Not a problem* (a Dismissed row; a later touch brings it back);
 * "+ n more" past the first ten. Local and free; quiet, never required.
 */
export function LooseEnds({
  items,
  more
}: {
  items: readonly LooseEnd[]
  more: number
}): React.JSX.Element {
  const assistantName = useAssistantName()
  const settings = useAiSettingsStore((s) => s.settings)
  const busy = useAssistantStore((s) => {
    const active = s.conversations?.active ?? null
    return active !== null && s.pending[active] !== undefined
  })
  const ask = `Ask ${assistantName}`
  // F-16.25 (P3-D17): Ms Scribe is one switch (the answer, the navigator, the quote check),
  // named as the assistant in Settings.
  const off =
    settings === null ||
    !isFeatureAllowed(settings, 'agent') ||
    !isFeatureAllowed(settings, 'navigator')
  const reason = off
    ? `${needsSwitchText(ask)}, with ${assistantName} on (Settings, AI tab)`
    : busy
      ? CONVERSATION_BUSY_MESSAGE
      : null
  const footer = looseEndsMore(more)
  return (
    <>
      <ul className="m-0 list-none space-y-1 p-0 text-xs" data-testid="loose-ends">
        {items.map((end) => (
          <LooseEndRow key={looseEndKey(end)} end={end} ask={ask} reason={reason} />
        ))}
      </ul>
      {footer === null ? null : <p className="m-0 mt-1 text-xs text-fg-muted">{footer}</p>}
    </>
  )
}

function LooseEndRow({
  end,
  ask,
  reason
}: {
  end: LooseEnd
  ask: string
  reason: string | null
}): React.JSX.Element {
  const [busy, setBusy] = useState(false)
  const line = looseEndLine(end)
  return (
    <li className="rounded-md border border-line bg-surface px-2 py-1.5" data-testid="loose-end">
      <p className="m-0">{line}</p>
      <div className="mt-1 flex flex-wrap gap-1">
        <button
          type="button"
          className={SMALL}
          disabled={reason !== null}
          title={reason ?? end.ask}
          onClick={() => {
            openAssistant()
            // Its own message: a passage staged in the composer stays there.
            void useAssistantStore.getState().send(end.ask, {})
          }}
        >
          {ask}
        </button>
        <button
          type="button"
          className={SMALL}
          disabled={busy}
          aria-label={`Not a problem: ${line}`}
          onClick={() => {
            setBusy(true)
            void useMemoryStore
              .getState()
              .looseEndNotProblem(end)
              .finally(() => setBusy(false))
          }}
        >
          Not a problem
        </button>
      </div>
    </li>
  )
}
