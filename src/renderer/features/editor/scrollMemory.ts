import { useEffect, type RefObject } from 'react'
import { useSessionStore } from '@renderer/features/project/sessionStore'

/**
 * Resume where you left off (F-1.7): once `ready` (the text is in, so the scroller has its
 * height), puts the scroller of `id` (a document, or a folder's stack) back where the session
 * last saw it, then records every scroll. Setting `scrollTop` forces the layout it needs, so no
 * frame is waited for; listening starts after the restore so the restore is not a move.
 */
export function useScrollMemory(
  ref: RefObject<HTMLElement | null>,
  id: string,
  ready: boolean
): void {
  useEffect(() => {
    const el = ref.current
    if (!ready || el === null) return
    const saved = useSessionStore.getState().positionOf(id)
    if (saved !== null && saved.scrollTop > 0) el.scrollTop = saved.scrollTop
    const onScroll = (): void => useSessionStore.getState().recordScroll(id, el.scrollTop)
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => el.removeEventListener('scroll', onScroll)
  }, [ref, id, ready])
}
