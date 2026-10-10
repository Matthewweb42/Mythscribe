import { createContext, useContext, useState } from 'react'
import { create } from 'zustand'
import { uploadInPanel, useLibraryStore } from '@renderer/features/library/libraryStore'
import { useOrganiseStore } from '@renderer/features/organise/organiseStore'

/**
 * Side work (2026-10-10, the author's "long AI work never blocks writing"): Organise and the
 * upload review run in the background under a status-bar item, and show in the assistant
 * column only when the author opens them there. Each run's store owns whether it shows
 * (`organiseStore.shown`, `libraryStore.shown`); this is the one read of which one does.
 */
export type SideWork = 'organise' | 'upload'

/**
 * Where the shown side work sits (F-7.12): the assistant column (the status-bar item), or the
 * big review dialog in the middle of the window (a drop notification's Open, also over focus
 * mode). Only one piece of side work shows at a time, so one place serves both.
 */
export type SideWorkPlace = 'column' | 'dialog'

export const useSideWorkPlaceStore = create<{ place: SideWorkPlace }>(() => ({ place: 'column' }))

/** The side work showing in `place` (the assistant column by default), or null. */
export function useShownSideWork(place: SideWorkPlace = 'column'): SideWork | null {
  const organise = useOrganiseStore((s) => s.open && s.shown)
  const upload = useLibraryStore((s) => s.shown && uploadInPanel(s.flow))
  const here = useSideWorkPlaceStore((s) => s.place === place)
  if (!here) return null
  return organise ? 'organise' : upload ? 'upload' : null
}

/** Shows one piece of side work in `place` (the assistant column by default) and hides the other. */
export function showSideWork(work: SideWork, place: SideWorkPlace = 'column'): void {
  useSideWorkPlaceStore.setState({ place })
  if (work === 'organise') {
    useLibraryStore.getState().hide()
    useOrganiseStore.getState().show()
  } else {
    useOrganiseStore.getState().hide()
    useLibraryStore.getState().show()
  }
}

/** Back to the column for the next show. For tests only. */
export function resetSideWorkPlace(): void {
  useSideWorkPlaceStore.setState({ place: 'column' })
}

/** Whether the author is in the side-work frame now (the frame answers; outside one, false). */
export const SideWorkFocus = createContext<() => boolean>(() => false)

/** Where the frame being rendered sits; the dialog wraps it as a centred window (F-7.12). */
export const SideWorkPlaceContext = createContext<SideWorkPlace>('column')

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
