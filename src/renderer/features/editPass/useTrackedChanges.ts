import { useEffect } from 'react'
import type { Editor } from '@tiptap/core'
import type { EditChange } from '@shared/editPass'
import { locateText } from '@renderer/features/editor/locateText'
import {
  TRACKED_CHANGES_KEY,
  trackedChangesOf,
  type TrackedChange
} from '@renderer/features/editor/trackedChanges'
import { registerTrackedEditor, useEditPassStore } from './editPassStore'

const NONE: EditChange[] = []

/** The pending tracked changes of a scene, as the store holds them (empty until fetched). */
export function useSceneChanges(nodeId: string): EditChange[] {
  return useEditPassStore((s) => s.changesByNode[nodeId] ?? NONE)
}

function toTracked(change: EditChange): TrackedChange {
  return {
    id: change.id,
    original: change.original,
    replacement: change.replacement ?? '',
    rationale: change.rationale,
    flagged: change.flagged
  }
}

/**
 * Routes the editor's inline Accept / Reject to the store and settles the changes whose passage
 * is gone as stale; returns the detach.
 */
function attachHandlers(editor: Editor, nodeId: string): (() => void) | undefined {
  const storage = editor.storage.trackedChanges
  if (storage === undefined) return undefined
  storage.onAction = (id, action) => {
    const change = useEditPassStore
      .getState()
      .changesByNode[nodeId]?.find((entry) => entry.id === id)
    if (change === undefined) return
    const store = useEditPassStore.getState()
    void (action === 'accept' ? store.accept([change]) : store.reject([change]))
  }
  storage.onStale = (ids) => void useEditPassStore.getState().markStale(ids)
  return () => {
    storage.onAction = null
    storage.onStale = null
  }
}

/**
 * Wires one scene's editor to its tracked changes (F-14.15): fetches the scene's pending changes
 * when the editor is ready, draws them (none while the scene is locked in a running pass), routes
 * the inline Accept / Reject to the store, settles the ones whose passage is gone as stale, lets
 * the store's accept path reach this editor, and highlights a change the author jumped to.
 */
export function useTrackedChanges(
  editor: Editor,
  nodeId: string,
  ready: boolean,
  locked: boolean
): void {
  const changes = useSceneChanges(nodeId)
  const focus = useEditPassStore((s) => (s.focus?.nodeId === nodeId ? s.focus : null))
  const listed = useEditPassStore((s) => s.changesByNode[nodeId] !== undefined)

  useEffect(() => {
    if (!ready) return
    void useEditPassStore.getState().loadChanges(nodeId)
    return registerTrackedEditor(nodeId, editor)
  }, [editor, nodeId, ready])

  useEffect(() => (ready ? attachHandlers(editor, nodeId) : undefined), [editor, nodeId, ready])

  useEffect(() => {
    if (!ready || editor.isDestroyed || editor.storage.trackedChanges === undefined) return
    const shown = locked ? NONE : changes.filter((change) => change.kind === 'change')
    // Nothing drawn and nothing to draw: no transaction at all.
    if (
      shown.length === 0 &&
      (TRACKED_CHANGES_KEY.getState(editor.state)?.changes.length ?? 0) === 0
    )
      return
    editor.commands.setTrackedChanges(shown.map(toTracked))
  }, [editor, ready, locked, changes])

  useEffect(() => {
    if (!ready || !listed || focus === null || editor.isDestroyed) return
    // A tracked change is highlighted where it is drawn; a note (or a change not drawn) selects
    // its passage. Either way the jump is used up once the scene shows it.
    const tracked = trackedChangesOf(editor.state).find(
      (entry) => entry.change.id === focus.changeId
    )
    const range = tracked?.range ?? locateText(editor.state.doc, focus.quote)
    useEditPassStore.setState({ focus: null })
    if (range === null) return
    if (tracked) editor.commands.focusTrackedChange(focus.changeId)
    editor
      .chain()
      .focus()
      .setTextSelection(tracked ? range.from : range)
      .scrollIntoView()
      .run()
  }, [editor, ready, listed, focus, changes])
}
