import { useEffect, useState } from 'react'
import { Cloud, CloudOff } from 'lucide-react'
import { cloudSyncExplainer, describeCloudSync } from '@shared/cloudSync'
import { useCloudSyncStore } from './cloudSyncStore'

/** How often "2 min ago" is redrawn. */
const REDRAW_MS = 30_000

/**
 * One quiet line in the status bar for a project in a cloud-synced folder (2026-10-08):
 * "Copied to Google Drive 2 min ago", "Copying to Google Drive…", or the failure, with what the
 * arrangement is in the tooltip. Nothing for a project in a plain folder.
 */
export function CloudSyncLine(): React.JSX.Element | null {
  const status = useCloudSyncStore((s) => s.status)
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    if (status === null) return
    const timer = setInterval(() => setNow(new Date()), REDRAW_MS)
    return () => clearInterval(timer)
  }, [status])
  if (status === null) return null
  const failed = status.state === 'failed'
  const Icon = failed ? CloudOff : Cloud
  return (
    <span
      data-testid="status-cloud"
      title={cloudSyncExplainer(status)}
      className={`flex items-center gap-1 ${failed ? 'text-danger' : ''}`}
    >
      <Icon size={12} aria-hidden="true" />
      {describeCloudSync(status, now)}
    </span>
  )
}
