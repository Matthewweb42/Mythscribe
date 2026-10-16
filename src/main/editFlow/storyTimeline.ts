import type { AgentEdit } from '@shared/agent'
import { normalizeForMatch } from '@shared/critique'
import { docToText } from '@shared/docText'
import { STORY_TIMELINE_TITLE, type NotebookItem } from '@shared/notebook'
import type { TiptapNodeT } from '@shared/tiptap'
import {
  createNotebookItem,
  getNotebookPage,
  listNotebook,
  notebookSectionId,
  updateNotebookItem
} from '../notebook/notebookStore'
import { folderPath } from '../scribe2/source'
import { notebookEdit, type ScribeRun } from '../scribe2/tools'
import type { ParsedTimelineEvent } from './parse'

/**
 * The Story timeline page (the notes binder, 2026-10-16, `editNotes.v2`): the edit flow's Update
 * notes keeps one page in the Timeline section, one line per event in story order. Each event is
 * inserted after the line the model says it follows (else at the end; `''` opens the page), a
 * line the page already has is skipped, and nothing on the page is removed or changed: the
 * author's own lines, headings and formatting stay as they are. The page is made the first time an
 * update has an event (never empty), and every write keeps a version for Undo.
 */

const fold = (text: string): string => normalizeForMatch(text).toLowerCase()

const blockText = (block: TiptapNodeT): string => docToText({ type: 'doc', content: [block] })

const paragraph = (text: string): TiptapNodeT => ({
  type: 'paragraph',
  content: [{ type: 'text', text }]
})

/** The block an anchor names: the same line, else the one line that holds it; -1 for none. */
function anchorIndex(blocks: readonly TiptapNodeT[], after: string): number {
  const wanted = fold(after)
  if (wanted === '') return -1
  const texts = blocks.map((block) => fold(blockText(block)))
  const same = texts.indexOf(wanted)
  if (same >= 0) return same
  if (wanted.length < 8) return -1
  const holding = texts.flatMap((text, at) => (text !== '' && text.includes(wanted) ? [at] : []))
  return holding.length === 1 ? (holding[0] ?? -1) : -1
}

/**
 * The page's blocks with `events` inserted in story order (pure): each after the block its
 * `after` names (or the event inserted before it in this batch that followed the same line, so
 * events that share an anchor keep their order), at the top for `''`, at the end otherwise. An
 * event whose line the page already has is skipped. Answers the blocks and the lines added.
 */
export function insertTimelineEvents(
  blocks: readonly TiptapNodeT[],
  events: readonly ParsedTimelineEvent[]
): { blocks: TiptapNodeT[]; added: string[] } {
  const out = [...blocks]
  const added: string[] = []
  const seen = new Set(out.map((block) => fold(blockText(block))))
  /** The last block inserted after each anchor (by the anchor block; `null` for the top). */
  const lastAfter = new Map<TiptapNodeT | null, TiptapNodeT>()
  for (const event of events) {
    const key = fold(event.line)
    if (key === '' || seen.has(key)) continue
    seen.add(key)
    const block = paragraph(event.line)
    let anchor: TiptapNodeT | null | undefined
    if (event.after === '') anchor = null
    else if (event.after !== null) {
      const at = anchorIndex(out, event.after)
      anchor = at < 0 ? undefined : out[at]
    }
    if (anchor === undefined) {
      out.push(block)
    } else {
      const previous = lastAfter.get(anchor)
      const base = previous ?? anchor
      const at = base === null ? -1 : out.indexOf(base)
      out.splice(at + 1, 0, block)
      lastAfter.set(anchor, block)
    }
    added.push(event.line)
  }
  return { blocks: out, added }
}

/** The Story timeline page in the Timeline section (by its title, any case), or undefined. */
export function storyTimelinePage(
  items: readonly NotebookItem[],
  timelineId: string
): NotebookItem | undefined {
  const title = fold(STORY_TIMELINE_TITLE)
  return items.find(
    (item) => item.kind === 'page' && item.parentId === timelineId && fold(item.title) === title
  )
}

/**
 * Writes Update notes' events into the Story timeline page, made in the Timeline section when it
 * is missing and there is an event to put on it. The write is one of the run's note changes (its
 * Undo restores the version kept, or deletes the page it made). Answers that change, or null when
 * nothing was added.
 */
export function applyStoryTimeline(
  run: ScribeRun,
  events: readonly ParsedTimelineEvent[]
): AgentEdit | null {
  if (events.length === 0) return null
  const timelineId = notebookSectionId(run.db, 'timeline')
  const items = listNotebook(run.db)
  const existing = storyTimelinePage(items, timelineId)
  let edit: AgentEdit
  let pageId: string
  if (existing === undefined) {
    const { blocks, added } = insertTimelineEvents([], events)
    if (added.length === 0) return null
    const page = createNotebookItem(run.db, {
      parentId: timelineId,
      kind: 'page',
      title: STORY_TIMELINE_TITLE,
      content: { type: 'doc', content: blocks }
    })
    run.pages.push({
      ref: `p${run.pages.length + 1}`,
      id: page.id,
      kind: 'note',
      title: page.title,
      folder: folderPath(listNotebook(run.db), page.parentId),
      text: page.plain
    })
    pageId = page.id
    edit = notebookEdit(page.id, page.title, true, null, null, '', page.plain)
  } else {
    const current = getNotebookPage(run.db, existing.id)
    const { blocks, added } = insertTimelineEvents(current.content?.content ?? [], events)
    if (added.length === 0) return null
    const { page, versionId } = updateNotebookItem(
      run.db,
      { id: existing.id, content: { type: 'doc', content: blocks } },
      'ai'
    )
    const known = run.pages.find((each) => each.id === page.id)
    if (known !== undefined) known.text = page.plain
    pageId = page.id
    edit = notebookEdit(page.id, page.title, false, versionId, null, current.plain, page.plain)
  }
  run.notebookChanged([pageId])
  run.used.add(pageId)
  run.changes.push({ proposal: { edit, violation: null }, applied: true })
  return edit
}
