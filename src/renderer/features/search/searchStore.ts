import { create } from 'zustand'
import {
  SEARCH_TYPES,
  isSearchable,
  normalizeQuery,
  type SearchResponse,
  type SearchType
} from '@shared/search'
import { describeError } from '@renderer/lib/errors'
import { ipc } from '@renderer/lib/ipc'

/** How long the query rests before main is asked; a filter change asks at once. */
export const SEARCH_DEBOUNCE_MS = 200

export type SearchStatus = 'idle' | 'searching' | 'done' | 'error'

/**
 * The project search dialog (F-10.1): whether it is open, what is typed, the two filters, and the
 * last answer. One owner, so the chord, the menu, and the header button all open the same dialog
 * and it reopens on what was last searched. Typing is debounced; a generation counter drops an
 * answer that a newer request (or a close of the project) has overtaken.
 */
interface SearchState {
  open: boolean
  /** As typed; `normalizeQuery` is applied when asking, and main normalizes again. */
  query: string
  types: SearchType[]
  tagId: string | null
  /** The last answer for the current query and filters; null before one arrived. */
  response: SearchResponse | null
  /** The normalized query `response` answers: what the rows highlight and a jump looks for. */
  answeredQuery: string
  status: SearchStatus
  /** Why the last request failed; null unless `status` is `error`. */
  error: string | null
  openSearch: () => void
  close: () => void
  setQuery: (query: string) => void
  toggleType: (type: SearchType) => void
  setTagId: (tagId: string | null) => void
  /** Closes the dialog and forgets everything: the project closed. */
  reset: () => void
}

const initial = {
  open: false,
  query: '',
  types: [...SEARCH_TYPES] as SearchType[],
  tagId: null,
  response: null,
  answeredQuery: '',
  status: 'idle' as SearchStatus,
  error: null
}

let generation = 0
let timer: ReturnType<typeof setTimeout> | null = null

function cancelTimer(): void {
  if (timer !== null) clearTimeout(timer)
  timer = null
}

export const useSearchStore = create<SearchState>((set, get) => {
  const run = async (): Promise<void> => {
    cancelTimer()
    const mine = ++generation
    const { query, types, tagId } = get()
    const normalized = normalizeQuery(query)
    if (!isSearchable(normalized) || types.length === 0) {
      set({ response: null, answeredQuery: '', status: 'idle', error: null })
      return
    }
    set({ status: 'searching', error: null })
    try {
      const response = await ipc().invoke('search:query', { query: normalized, types, tagId })
      if (mine !== generation) return // a newer request, a close, or a reset overtook this one
      set({ response, answeredQuery: normalized, status: 'done' })
    } catch (err) {
      if (mine !== generation) return
      set({ response: null, answeredQuery: '', status: 'error', error: describeError(err) })
    }
  }

  return {
    ...initial,

    openSearch() {
      set({ open: true })
    },

    close() {
      set({ open: false })
    },

    setQuery(query) {
      cancelTimer()
      // An answer already under way is for an older query: it must not land after this one.
      generation++
      if (!isSearchable(normalizeQuery(query))) {
        set({ query, response: null, answeredQuery: '', status: 'idle', error: null })
        return
      }
      set({ query, status: 'searching', error: null })
      timer = setTimeout(() => void run(), SEARCH_DEBOUNCE_MS)
    },

    toggleType(type) {
      const { types } = get()
      const next = types.includes(type) ? types.filter((t) => t !== type) : [...types, type]
      // Kept in `SEARCH_TYPES` order, so the request reads the same whatever the click order.
      set({ types: SEARCH_TYPES.filter((t) => next.includes(t)) })
      void run()
    },

    setTagId(tagId) {
      set({ tagId })
      void run()
    },

    reset() {
      cancelTimer()
      generation++
      set({ ...initial, types: [...SEARCH_TYPES] })
    }
  }
})

/** Back to the closed, empty dialog, with any pending request dropped. For tests and project close. */
export function resetSearchStore(): void {
  useSearchStore.getState().reset()
}
