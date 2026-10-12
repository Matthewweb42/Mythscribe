import { useEffect, useState } from 'react'
import type { ClaimInfo } from '@shared/memory/views'
import { openPassage } from '@renderer/features/editor/openPassage'
import { locateText } from '@renderer/features/editor/locateText'
import { toast } from '@renderer/features/shell/dialogs/dialogStore'
import { describeError } from '@renderer/lib/errors'
import { ipc } from '@renderer/lib/ipc'
import { claimInfoLines } from './memoryView'

const SMALL =
  'rounded px-1.5 py-0.5 text-xs text-fg-muted hover:bg-surface-raised hover:text-fg disabled:opacity-40'

/**
 * ⓘ on an AI line (F-16.18): the quote the line rests on with *Go there* (opens the scene and
 * selects the quote; a quote no longer there says so), where and when the AI read it, how it was
 * proved ("quote checked in code" or "checked by a second AI read"), its spot check, and what that
 * reading cost. Read from main when it opens (`memory:claim`).
 */
export function ClaimInfoCard({ claimId }: { claimId: string }): React.JSX.Element {
  const [info, setInfo] = useState<ClaimInfo | null | undefined>(undefined)
  useEffect(() => {
    let live = true
    ipc()
      .invoke('memory:claim', { claimId })
      .then((answer) => {
        if (live) setInfo(answer)
      })
      .catch((err: unknown) => {
        if (live) toast.error(describeError(err))
      })
    return () => {
      live = false
    }
  }, [claimId])

  if (info === undefined) {
    return <p className="m-0 mt-1 text-xs text-fg-muted">Reading…</p>
  }
  if (info === null) {
    return <p className="m-0 mt-1 text-xs text-fg-muted">This line is no longer in the memory.</p>
  }
  const { claim } = info
  const goThere = (): void => {
    openPassage(claim.nodeId, (doc) => locateText(doc, claim.quote)).catch((err: unknown) =>
      toast.error(describeError(err))
    )
  }
  return (
    <div
      role="group"
      aria-label="Where this line comes from"
      data-testid="claim-info"
      className="mt-1 w-full rounded-md border border-line bg-surface px-2 py-1.5 text-xs"
    >
      <div className="flex items-start gap-1">
        <q className="min-w-0 flex-1 text-fg">{claim.quote}</q>
        <button type="button" className={SMALL} onClick={goThere}>
          Go there
        </button>
      </div>
      <ul className="m-0 mt-1 list-none p-0 text-fg-muted">
        {claimInfoLines(info).map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
    </div>
  )
}
