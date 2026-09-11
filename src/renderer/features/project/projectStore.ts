import { create } from 'zustand'
import type { NovelFormat, ProjectInfo, RecentProject } from '@shared/ipc/contract'
import { ipc } from '@renderer/lib/ipc'

interface ProjectState {
  current: ProjectInfo | null
  ready: boolean
  busy: boolean
  recents: RecentProject[]
  init: () => Promise<void>
  create: (name: string, format: NovelFormat, directory?: string) => Promise<ProjectInfo | null>
  open: (path?: string) => Promise<ProjectInfo | null>
  close: () => Promise<void>
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

    create(name, format, directory) {
      return run(async () => {
        const info = await ipc().invoke('project:create', { name, format, directory })
        if (info) set({ current: info })
        return info
      })
    },

    open(path) {
      return run(async () => {
        const info = await ipc().invoke('project:open', { path })
        if (info) set({ current: info })
        return info
      })
    },

    close() {
      return run(async () => {
        await ipc().invoke('project:close', undefined)
        set({ current: null })
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
