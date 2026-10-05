import { useEffect, useState } from 'react'
import {
  BACKUP_INTERVALS,
  BACKUP_KEEP_CHOICES,
  BackupInterval,
  BackupKeep,
  type BackupEntry
} from '@shared/backups'
import { describeError } from '@renderer/lib/errors'
import { useProjectStore } from '@renderer/features/project/projectStore'
import { dialogs } from '@renderer/features/shell/dialogs/dialogStore'
import { useShellDialogStore } from '@renderer/features/shell/shellDialogStore'
import { useBackupStore } from './backupStore'

const BUTTON =
  'shrink-0 rounded-md border border-line px-2 py-1 text-sm hover:bg-surface disabled:opacity-50 disabled:hover:bg-transparent'
const SELECT = 'rounded-md border border-line bg-bg px-2 py-1 text-sm disabled:opacity-50'

/** The one line that answers "can it sync to the cloud?": point it at a synced folder. */
const CLOUD_NOTE =
  'To keep a copy off this computer, choose a folder that Dropbox, OneDrive, iCloud Drive, or ' +
  'Google Drive syncs.'

/** What automatic means, so the author knows an untouched project does not fill the folder. */
const AUTO_NOTE =
  'Only a project that changed is backed up. Each backup is a zip of the whole project folder.'

function intervalLabel(minutes: number): string {
  if (minutes < 60) return `Every ${minutes} minutes`
  const hours = minutes / 60
  return hours === 1 ? 'Every hour' : `Every ${hours} hours`
}

const when = (iso: string): string =>
  new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })

