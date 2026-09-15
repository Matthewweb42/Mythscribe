import { useEffect, useId, useState } from 'react'
import { useTreeStore } from '@renderer/features/manuscript/treeStore'
import { toast } from '@renderer/features/shell/dialogs/dialogStore'
import { describeError } from '@renderer/lib/errors'
import { useProvenanceStore } from './provenanceStore'

const BUTTON =
  'shrink-0 rounded-md border border-line px-2 py-1 text-xs hover:bg-surface disabled:opacity-50 disabled:hover:bg-transparent'

const report = (err: unknown): void => {
  toast.error(describeError(err))
}

const chars = (n: number): string => `${n.toLocaleString()} ${n === 1 ? 'character' : 'characters'}`

/**
 * The "Provenance" section of the AI tab (F-14.6), under the voice profile: how much of the
 * manuscript is AI-origin text (accepted from a proposal and not yet rewritten past the
 * threshold), the scenes that carry any, and the disclosure export. The report is loaded on
 * mount (local, from the saved documents) and nothing renders until it lands; a scene title
 * selects that scene in the tree. Export asks for a path through the OS save dialog and
 * toasts where the file went; a cancelled dialog says nothing.
 */
export function ProvenanceSection(): React.JSX.Element | null {
  const ledger = useProvenanceStore((s) => s.report)
  const load = useProvenanceStore((s) => s.load)
  const exportReport = useProvenanceStore((s) => s.exportReport)
  const select = useTreeStore((s) => s.select)
  const [exporting, setExporting] = useState(false)
  const headingId = useId()

  useEffect(() => {
    load().catch(report)
  }, [load])

  const doExport = (): void => {
    setExporting(true)
    exportReport()
      .then((path) => {
        if (path !== null) toast.success(`Saved to ${path}`)
      })
      .catch(report)
      .finally(() => setExporting(false))
  }

  if (ledger === null) return null
  const scenes = ledger.documents.filter((doc) => doc.aiChars > 0)

  return (
    <section
      aria-labelledby={headingId}
      data-testid="provenance-section"
      className="flex min-w-0 flex-col gap-3"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 id={headingId} className="m-0 text-sm font-medium">
          Provenance
        </h3>
        <button type="button" onClick={doExport} disabled={exporting} className={BUTTON}>
          Export disclosure report
        </button>
      </div>
      <p className="m-0 text-xs text-fg-muted">
        Text you accepted from the AI keeps a mark tied to its proposal until you have rewritten
        more than half of it. Counted here from your saved scenes, on this machine.
      </p>

      {scenes.length === 0 ? (
        <p data-testid="provenance-empty" className="m-0 text-xs text-fg-muted">
          Nothing accepted from the AI yet.
        </p>
      ) : (
        <>
          <p data-testid="provenance-percent" className="m-0">
            <span className="font-medium tabular-nums">{ledger.projectPercent}%</span> of the
            manuscript is AI-origin ({chars(ledger.aiChars)} of {chars(ledger.totalChars)}).
          </p>
          <ul
            role="list"
            aria-label="AI origin by scene"
            className="m-0 flex list-none flex-col gap-1.5 p-0"
          >
            {scenes.map((doc) => (
              <li
                key={doc.id}
                data-testid="provenance-scene"
                data-id={doc.id}
                className="flex min-w-0 items-center justify-between gap-2 rounded-md border border-line px-2 py-1.5"
              >
                <button
                  type="button"
                  onClick={() => select(doc.id)}
                  className="min-w-0 truncate text-left text-xs font-medium hover:underline"
                >
                  {doc.title}
                </button>
                <span className="shrink-0 text-xs text-fg-muted tabular-nums">
                  {doc.percent}% AI · {chars(doc.aiChars)} ·{' '}
                  {doc.proposals === 1 ? '1 proposal' : `${doc.proposals} proposals`}
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  )
}
