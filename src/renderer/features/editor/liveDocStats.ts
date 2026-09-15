import { useCallback, useRef, useSyncExternalStore } from 'react'
import type { Editor } from '@tiptap/core'
import { aiOriginPercent, aiOriginStats } from '@shared/provenance'
import { countWords } from '@shared/wordCount'

/** What is read live from the editor: the word count (F-3.3) and the AI-origin share (F-14.6). */
export interface LiveDocStats {
  words: number
  aiPercent: number
}

/**
 * The editor's word count and AI-origin share, recounted only when the document changes: the
 * snapshot is cached by the ProseMirror document's identity, which selection-only transactions
 * leave untouched, so a long scene is never re-serialized on a caret move. Null without an
 * editor. Used by the document status bar and by the focus-mode control bar (F-6.5), which
 * applies it to whichever editor is active.
 */
export function useLiveDocStats(editor: Editor | null): LiveDocStats | null {
  const cache = useRef<{ doc: unknown; stats: LiveDocStats } | null>(null)
  const subscribe = useCallback(
    (notify: () => void) => {
      if (!editor) return () => undefined
      editor.on('update', notify)
      return () => {
        editor.off('update', notify)
      }
    },
    [editor]
  )
  const getSnapshot = useCallback(() => {
    if (!editor) return null
    const doc: unknown = editor.state.doc
    const hit = cache.current
    if (hit !== null && hit.doc === doc) return hit.stats
    const json = editor.getJSON()
    const fresh = {
      doc,
      stats: { words: countWords(json), aiPercent: aiOriginPercent(aiOriginStats(json)) }
    }
    cache.current = fresh
    return fresh.stats
  }, [editor])
  return useSyncExternalStore(subscribe, getSnapshot)
}