function size(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/**
 * The Backups tab of the Settings dialog (F-8.4), app-wide so a backup can be restored from the
 * welcome screen. The settings (on/off, how often, on close, how many to keep, where) apply to
 * every project; the list and "Back up now" belong to the open project. Restoring never
 * overwrites anything: the backup opens as a new project next to the original.
 */
export function BackupsSettingsTab(): React.JSX.Element {
  const state = useBackupStore((s) => s.state)
  const busy = useBackupStore((s) => s.busy)
  const error = useBackupStore((s) => s.error)
  const load = useBackupStore((s) => s.load)
  const setSettings = useBackupStore((s) => s.setSettings)
  const chooseFolder = useBackupStore((s) => s.chooseFolder)
  const backUpNow = useBackupStore((s) => s.backUpNow)
  const reveal = useBackupStore((s) => s.reveal)
  const project = useProjectStore((s) => s.current)
  const projectBusy = useProjectStore((s) => s.busy)
  const restoreBackup = useProjectStore((s) => s.restoreBackup)
  const [restoreError, setRestoreError] = useState<string | null>(null)

  // `App` subscribes once and keeps the state current; this only covers the tab being opened
  // before that first answer arrived, and a project opened since (its list).
  const projectPath = project?.path ?? null
  useEffect(() => {
    void load()
  }, [load, projectPath])

  const settings = state?.settings ?? null
  const disabled = state === null || busy

  const restore = async (file?: string): Promise<void> => {
    setRestoreError(null)
    try {
      const info = await restoreBackup(file)
      if (info !== null) useShellDialogStore.getState().close()
    } catch (err: unknown) {
      setRestoreError(describeError(err))
    }
  }

  const restoreListed = async (entry: BackupEntry): Promise<void> => {
    const ok = await dialogs.confirm({
      title: 'Restore as a copy?',
      message:
        `The backup from ${when(entry.createdAt)} opens as a new project next to the original. ` +
        'Nothing is overwritten; the project you have open now stays as it is.',
      confirmLabel: 'Restore'
    })
    if (ok) await restore(entry.file)
  }

  return (
    <div className="flex flex-col gap-4 text-sm">
      <div className="flex flex-col gap-2">
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            data-testid="backups-enabled"
            checked={settings?.enabled ?? true}
            disabled={disabled}
            onChange={(event) => void setSettings({ enabled: event.target.checked })}
          />
          <span>Back up automatically</span>
        </label>
        <div className="flex flex-wrap items-center gap-3 pl-6">
          <select
            aria-label="How often"
            data-testid="backups-interval"
            value={settings?.intervalMinutes ?? 30}
            disabled={disabled || settings?.enabled === false}
            onChange={(event) => {
              const chosen = BackupInterval.safeParse(Number(event.target.value))
              if (chosen.success) void setSettings({ intervalMinutes: chosen.data })
            }}
            className={SELECT}
          >
            {BACKUP_INTERVALS.map((minutes) => (
              <option key={minutes} value={minutes}>
                {intervalLabel(minutes)}
              </option>
            ))}
          </select>
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              data-testid="backups-on-close"
              checked={settings?.onClose ?? true}
              disabled={disabled || settings?.enabled === false}
              onChange={(event) => void setSettings({ onClose: event.target.checked })}
            />
            <span>Also back up when the project closes</span>
          </label>
        </div>
        <p className="m-0 pl-6 text-xs text-fg-muted">{AUTO_NOTE}</p>
      </div>

      <label className="flex items-center gap-2">
        <span>Keep</span>
        <select
          aria-label="Backups to keep"
          data-testid="backups-keep"
          value={settings?.keep ?? 10}
          disabled={disabled}
          onChange={(event) => {
            const chosen = BackupKeep.safeParse(Number(event.target.value))
            if (chosen.success) void setSettings({ keep: chosen.data })
          }}
          className={SELECT}
        >
          {BACKUP_KEEP_CHOICES.map((keep) => (
            <option key={keep} value={keep}>
              {keep}
            </option>
          ))}
        </select>
        <span className="text-fg-muted">backups per project; older ones are deleted</span>
      </label>

      <section aria-label="Backup folder" className="flex flex-col gap-1.5">
        <h3 className="m-0 text-sm font-medium">Location</h3>
        <span data-testid="backups-folder" className="break-all text-xs">
          {state?.folder ?? ''}
        </span>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            disabled={disabled}
            onClick={() => void chooseFolder()}
            className={BUTTON}
          >
            Change…
          </button>
          <button
            type="button"
            disabled={disabled || settings?.folder === null}
            onClick={() => void setSettings({ folder: null })}
            className={BUTTON}
          >
            Use default
          </button>
          <button
            type="button"
            disabled={disabled}
            onClick={() => void reveal()}
            className={BUTTON}
          >
            Open folder
          </button>
        </div>
        <p className="m-0 text-xs text-fg-muted">{CLOUD_NOTE}</p>
      </section>

      <section aria-label="This project's backups" className="flex flex-col gap-2">
        <div className="flex items-center justify-between gap-3">
          <h3 className="m-0 text-sm font-medium">This project</h3>
          <button
            type="button"
            disabled={disabled || project === null}
            onClick={() => void backUpNow()}
            className={BUTTON}
          >
            Back up now
          </button>
        </div>
        {project === null ? (
          <p className="m-0 text-xs text-fg-muted">Open a project to see its backups.</p>
        ) : (state?.backups.length ?? 0) === 0 ? (
          <p className="m-0 text-xs text-fg-muted">No backups of this project yet.</p>
        ) : (
          <ul
            aria-label="Backups"
            className="m-0 flex max-h-48 list-none flex-col overflow-auto p-0"
          >
            {state?.backups.map((entry) => (
              <li
                key={entry.file}
                data-testid="backup-row"
                className="flex items-center justify-between gap-3 border-b border-line py-1 last:border-b-0"
              >
                <span className="min-w-0 truncate">{when(entry.createdAt)}</span>
                <span className="ml-auto shrink-0 text-xs text-fg-muted">{size(entry.bytes)}</span>
                <button
                  type="button"
                  aria-label={`Restore the backup from ${when(entry.createdAt)}`}
                  disabled={busy || projectBusy}
                  onClick={() => void restoreListed(entry)}
                  className={BUTTON}
                >
                  Restore
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <div className="flex items-center gap-3 border-t border-line pt-3">
        <button
          type="button"
          disabled={busy || projectBusy}
          onClick={() => void restore()}
          className={BUTTON}
        >
          Restore from a backup file…
        </button>
        <span className="text-xs text-fg-muted">
          Opens as a new project; nothing is overwritten.
        </span>
      </div>

      {state?.lastError ? (
        <p role="alert" data-testid="backups-last-error" className="m-0 text-xs text-danger">
          {`The last automatic backup failed: ${state.lastError}`}
        </p>
      ) : null}
      {error === null ? null : (
        <p role="alert" className="m-0 text-xs text-danger">
          {error}
        </p>
      )}
      {restoreError === null ? null : (
        <p role="alert" className="m-0 text-xs text-danger">
          {restoreError}
        </p>
      )}
    </div>
  )
}
