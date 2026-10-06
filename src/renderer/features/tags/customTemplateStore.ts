import { create } from 'zustand'
import type { CustomTagTemplate } from '@shared/tagTemplates'
import { ipc } from '@renderer/lib/ipc'

/**
 * The one owner of the author's saved tag templates in the renderer (F-4.11). They are app-wide
 * (main keeps them in app state), so the list loads once, when the template row first shows, and
 * every write replaces the template main returns. Errors propagate so the caller can toast them.
 */
interface CustomTemplateState {
  templates: CustomTagTemplate[]
  loaded: boolean
  /** Reads the list once; later calls are free. */
  ensureLoaded: () => Promise<void>
  /** Saves the open project's bank, or only `tagIds`, under `name`. */
  save: (name: string, tagIds?: string[]) => Promise<CustomTagTemplate>
  rename: (id: string, name: string) => Promise<CustomTagTemplate>
  /** Keeps only the named tags in the template. */
  keepTags: (id: string, keep: string[]) => Promise<CustomTagTemplate>
  remove: (id: string) => Promise<void>
}

/** Sorted as main sorts them, so a local upsert never disagrees with the next list. */
const byName = (a: CustomTagTemplate, b: CustomTagTemplate): number =>
  a.name.toLocaleLowerCase().localeCompare(b.name.toLocaleLowerCase())

export const useCustomTemplateStore = create<CustomTemplateState>((set, get) => {
  const upsert = (template: CustomTagTemplate): CustomTagTemplate => {
    const rest = get().templates.filter((t) => t.id !== template.id)
    set({ templates: [...rest, template].sort(byName) })
    return template
  }
  return {
    templates: [],
    loaded: false,

    async ensureLoaded() {
      if (get().loaded) return
      const templates = await ipc().invoke('tagTemplate:list', undefined)
      set({ templates, loaded: true })
    },

    async save(name, tagIds) {
      const template = await ipc().invoke('tagTemplate:save', {
        name,
        ...(tagIds === undefined ? {} : { tagIds })
      })
      return upsert(template)
    },

    async rename(id, name) {
      return upsert(await ipc().invoke('tagTemplate:update', { id, name }))
    },

    async keepTags(id, keep) {
      return upsert(await ipc().invoke('tagTemplate:update', { id, keep }))
    },

    async remove(id) {
      await ipc().invoke('tagTemplate:delete', { id })
      set({ templates: get().templates.filter((t) => t.id !== id) })
    }
  }
})

/** Empties the store so the next `ensureLoaded` reads again. For tests only. */
export function resetCustomTemplateStore(): void {
  useCustomTemplateStore.setState({ templates: [], loaded: false })
}
