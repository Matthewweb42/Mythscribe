import { X } from 'lucide-react'
import type { RecentProject } from '@shared/ipc/contract'
import { PROJECT_FORMATS } from './formats'

function formatLabel(id: RecentProject['format']): string {
  return PROJECT_FORMATS.find((f) => f.id === id)?.label ?? id
}

function formatLastOpened(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
}

/** The welcome screen's recent-projects list (F-1.1). Renders nothing when there are no recents. */
export function RecentProjects({
  recents,
  busy,
  onOpen,
  onRemove
}: {
  recents: RecentProject[]
  busy: boolean
  onOpen: (path: string) => void
  onRemove: (path: string) => void
}): React.JSX.Element | null {
  if (recents.length === 0) return null
  return (
    <div className="mt-3 w-full text-left">
      <h2 className="m-0 mb-2 text-xs font-medium tracking-wide text-fg-muted uppercase">
        Recent projects
      </h2>
      <ul aria-label="Recent projects" className="m-0 flex list-none flex-col gap-1 p-0">
        {recents.map((r) => (
          <li
            key={r.path}
            className={`flex items-stretch gap-1 rounded-md border border-line bg-surface ${r.exists ? '' : 'opacity-60'}`}
          >
            <button
              type="button"
              aria-label={r.name}
              disabled={busy}
              onClick={() => onOpen(r.path)}
              className="flex min-w-0 flex-1 flex-col gap-0.5 rounded-l-md px-3 py-2 text-left hover:bg-surface-raised disabled:opacity-60"
            >
              <span className="flex items-center gap-2 text-sm">
                <span className="truncate font-medium">{r.name}</span>
                <span className="text-xs text-fg-muted">{formatLabel(r.format)}</span>
                {r.exists ? null : (
                  <span className="rounded border border-warning px-1 text-[10px] text-warning">
                    Not found
                  </span>
                )}
                <span className="ml-auto text-xs whitespace-nowrap text-fg-subtle">
                  {formatLastOpened(r.lastOpened)}
                </span>
              </span>
              <span className="font-mono text-xs break-all text-fg-muted">{r.path}</span>
            </button>
            <button
              type="button"
              aria-label={`Remove ${r.name} from recent projects`}
              disabled={busy}
              onClick={() => onRemove(r.path)}
              className="px-2 text-fg-muted hover:text-fg disabled:opacity-60"
            >
              <X size={14} />
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
}
