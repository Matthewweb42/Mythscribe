import { create } from 'zustand'
import {
  CLOUD_PROVIDER_LABEL,
  CloudConflict,
  formatBytes,
  type CloudSide,
  type CloudSyncStatus,
  type CloudVersion
} from '@shared/cloudSync'
import { describeError } from '@renderer/lib/errors'
import { IpcRequestError, ipc } from '@renderer/lib/ipc'
import { dialogs, toast } from '@renderer/features/shell/dialogs/dialogStore'

/**
 * The renderer's view of the working copy of a project in a cloud-synced folder (2026-10-08).
 * Main owns the copy and its schedule; this store holds the status main last answered or pushed
 * (`project:cloudSyncChanged`) for the status bar, and toasts a conflict copy once.
 */
interface CloudSyncStoreState {
  /** null for a project in a plain folder, or before the first load. */
  status: CloudSyncStatus | null
  load: () => Promise<void>
  /** Loads once and listens for what main pushes; returns the unsubscribe. */
  subscribe: () => () => void
}

/** The conflict copy already announced, so a later status push does not toast it again. */
let announcedConflict: string | null = null

function fileName(file: string): string {
  return file.split(/[\\/]/).pop() ?? file
}

export const useCloudSyncStore = create<CloudSyncStoreState>((set) => {
  const receive = (status: CloudSyncStatus | null): void => {
    const conflict = status?.conflictCopy ?? null
    if (status !== null && conflict !== null && conflict !== announcedConflict) {
      announcedConflict = conflict
      const label = CLOUD_PROVIDER_LABEL[status.provider]
      const name = fileName(conflict)
      if (status.conflictCopyHolds === 'computer') {
        toast.info(
          `${label}'s version is open. The version from this computer is kept beside it as "${name}".`
        )
      } else {
        toast.warning(
          `${label} had a different version of this project. Yours stays open; the other is kept beside it as "${name}".`
        )
      }
    }
    set({ status })
  }
  return {
    status: null,

    async load() {
      try {
        receive(await ipc().invoke('project:cloudSyncStatus', undefined))
      } catch {
        set({ status: null })
      }
    },

    subscribe() {
      const off = ipc().on('project:cloudSyncChanged', receive)
      void useCloudSyncStore.getState().load()
      return off
    }
  }
})

/**
 * Before the project closes (or another replaces it), copies it to its cloud folder and, when
 * that fails, tells the author the cloud copy is behind and offers Retry. Choosing to go on
 * anyway is safe: the working copy keeps the changes and the next open here copies them. A
 * project in a plain folder answers at once.
 */
export async function confirmCloudCopy(going: 'close' | 'switch'): Promise<void> {
  for (;;) {
    let status: CloudSyncStatus | null
    try {
      status = await ipc().invoke('project:cloudSyncNow', undefined)
    } catch (err) {
      toast.error(describeError(err))
      return
    }
    if (status?.state !== 'failed') return
    const label = CLOUD_PROVIDER_LABEL[status.provider]
    const goOn = await dialogs.confirm({
      title: `${label} does not have your latest changes`,
      message: `${status.error ?? 'The copy failed.'} Your changes are safe on this computer and are copied to ${label} the next time you open this project here. Until then, ${label} has an older version.`,
      confirmLabel: going === 'close' ? 'Close anyway' : 'Continue anyway',
      cancelLabel: 'Retry',
      danger: true
    })
    if (goOn) return
  }
}

/** The conflict an open was refused for (`CLOUD_CONFLICT`), or null for any other failure. */
export function cloudConflictOf(err: unknown): CloudConflict | null {
  if (!(err instanceof IpcRequestError) || err.code !== 'CLOUD_CONFLICT') return null
  const parsed = CloudConflict.safeParse(err.details)
  return parsed.success ? parsed.data : null
}

function describeVersion(version: CloudVersion): string {
  const when = new Date(version.modifiedAt).toLocaleString(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short'
  })
  return `changed ${when}, ${formatBytes(version.bytes)}`
}

/**
 * Asks which version of a cloud project to keep when both changed (the author's decision
 * 2026-10-10). The newer one is the highlighted answer. Null = Cancel: nothing was opened or
 * changed. The version not kept is saved beside the project by main, so neither answer loses work.
 */
export async function chooseCloudVersion(conflict: CloudConflict): Promise<CloudSide | null> {
  const label = CLOUD_PROVIDER_LABEL[conflict.provider]
  const newer: CloudSide =
    Date.parse(conflict.cloud.modifiedAt) > Date.parse(conflict.computer.modifiedAt)
      ? 'cloud'
      : 'computer'
  return dialogs.choose<CloudSide>({
    title: 'Which version do you want to keep?',
    message: `"${fileName(conflict.folder).replace(/\.mythscribe$/i, '')}" changed on this computer and in ${label} since they last matched. The version you do not keep is saved beside the project as a conflict copy, so nothing is lost.`,
    details: [
      `This computer: ${describeVersion(conflict.computer)}`,
      `${label}: ${describeVersion(conflict.cloud)}`
    ],
    choices: [
      { value: 'computer', label: "Keep this computer's" },
      { value: 'cloud', label: `Keep ${label}'s` }
    ],
    primary: newer
  })
}

/** Empties the store. For tests only. */
export function resetCloudSyncStore(): void {
  announcedConflict = null
  useCloudSyncStore.setState({ status: null })
}
