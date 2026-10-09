import { useEffect, useId, useRef, type KeyboardEvent } from 'react'
import type { KnowledgeConversion } from '@shared/knowledge'
import { formatCount } from '@renderer/features/ai/usageFormat'
import { AI_WAIT_CLASS } from '@renderer/features/ai/aiWaitPhrases'
import { toast } from '@renderer/features/shell/dialogs/dialogStore'
import { describeError } from '@renderer/lib/errors'
import { conversionAsks, useConversionStore } from './conversionStore'
import { costLine } from './conversionText'

/**
 * The conversion dialog (F-9.14, D11): on open, when scenes an earlier version read are waiting,
 * it says how many, what one more reading of them costs on the configured model, and how long,
 * and offers Update now or Later. Update now makes a full backup first (the Settings › Backups
 * path) and then re-reads the scenes in the background; Later (or Escape) closes it until the
 * project opens again, and those scenes stay as they are meanwhile. With Use AI off it never
 * shows.
 */
export function ConversionDialog(): React.JSX.Element | null {
  const conversion = useConversionStore((s) => s.conversion)
  if (conversion === null || !conversionAsks(conversion)) return null
  return <ConversionDialogBody conversion={conversion} />
}

function ConversionDialogBody({
  conversion
}: {
  conversion: KnowledgeConversion
}): React.JSX.Element {
  const titleId = useId()
  const converting = useConversionStore((s) => s.converting)
  const first = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    first.current?.focus()
  }, [])

  const later = (): void => {
    useConversionStore
      .getState()
      .later()
      .catch((err: unknown) => toast.error(describeError(err)))
  }
  const convert = (): void => {
    useConversionStore
      .getState()
      .convert()
      .catch((err: unknown) => toast.error(describeError(err)))
  }
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'Escape' && !converting) {
      event.stopPropagation()
      later()
    }
  }
  const minutes = formatCount(conversion.minutes, 'minute')

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-overlay">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        data-testid="conversion-dialog"
        onKeyDown={onKeyDown}
        className="flex w-[440px] max-w-[92vw] flex-col gap-3 rounded-lg border border-line bg-surface-raised px-5 py-4 shadow-panel"
      >
        <h2 id={titleId} className="m-0 text-lg font-semibold">
          Update your story index
        </h2>
        <p className="m-0 text-sm">
          MythScribe now keeps a card for every scene, the relationships between your characters,
          places, and things, and your plot threads. {formatCount(conversion.scenes, 'scene')}{' '}
          {conversion.scenes === 1
            ? 'was read by an earlier version and needs one more reading.'
            : 'were read by an earlier version and need one more reading.'}
        </p>
        <ul role="list" className="m-0 flex list-disc flex-col gap-1 pl-5 text-sm">
          <li data-testid="conversion-cost">{costLine(conversion)}</li>
          <li>About {minutes} in the background; you can keep writing.</li>
          <li>A full backup is made first. Your scene text is never changed.</li>
        </ul>
        <div className="flex justify-end gap-2">
          <button
            ref={first}
            type="button"
            disabled={converting}
            onClick={later}
            className="rounded-md border border-line px-3 py-1.5 text-sm hover:bg-surface disabled:opacity-60"
          >
            Later
          </button>
          <button
            type="button"
            disabled={converting}
            onClick={convert}
            className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-accent-fg hover:bg-accent-hover disabled:opacity-50"
          >
            {converting ? <span className={AI_WAIT_CLASS}>Backing up…</span> : 'Update now'}
          </button>
        </div>
      </div>
    </div>
  )
}
