import { useEffect } from 'react'
import type { Editor } from '@tiptap/core'
import type { UnderlineView } from '@shared/memory/underlines'
import { useAiSettingsStore } from '@renderer/features/ai/aiSettingsStore'
import { useSceneMemory } from '@renderer/features/memory/memoryStore'
import { ipc } from '@renderer/lib/ipc'
import { CONTRADICTION_MARKS_KEY, useContradictionCardStore } from './contradictionMarks'
import { useDocumentStore } from './documentStore'

const NONE: readonly UnderlineView[] = []

/**
 * Reports what the editor draws, once per finding (`memory:underlinesShown`, for underline
 * precision; bookkeeping only, so a failure is retried the next time it is drawn); answers the
 * detach, which also closes the hover card of this scene.
 */
function attachDrawn(editor: Editor, nodeId: string): (() => void) | undefined {
  const storage = editor.storage.contradictionMarks
  if (storage === undefined) return undefined
  const reported = new Set<string>()
  storage.onDrawn = (findingIds) => {
    const fresh = findingIds.filter((id) => !reported.has(id))
    if (fresh.length === 0) return
    for (const id of fresh) reported.add(id)
    ipc()
      .invoke('memory:underlinesShown', { findingIds: fresh })
      .catch(() => {
        for (const id of fresh) reported.delete(id)
      })
  }
  return () => {
    storage.onDrawn = null
    const card = useContradictionCardStore.getState().card
    if (card?.nodeId === nodeId) useContradictionCardStore.getState().close()
  }
}

/**
 * Feeds a story memory v2 manuscript editor its contradiction underlines (F-16.28, plan P4 §5.2):
 * the scene's memory is watched while the editor shows it (so the underlines come even with the
 * This scene panel closed), and each time main's answer for it moves, or the Contradiction check or
 * Settings' "Show contradictions" changes, the editor's marks are set again (none while the check
 * is off or contradictions show in the panel only; the paragraphs edited since stay bare while the
 * document has unsaved edits). What the editor drew is reported once per finding. `v2` false (a
 * v1 project): nothing at all.
 */
export function useContradictionMarks(
  editor: Editor,
  nodeId: string,
  ready: boolean,
  v2: boolean
): void {
  const active = v2 && ready
  const scene = useSceneMemory(active ? nodeId : null)
  const on = useAiSettingsStore((s) => s.settings?.features.judge === true)
  const underlined = useAiSettingsStore((s) => s.settings?.reading.underlines !== 'panel')
  const underlines = scene?.underlines ?? NONE

  useEffect(() => (active ? attachDrawn(editor, nodeId) : undefined), [active, editor, nodeId])

  useEffect(() => {
    if (!active || editor.isDestroyed || editor.storage.contradictionMarks === undefined) return
    const shown = on && underlined ? underlines : NONE
    // Nothing drawn and nothing to draw: no transaction at all.
    if (
      shown.length === 0 &&
      (CONTRADICTION_MARKS_KEY.getState(editor.state)?.located.length ?? 0) === 0
    ) {
      return
    }
    const keepEdited = useDocumentStore.getState().docs[nodeId]?.dirty === true
    editor.commands.setContradictionMarks(shown, { keepEdited })
  }, [active, editor, nodeId, on, underlined, underlines])
}
