import { create } from 'zustand'
import type { ExportProgress } from '@shared/bookExport'
import {
  BUILTIN_COMPILE_FORMATS,
  CompileFormat,
  DEFAULT_COMPILE_FORMAT_ID,
  findCompileFormat,
  isBuiltinFormatId,
  setIncluded,
  sortFormats,
  type CompileOutput,
  type CompileProjectState,
  type CompileScope
} from '@shared/compileFormat'
import type { CompileSource } from '@shared/compileModel'
import { useDocumentStore } from '@renderer/features/editor/documentStore'
import { useNotesStore } from '@renderer/features/editor/notesStore'
import { useSceneMetaStore } from '@renderer/features/editor/sceneMetaStore'
import { toast } from '@renderer/features/shell/dialogs/dialogStore'
import { describeError } from '@renderer/lib/errors'
import { ipc } from '@renderer/lib/ipc'
import type { ScopeKind } from './compileContents'

export type CompileRunStatus = 'idle' | 'running' | 'error'

/**
 * The one owner of compiling in the renderer (Compile v2, CV3): the project's compile state
 * (last format, output, quick pick, and the "Include in compile" ticks the binder menu changes
 * too), the author's format library ("My formats"), the format as shown in the compile window
 * (`draft`, with unsaved edits), the compile source the preview reads, and the run in flight.
 * Built-in formats are read-only: they are duplicated to be changed. A library format's edits
 * stay in `draft` (for the session, across closing the window) until Save or Revert. Every
 * change to the compile state is written through `compileState:set` in order. Cleared when the
 * project closes (`App.tsx`).
 */
interface CompileWindowState {
  /** The compile state is loaded (`ensureState`). */
  stateLoaded: boolean
  /** The window's own data (library, source) is loaded (`open`). */
  ready: boolean
  loading: boolean
  loadError: string | null
  library: CompileFormat[]
  formatId: string
  /** Null: the format's default output. */
  output: CompileOutput | null
  scopeKind: ScopeKind
  /** The ticked chapters of the "Selected chapters" quick pick; kept while another is picked. */
  chapterIds: string[]
  excluded: string[]
  /** The selected format as shown, edits included. */
  draft: CompileFormat
  /** `draft` differs from the stored library format. */
  dirty: boolean
  source: CompileSource | null
  status: CompileRunStatus
  progress: ExportProgress | null
  error: string | null

  /** Loads the project's compile state once (the binder menu needs the ticks too). */
  ensureState: () => Promise<void>
  /** Opening the window: flushes the editors' drafts, then loads the state, library, and source. */
  open: () => Promise<void>
  selectFormat: (id: string) => void
  /** Changes the shown format (a library format only; built-ins are read-only). */
  edit: (recipe: (format: CompileFormat) => CompileFormat) => void
  revert: () => void
  setOutput: (output: CompileOutput | null) => void
  setScopeKind: (kind: ScopeKind) => void
  toggleChapter: (id: string, on: boolean) => void
  setIncluded: (id: string, included: boolean) => void
  /** Copies the shown format into My formats under `name` (default "<name> copy") and selects it. */
  duplicate: (name?: string) => Promise<CompileFormat>
  /** Saves the shown library format. */
  save: () => Promise<void>
  /** Renames the selected library format (its stored settings; unsaved edits stay unsaved). */
  rename: (name: string) => Promise<void>
  /** Deletes the selected library format and selects the default. */
  remove: () => Promise<void>
  /** Compiles; answers true when a file was written. */
  compile: (scope: CompileScope) => Promise<boolean>
  clear: () => void
}

function builtinDefault(): CompileFormat {
  const format = findCompileFormat([], DEFAULT_COMPILE_FORMAT_ID) ?? BUILTIN_COMPILE_FORMATS[0]
  if (format === undefined) throw new Error('The built-in compile formats are missing')
  return format
}

function initial(): Omit<
  CompileWindowState,
  | 'ensureState'
  | 'open'
  | 'selectFormat'
  | 'edit'
  | 'revert'
  | 'setOutput'
  | 'setScopeKind'
  | 'toggleChapter'
  | 'setIncluded'
  | 'duplicate'
  | 'save'
  | 'rename'
  | 'remove'
  | 'compile'
  | 'clear'
