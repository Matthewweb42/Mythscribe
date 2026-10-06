import { docToText } from '@shared/docText'
import { parseStoredSceneMeta } from '@shared/sceneMeta'
import { PANEL_NOTES_CHARS, PANEL_SYNOPSIS_CHARS } from '@shared/sceneSuggest'
import { parseStoredTiptap } from '../../document/documentStore'
import { getNode, type TreeDb } from '../../tree/treeStore'
import type { ScenePanel } from '../prompts/chat.v5'
import { headTruncate } from './chatContext'

/**
 * The open node's side panel as the chat (`chat.v5`) and Story Intelligence (`query.v4`) carry it
 * (F-5.20): the synopsis (F-11.1) and the scene's notes (F-3.7) as plain text, each cut to its
 * cap. Null for no node, an unknown id, a section root, or a panel with nothing in it, so the
 * prompts send nothing and match their previous version exactly. Read-only: the panel is the
 * author's, and the AI only ever proposes into it (`ai:suggestSynopsis`, `ai:suggestNotes`).
 */
export function buildScenePanel(db: TreeDb, nodeId: string | null): ScenePanel | null {
  if (nodeId === null) return null
  const row = getNode(db, nodeId)
  if (!row?.parentId) return null
  const synopsis = headTruncate(
    parseStoredSceneMeta(row.sceneMeta).synopsis.trim(),
    PANEL_SYNOPSIS_CHARS
  )
  const notes = headTruncate(notesText(row.notes, row.id), PANEL_NOTES_CHARS)
  return synopsis || notes ? { synopsis, notes } : null
}

/** A node's stored notes as plain text; '' when there are none. */
export function notesText(stored: string | null, id: string): string {
  return stored === null ? '' : docToText(parseStoredTiptap(stored, id, 'notes')).trim()
}
