import { create } from 'zustand'
import type { AiSwitch, AiSource } from '@shared/aiSettings'
import type { ImportDraft } from '@shared/import'
import type { NovelFormat, ProjectInfo, RecentProject } from '@shared/ipc/contract'
import { ipc } from '@renderer/lib/ipc'
import { chooseCloudVersion, cloudConflictOf, confirmCloudCopy } from './cloudSyncStore'
import { flushPendingSaves } from './pendingSaves'
import { offerRecovery } from './recovery'

interface ProjectState {
  current: ProjectInfo | null
  ready: boolean
  busy: boolean
  recents: RecentProject[]
  init: () => Promise<void>
  /**
   * `aiSource` and `aiSwitch` are the wizard's AI source (F-15.11) and AI level (F-5.18) choices;
   * omitted keeps the project default.
   */
  create: (
    name: string,
    format: NovelFormat,
    directory?: string,
    aiSource?: AiSource,
    aiSwitch?: AiSwitch
  ) => Promise<ProjectInfo | null>
  open: (path?: string) => Promise<ProjectInfo | null>
  /**
   * Import to start (F-12.2): creates a project from a reviewed manuscript draft (no starter
   * skeleton) and opens it. Null when the save dialog was cancelled; nothing was written then.
   */
  createFromImport: (
    draft: ImportDraft,
    name: string,
    format: NovelFormat
  ) => Promise<ProjectInfo | null>
  /**
   * Restores a backup as a new project and opens it (F-8.4): `file` is one of the open
   * project's backups; omitted, main asks for a backup file and where to put the copy. Null
   * when a dialog was cancelled.
   */
  restoreBackup: (file?: string) => Promise<ProjectInfo | null>
  close: () => Promise<void>
  /**
   * Answers `window:close-requested`: flushes pending saves, then lets main close the window.
   * A failed flush tells main the close is abandoned (so a quit behind it is forgotten) and
   * rethrows so the caller can show the cause.
   */
  closeWindow: () => Promise<void>
  loadRecents: () => Promise<void>
  removeRecent: (path: string) => Promise<void>
}

let unsubscribe: (() => void) | null = null

export const useProjectStore = create<ProjectState>((set, get) => {
  /**
   * Writes pending saves; then, when a project in a cloud-synced folder is open, copies it there
   * first and asks the author what to do if that fails (2026-10-08).
   */
  const settle = async (going: 'close' | 'switch'): Promise<void> => {
    await flushPendingSaves()
    if (get().current !== null) await confirmCloudCopy(going)
  }
  /**
   * Opens a project; when its cloud folder and this computer both changed it (2026-10-10), asks
   * which version to keep and opens again with the answer. Cancel opens nothing.
   */
  const openAsking = async (path: string | undefined): Promise<ProjectInfo | null> => {
    try {
      return await ipc().invoke('project:open', { path })
    } catch (err) {
      const conflict = cloudConflictOf(err)
      if (conflict === null) throw err
      const keep = await chooseCloudVersion(conflict)
      if (keep === null) return null
      return ipc().invoke('project:open', { path: conflict.folder, cloudConflict: keep })
    }
  }
  const run = async <T>(fn: () => Promise<T>): Promise<T> => {
    set({ busy: true })
    try {
      return await fn()
    } finally {
      set({ busy: false })
    }
  }
  return {
    current: null,
    ready: false,
    busy: false,
    recents: [],

    async init() {
      unsubscribe?.()
      unsubscribe = ipc().on('project:changed', (current) => set({ current }))
      const current = await ipc().invoke('project:current', undefined)
      set({ current, ready: true })
      // F-8.3: a renderer that starts (or restarts after a crash) with a project open offers back
      // what the crash left unsaved.
      if (current) void offerRecovery()
    },

    create(name, format, directory, aiSource, aiSwitch) {
      return run(async () => {
        await settle('switch')
        const info = await ipc().invoke('project:create', {
          name,
          format,
          directory,
          aiSource,
          aiSwitch
        })
        if (info) set({ current: info })
        return info
      })
    },

    createFromImport(draft, name, format) {
      return run(async () => {
        await settle('switch')
        const info = await ipc().invoke('import:createProject', { draft, name, format })
        if (info) set({ current: info })
        return info
      })
    },

    open(path) {
      return run(async () => {
        await settle('switch')
        const info = await openAsking(path)
        if (info) {
          set({ current: info })
          void offerRecovery() // F-8.3; a new project (`create`) has no journal
        }
        return info
      })
    },

    restoreBackup(file) {
      return run(async () => {
        await settle('switch')
        const info = await ipc().invoke('backups:restore', { file })
        // No recovery offer: a backup never carries the crash journal.
        if (info) set({ current: info })
        return info
      })
    },

    close() {
      return run(async () => {
        await settle('close')
        await ipc().invoke('project:close', undefined)
        set({ current: null })
      })
    },

    closeWindow() {
      return run(async () => {
        try {
          await flushPendingSaves()
        } catch (err) {
          await ipc().invoke('window:close-cancelled', undefined)
          throw err
        }
        await confirmCloudCopy('close')
        await ipc().invoke('window:close', undefined)
      })
    },

    async loadRecents() {
      const recents = await ipc().invoke('recents:list', undefined)
      set({ recents })
    },

    async removeRecent(path) {
      const recents = await ipc().invoke('recents:remove', { path })
      set({ recents })
    }
  }
})
