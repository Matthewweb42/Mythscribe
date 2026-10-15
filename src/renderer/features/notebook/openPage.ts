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
}

export const useOpenNotebookPageStore = create<OpenNotebookPageState>(() => ({
  openNotebookPageId: null,
  requested: 0
}))

/** Asks the notes area to show page `id`. */
export function openNotebookPage(id: string): void {
  useOpenNotebookPageStore.setState((s) => ({ openNotebookPageId: id, requested: s.requested + 1 }))
}

/** Forgets the request (the project closed, or the page was shown). For tests and the notes area. */
export function resetOpenNotebookPage(): void {
  useOpenNotebookPageStore.setState({ openNotebookPageId: null, requested: 0 })
}