> {
  const fallback = builtinDefault()
  return {
    stateLoaded: false,
    ready: false,
    loading: false,
    loadError: null,
    library: [],
    formatId: fallback.id,
    output: null,
    scopeKind: 'manuscript',
    chapterIds: [],
    excluded: [],
    draft: fallback,
    dirty: false,
    source: null,
    status: 'idle',
    progress: null,
    error: null
  }
}

/** Bumped by every clear, so an answer for a closed project is dropped. */
let generation = 0
/** The compile state writes, one after another. */
let writes: Promise<unknown> = Promise.resolve()
/** The load in flight, so the binder and the window share one. */
let stateLoad: Promise<void> | null = null

export const useCompileWindowStore = create<CompileWindowState>((set, get) => {
  /** The compile state as stored: the chapters pick only while it has ticks. */
  const stored = (): CompileProjectState => {
    const s = get()
    let scope: CompileScope = { kind: 'manuscript' }
    if (s.scopeKind === 'chapters' && s.chapterIds.length > 0)
      scope = { kind: 'chapters', ids: s.chapterIds }
    return { formatId: s.formatId, output: s.output, scope, excluded: s.excluded }
  }

  const persist = (): void => {
    if (!get().stateLoaded) return
    const mine = generation
    const state = stored()
    writes = writes
      .catch(() => undefined)
      .then(() => ipc().invoke('compileState:set', state))
      .catch((err: unknown) => {
        if (mine === generation) toast.error(describeError(err))
      })
  }

  const resolve = (library: readonly CompileFormat[], id: string): CompileFormat =>
    findCompileFormat(library, id) ?? builtinDefault()

  const select = (format: CompileFormat): void => {
    set({ formatId: format.id, draft: structuredClone(format), dirty: false, output: null })
  }

  return {
    ...initial(),

    ensureState() {
      if (get().stateLoaded) return Promise.resolve()
      if (stateLoad !== null) return stateLoad
      const mine = generation
      stateLoad = (async () => {
        try {
          const [state, library] = await Promise.all([
            ipc().invoke('compileState:get', undefined),
            ipc().invoke('compileFormat:list', undefined)
          ])
          if (mine !== generation) return
          const format = resolve(library, state.formatId)
          set({
            stateLoaded: true,
            library: sortFormats(library),
            formatId: format.id,
            draft: structuredClone(format),
            dirty: false,
            output: state.output,
            scopeKind: state.scope.kind,
            chapterIds: state.scope.kind === 'chapters' ? state.scope.ids : [],
            excluded: state.excluded
          })
        } finally {
          if (mine === generation) stateLoad = null
        }
      })()
      return stateLoad
    },

    async open() {
      const mine = generation
      set({
        loading: true,
        loadError: null,
        status: get().status === 'running' ? 'running' : 'idle',
        error: null
      })
      try {
        // A failed save is reported by the autosave itself; the stored text is still worth compiling.
        await Promise.all([
          useDocumentStore
            .getState()
            .flush()
            .catch(() => undefined),
          useSceneMetaStore
            .getState()
            .flush()
            .catch(() => undefined),
          useNotesStore
            .getState()
            .flush()
            .catch(() => undefined)
        ])
        await get().ensureState()
        const [library, source] = await Promise.all([
          ipc().invoke('compileFormat:list', undefined),
          ipc().invoke('compile:source', undefined)
        ])
        if (mine !== generation) return
        const s = get()
        // A library format deleted elsewhere (another project's window) falls back to the default.
        const known = findCompileFormat(library, s.formatId)
        if (known === null) {
          set({ library: sortFormats(library), source, ready: true, loading: false })
          select(builtinDefault())
          persist()
          return
        }
        set({ library: sortFormats(library), source, ready: true, loading: false })
        if (!s.dirty) set({ draft: structuredClone(known) })
      } catch (err) {
        if (mine === generation) set({ loading: false, loadError: describeError(err) })
      }
    },

    selectFormat(id) {
      const format = findCompileFormat(get().library, id)
      if (format === null || id === get().formatId) return
      select(format)
      persist()
    },

    edit(recipe) {
      const s = get()
      if (isBuiltinFormatId(s.formatId)) return
      set({ draft: recipe(structuredClone(s.draft)), dirty: true })
    },

    revert() {
      const s = get()
      select(resolve(s.library, s.formatId))
      set({ output: s.output })
    },

    setOutput(output) {
      set({ output })
      persist()
    },

    setScopeKind(scopeKind) {
      set({ scopeKind })
      persist()
    },

    toggleChapter(id, on) {
      const has = get().chapterIds.includes(id)
      if (on === has) return
      set((s) => ({
        chapterIds: on ? [...s.chapterIds, id] : s.chapterIds.filter((c) => c !== id)
      }))
      persist()
    },

    setIncluded(id, included) {
      const next = setIncluded(stored(), id, included)
      set({ excluded: next.excluded })
      persist()
    },

    async duplicate(name) {
      const s = get()
      let created = await ipc().invoke('compileFormat:create', {
        fromId: s.formatId,
        ...(name === undefined ? {} : { name })
      })
      // What is shown is what gets copied: unsaved edits go into the copy, not the original.
      if (s.dirty) {
        created = await ipc().invoke('compileFormat:save', {
          ...s.draft,
          id: created.id,
          name: created.name
        })
      }
      set((state) => ({ library: sortFormats([...state.library, created]) }))
      select(created)
      persist()
      return created
    },

    async save() {
      const s = get()
      if (isBuiltinFormatId(s.formatId)) return
      const saved = await ipc().invoke('compileFormat:save', CompileFormat.parse(s.draft))
      set((state) => ({
        library: sortFormats(state.library.map((f) => (f.id === saved.id ? saved : f))),
        draft: structuredClone(saved),
        dirty: false
      }))
    },

    async rename(name) {
      const s = get()
      const current = s.library.find((f) => f.id === s.formatId)
      if (current === undefined) return
      const saved = await ipc().invoke('compileFormat:save', { ...current, name })
      set((state) => ({
        library: sortFormats(state.library.map((f) => (f.id === saved.id ? saved : f))),
        draft: { ...state.draft, name: saved.name }
      }))
    },

    async remove() {
      const s = get()
      if (isBuiltinFormatId(s.formatId)) return
      await ipc().invoke('compileFormat:delete', { id: s.formatId })
      set((state) => ({ library: state.library.filter((f) => f.id !== s.formatId) }))
      select(builtinDefault())
      persist()
    },

    async compile(scope) {
      const s = get()
      if (s.status === 'running') return false
      const parsed = CompileFormat.safeParse(s.draft)
      if (!parsed.success) return false
      const mine = generation
      const requestId = crypto.randomUUID()
      set({ status: 'running', progress: null, error: null })
      const unsubscribe = ipc().on('export:progress', (progress) => {
        if (progress.requestId === requestId && mine === generation) set({ progress })
      })
      try {
        await Promise.all([
          useDocumentStore
            .getState()
            .flush()
            .catch(() => undefined),
          useSceneMetaStore
            .getState()
            .flush()
            .catch(() => undefined),
          useNotesStore
            .getState()
            .flush()
            .catch(() => undefined),
          // `compile:run` reads the stored include ticks.
          writes.catch(() => undefined)
        ])
        const output = s.output ?? parsed.data.defaultOutput
        const result = await ipc().invoke('compile:run', {
          format: parsed.data,
          output,
          scope,
          requestId
        })
        if (mine !== generation) return false
        set({ status: 'idle', progress: null })
        if (result === null) return false
        toast.success(`Compiled to ${result.path}`)
        return true
      } catch (err) {
        if (mine === generation) set({ status: 'error', progress: null, error: describeError(err) })
        return false
      } finally {
        unsubscribe()
      }
    },

    clear() {
      generation++
      stateLoad = null
      writes = Promise.resolve()
      set(initial())
    }
  }
})

/** Empties the store. For tests only. */
export function resetCompileWindowStore(): void {
  useCompileWindowStore.getState().clear()
}
