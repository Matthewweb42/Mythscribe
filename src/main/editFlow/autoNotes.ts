import { isFeatureAllowed } from '@shared/aiSettings'
import {
  autoNotesSpec,
  type EditFlowChapterLeftResult,
  type NotesAutoSkip,
  type NotesAutoState
} from '@shared/editFlow'
import { getDocumentContent } from '../document/documentStore'
import { AppError } from '../ipc/errors'
import {
  getAiSettings,
  getNotesAutoSettings,
  getNotesAutoState,
  setNotesAutoState
} from '../project/settingsStore'
import { listNodes, type TreeDb } from '../tree/treeStore'
import { dayOf } from '../ai/dailyCap'
import { sceneTextOf } from '../ai/editPass'
import { sha256 } from '../ai/request'
import type { EditFlowRunner } from './run'

/**
 * Notes redesign phase 3: the automatic notes update after a chapter, main side. The renderer
 * says when the author left a chapter after writing in it (`editFlow:chapterLeft`); this decides
 * (one owner) whether that starts a run: the project's switch is on, Use AI and the edit flow are
 * allowed, no edit-flow run is going (a leave then is skipped, never queued: the next one catches
 * up), the chapter's text differs from its text at its last automatic update (writing undone, or
 * leaving twice, never pays twice), and today's count is under the daily cap. The run is the
 * edit flow's own (Update notes, Quick, the chapter), marked automatic. A skip says why in the
 * log only; the author sees nothing.
 */

export interface AutoNotesDeps {
  /** The open project's database, or null while none is open. */
  db: () => TreeDb | null
  runner: EditFlowRunner
  /** Where a skip is written (never a dialog). */
  log: (line: string) => void
  now?: () => Date
}

const SKIP_LINE: Record<NotesAutoSkip, string> = {
  off: 'the switch is off',
  aiOff: 'Use AI or the edit flow is off',
  busy: 'an edit run is going',
  notChapter: 'not a chapter of the manuscript',
  unchanged: 'its text has not changed since its last update',
  cap: 'today’s cap is reached',
  noText: 'it has no text yet'
}

/**
 * The hash of a manuscript chapter's text (its scenes' text, by id so a reorder alone is no
 * change), or null when `chapterId` is not a folder of the manuscript.
 */
export function chapterTextHash(db: TreeDb, chapterId: string): string | null {
  const rows = listNodes(db)
  const byId = new Map(rows.map((row) => [row.id, row]))
  const chapter = byId.get(chapterId)
  if (chapter?.kind !== 'folder' || chapter.sectionType !== null) return null
  // The chapter must sit under the manuscript's root.
  let at = chapter.parentId
  const seen = new Set<string>()
  let section: string | null = null
  while (at !== null && !seen.has(at)) {
    seen.add(at)
    const row = byId.get(at)
    if (row === undefined) break
    if (row.parentId === null) section = row.sectionType
    at = row.parentId
  }
  if (section !== 'manuscript') return null
  const inside = new Set([chapterId])
  // `listNodes` orders by parent, so a descendant may come before its parent: grow to a fixpoint.
  let grew = true
  while (grew) {
    grew = false
    for (const row of rows) {
      if (row.parentId !== null && inside.has(row.parentId) && !inside.has(row.id)) {
        inside.add(row.id)
        grew = true
      }
    }
  }
  const texts = rows
    .filter((row) => row.kind === 'document' && inside.has(row.id))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((row) => `${row.id}\n${sceneTextOf(getDocumentContent(db, row.id).content)}`)
  return sha256(texts.join('\n\n'))
}

/** Today's state: the stored one, or a fresh count when it is for another day. */
function stateFor(state: NotesAutoState, today: string): NotesAutoState {
  return state.day === today ? state : { ...state, day: today, count: 0 }
}

export interface AutoNotes {
  /** The author left `chapterId` after writing in it: starts its update, or says why not. */
  chapterLeft: (chapterId: string) => Promise<EditFlowChapterLeftResult>
}

export function createAutoNotes(deps: AutoNotesDeps): AutoNotes {
  const now = deps.now ?? (() => new Date())
  return {
    async chapterLeft(chapterId) {
      const db = deps.db()
      if (db === null) throw new AppError('NO_PROJECT', 'No project is open')
      const skip = (reason: NotesAutoSkip): EditFlowChapterLeftResult => {
        // The switch being off is the default: not worth a line every time a chapter is left.
        if (reason !== 'off') {
          deps.log(`Notes update after a chapter skipped (${chapterId}): ${SKIP_LINE[reason]}.`)
        }
        return { started: false, reason }
      }
      const settings = getNotesAutoSettings(db)
      if (!settings.on) return skip('off')
      if (!isFeatureAllowed(getAiSettings(db), 'editFlow')) return skip('aiOff')
      if (deps.runner.running() !== null) return skip('busy')
      const hash = chapterTextHash(db, chapterId)
      if (hash === null) return skip('notChapter')
      const state = stateFor(getNotesAutoState(db), dayOf(now()))
      if (state.hashes[chapterId] === hash) return skip('unchanged')
      if (state.count >= settings.dailyCap) return skip('cap')
      let runId: string
      try {
        runId = (await deps.runner.start(autoNotesSpec(chapterId), { automatic: true })).id
      } catch (err) {
        // A chapter with no text yet (the flow refuses it); another start won the race.
        if (err instanceof AppError && err.code === 'VALIDATION') {
          return skip(deps.runner.running() === null ? 'noText' : 'busy')
        }
        throw err
      }
      // Counted as started, and the text it read remembered, before any answer comes back: a
      // failed run is not retried until the chapter changes again.
      setNotesAutoState(db, {
        day: state.day,
        count: state.count + 1,
        hashes: { ...state.hashes, [chapterId]: hash }
      })
      return { started: true, runId }
    }
  }
}
