import { createContext, useContext, useState } from 'react'
import { uploadInPanel, useLibraryStore } from '@renderer/features/library/libraryStore'
import { useOrganiseStore } from '@renderer/features/organise/organiseStore'

/**
 * Side work (2026-10-10, the author's "long AI work never blocks writing"): Organise and the
 * upload review run in the background under a status-bar item, and show in the assistant
 * column only when the author opens them there. Each run's store owns whether it shows
 * (`organiseStore.shown`, `libraryStore.shown`); this is the one read of which one does.
 */
export type SideWork = 'organise' | 'upload'

/** The side work showing in the assistant column, or null for the conversation. */
export function useShownSideWork(): SideWork | null {
  const organise = useOrganiseStore((s) => s.open && s.shown)
  const upload = useLibraryStore((s) => s.shown && uploadInPanel(s.flow))
  return organise ? 'organise' : upload ? 'upload' : null
}

/** Shows one piece of side work in the assistant column and hides the other. */
export function showSideWork(work: SideWork): void {
  if (work === 'organise') {
    useLibraryStore.getState().hide()
    useOrganiseStore.getState().show()
  } else {
    useOrganiseStore.getState().hide()
    useLibraryStore.getState().show()
  }
}

/** Whether the author is in the side-work frame now (the frame answers; outside one, false). */
export const SideWorkFocus = createContext<() => boolean>(() => false)

/**
 * Whether a review deck mounting in the frame takes the focus: only when the author is in the
 * frame at that moment, so a plan arriving while the author writes never pulls the caret away.
 * Read once, at mount.
 */
export function useTakesFocus(): boolean {
  const inside = useContext(SideWorkFocus)
  const [takes] = useState(inside)
  return takes
}
