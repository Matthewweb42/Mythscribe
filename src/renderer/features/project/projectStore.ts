import { create } from 'zustand'
import type { AiSource } from '@shared/aiSettings'
import type { NovelFormat, ProjectInfo, RecentProject } from '@shared/ipc/contract'
import { ipc } from '@renderer/lib/ipc'
import { flushPendingSaves } from './pendingSaves'

interface ProjectState {
  current: ProjectInfo | null
  ready: boolean
  busy: boolean
  recents: RecentProject[]
  init: () => Promise<void>
  /** `aiSource` is the wizard's AI source choice (F-15.11); omitted keeps the project default. */
  create: (
    name: string,
    format: NovelFormat,
    directory?: string,
    aiSource?: AiSource
  ) => Promise<ProjectInfo | null>
  open: (path?: string) => Promise<ProjectInfo | null>
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

export const useProjectStore = create<ProjectState>((set) => {
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
    },

    create(name, format, directory, aiSource) {
      return run(async () => {
        await flushPendingSaves()
        const info = await ipc().invoke('project:create', { name, format, directory, aiSource })
        if (info) set({ current: info })
        return info
      })
    },

    open(path) {
      return run(async () => {
        await flushPendingSaves()
        const info = await ipc().invoke('project:open', { path })
        if (info) set({ current: info })
        return info
      })
    },

    close() {
      return run(async () => {
        await flushPendingSaves()
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
