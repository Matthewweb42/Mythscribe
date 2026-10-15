import { create } from 'zustand'

/**
 * Which note page the notes area should show (notes redesign phase 1): set by whatever asks to
 * open a page (Ms Scribe's sources under an answer, a note edit in the chat); the notes area
 * reads `openNotebookPageId`, shows that page, and may clear it once shown. One owner: this store.
 */
interface OpenNotebookPageState {
  openNotebookPageId: string | null
  /** Bumped on every request, so asking for the page already open shows it again. */
  requested: number
  /**
   * The passage to select and centre on the page (a source's quote, 2026-10-15), or null; the
   * page's editor takes it once shown and clears it (`takeNotebookQuote`).
   */
  quote: string | null
}

export const useOpenNotebookPageStore = create<OpenNotebookPageState>(() => ({
  openNotebookPageId: null,
  requested: 0,
  quote: null
}))

/** Asks the notes area to show page `id`, at `quote` when one is given. */
export function openNotebookPage(id: string, quote: string | null = null): void {
  useOpenNotebookPageStore.setState((s) => ({
    openNotebookPageId: id,
    requested: s.requested + 1,
    quote
  }))
}

/** The quote waiting for page `id`, cleared as it is taken; null when none waits for it. */
export function takeNotebookQuote(id: string): string | null {
  const { openNotebookPageId, quote } = useOpenNotebookPageStore.getState()
  if (openNotebookPageId !== id || quote === null) return null
  useOpenNotebookPageStore.setState({ quote: null })
  return quote
}

/** Forgets the request (the project closed, or the page was shown). For tests and the notes area. */
export function resetOpenNotebookPage(): void {
  useOpenNotebookPageStore.setState({ openNotebookPageId: null, requested: 0, quote: null })
}
