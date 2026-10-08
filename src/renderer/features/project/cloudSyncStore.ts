import { create } from 'zustand'
import { CLOUD_PROVIDER_LABEL, type CloudSyncStatus } from '@shared/cloudSync'
import { describeError } from '@renderer/lib/errors'
import { ipc } from '@renderer/lib/ipc'
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
      toast.warning(
        `${label} had a different version of this project. Yours stays open; the other is kept beside it as "${fileName(conflict)}".`
      )
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

/** Empties the store. For tests only. */
export function resetCloudSyncStore(): void {
  announcedConflict = null
  useCloudSyncStore.setState({ status: null })
}
