import { z } from 'zod'
import { EntityFieldId } from './entities'
import { SCENE_SYNOPSIS_MAX } from './sceneMeta'

/**
 * The chat agent (F-5.22, the author's decisions of 2026-10-06): the assistant looks up what it
 * needs in the whole project before it answers (search, the outline, scenes, notes, summaries,
 * story-bible sheets, tags), mostly about the open document, and may propose edits to any of it.
 * The provider layer and the Cloud Worker have no native tool calling, so the agent is a JSON
 * protocol over the one request path: each step the model names one tool, main runs it and hands
 * back a compact result, until the model answers. Every step shows live in the chat.
 *
 * Edits never touch the book in main. They come back as typed records; at Ask each waits for
 * Apply in the chat (the current text with what goes struck through and what comes in another
 * colour), at Auto the renderer applies them through the same store actions the author's own
 * clicks use and logs each with Undo. Deletions always ask (F-5.21).
 */

/** Tool calls per message before the model must answer (the answer is one more request). */
export const AGENT_MAX_STEPS = 6
/** What one message may spend across all its steps; past it the model must answer at once. */
export const AGENT_COST_CAP_USD = 0.5
/** Characters of a scene one `read_scene` call returns; the model pages on with `from`. */
export const AGENT_READ_CHARS = 6_000
/** Characters any one tool result may take in the prompt. */
export const AGENT_RESULT_CHARS = 6_000
/** Scenes one `search` names. */
export const AGENT_SEARCH_RESULTS = 8
/** The open document's text before the caret that rides along with every message. */
export const AGENT_CARET_CHARS = 1_500
/** The selected passage that rides along, cut to this many characters. */
export const AGENT_SELECTION_CHARS = 2_000
/** The open document's notes that ride along (its synopsis rides whole). */
export const AGENT_NOTES_CHARS = 1_500
/** Edits one answer may carry; the rest are dropped and counted. */
export const AGENT_MAX_EDITS = 8
/** The longest passage an edit may find, replace, or add. */
export const AGENT_EDIT_TEXT_MAX = 4_000
/** A title an edit may set (the tree's own cap). */
export const AGENT_TITLE_MAX = 200
/** The answer text is cut to this many characters. */
export const AGENT_ANSWER_MAX = 4_000
/** Citations kept per answer. */
export const AGENT_MAX_CITATIONS = 6

/** What a run may do: `read` answers only (Query); `write` may also propose edits (Auto). */
export const AGENT_ACCESS = ['read', 'write'] as const
export const AgentAccess = z.enum(AGENT_ACCESS)
export type AgentAccess = z.infer<typeof AgentAccess>

/** The read tools, as the model names them. */
export const AGENT_TOOLS = [
  'search',
  'outline',
  'read_scene',
  'read_notes',
  'read_summary',
  'read_sheet',
  'list_sheets',
  'tags'
] as const
export const AgentTool = z.enum(AGENT_TOOLS)
export type AgentTool = z.infer<typeof AgentTool>

/** One step as the chat shows it while the answer is on its way ("Searching "ledger"…"). */
export const AgentStep = z.object({
  tool: AgentTool,
  label: z.string().max(300)
})
export type AgentStep = z.infer<typeof AgentStep>

const Passage = z.string().max(AGENT_EDIT_TEXT_MAX)
const NodeRef = { nodeId: z.string(), title: z.string() }

/**
 * One edit as main resolved it: real ids, the titles the chat names them by, and for a
 * replacement the current value it replaces (`before`), so the Ask view can show what goes.
 */
export const AgentEdit = z.discriminatedUnion('kind', [
  /** Replace one passage of a document (`replace` empty removes it). */
  z.object({ kind: z.literal('text'), ...NodeRef, find: Passage.min(1), replace: Passage }),
  /** New paragraphs after the paragraph holding `after` (empty: at the end of the document). */
  z.object({ kind: z.literal('insert'), ...NodeRef, after: Passage, text: Passage.min(1) }),
  z.object({
    kind: z.literal('synopsis'),
    ...NodeRef,
    before: z.string(),
    after: z.string().max(SCENE_SYNOPSIS_MAX)
  }),
  /** Points appended to a document's notes, one per paragraph. */
  z.object({ kind: z.literal('notes'), ...NodeRef, add: Passage.min(1) }),
  z.object({
    kind: z.literal('sheet'),
    entityId: z.string(),
    name: z.string(),
    field: EntityFieldId,
    label: z.string(),
    before: z.string(),
    after: Passage
  }),
  z.object({
    kind: z.literal('create'),
    level: z.enum(['chapter', 'scene']),
    parentId: z.string(),
    parentTitle: z.string(),
    /** The sibling it goes after; null: the parent's last child. */
    afterId: z.string().nullable(),
    title: z.string().min(1).max(AGENT_TITLE_MAX),
    /** A new scene's opening text; empty for none (always, for a chapter). */
    text: Passage
  }),
  /** `title` is the current one. */
  z.object({
    kind: z.literal('rename'),
    ...NodeRef,
    after: z.string().min(1).max(AGENT_TITLE_MAX)
  }),
  z.object({
    kind: z.literal('move'),
    ...NodeRef,
    parentId: z.string(),
    parentTitle: z.string(),
    /** null: first in the parent. */
    afterId: z.string().nullable()
  }),
  /** The paragraph holding `at` and everything after it become a new scene right after this one. */
  z.object({
    kind: z.literal('split'),
    ...NodeRef,
    at: Passage.min(1),
    newTitle: z.string().min(1).max(AGENT_TITLE_MAX)
  }),
  /** This document's text joins the end of `intoId`'s and this document is deleted. */
  z.object({ kind: z.literal('merge'), ...NodeRef, intoId: z.string(), intoTitle: z.string() }),
  z.object({ kind: z.literal('tag'), ...NodeRef, tag: z.string().min(1), add: z.boolean() }),
  z.object({
    kind: z.literal('delete'),
    target: z.enum(['node', 'sheet', 'tag']),
    id: z.string(),
    name: z.string()
  })
])
export type AgentEdit = z.infer<typeof AgentEdit>
export type AgentEditKind = AgentEdit['kind']

export const AGENT_CHANGE_STATUSES = ['pending', 'applied', 'skipped', 'undone', 'failed'] as const
export const AgentChangeStatus = z.enum(AGENT_CHANGE_STATUSES)
export type AgentChangeStatus = z.infer<typeof AgentChangeStatus>

/** One edit on its turn, with where it stands. */
export const AgentChange = z.object({
  id: z.string(),
  edit: AgentEdit,
  status: AgentChangeStatus,
  /** The voice check's complaint about the edit's prose (F-14.7); such an edit asks even at Auto. */
  violation: z.string().nullable(),
  /** Why applying or undoing it failed, shown on the line. */
  error: z.string().nullable()
})
export type AgentChange = z.infer<typeof AgentChange>

/** What an agent turn carries beside its answer text (stored with the conversation). */
export const AgentTurn = z.object({
  access: AgentAccess,
  steps: z.array(AgentStep),
  changes: z.array(AgentChange)
})
export type AgentTurn = z.infer<typeof AgentTurn>

/** Deleting or merging away scenes, chapters, sheets, or tags: these ask even at Auto. */
export function isDeletion(edit: AgentEdit): boolean {
  return edit.kind === 'delete' || edit.kind === 'merge'
}

/** Prose the edit puts into the book, which the voice check reads; empty for none. */
export function editProse(edit: AgentEdit): string {
  switch (edit.kind) {
    case 'text':
      return edit.replace
    case 'insert':
      return edit.text
    case 'create':
      return edit.text
    default:
      return ''
  }
}

const TARGET_NOUN: Record<Extract<AgentEdit, { kind: 'delete' }>['target'], string> = {
  node: '',
  sheet: 'the sheet ',
  tag: 'the tag #'
}

/** One line naming the edit, the way the chat's log and the Ask card head it. */
export function describeEdit(edit: AgentEdit): string {
  switch (edit.kind) {
    case 'text':
      return edit.replace === '' ? `Cut a passage from ${edit.title}` : `Changed ${edit.title}`
    case 'insert':
      return `Added to ${edit.title}`
    case 'synopsis':
      return `Set the synopsis of ${edit.title}`
    case 'notes':
      return `Added to the notes of ${edit.title}`
    case 'sheet':
      return `Changed ${edit.name}: ${edit.label}`
    case 'create':
      return `Created the ${edit.level} “${edit.title}” in ${edit.parentTitle}`
    case 'rename':
      return `Renamed ${edit.title} to “${edit.after}”`
    case 'move':
      return `Moved ${edit.title} into ${edit.parentTitle}`
    case 'split':
      return `Split ${edit.title}; the rest is “${edit.newTitle}”`
    case 'merge':
      return `Merge ${edit.title} into ${edit.intoTitle}`
    case 'tag':
      return edit.add
        ? `Tagged ${edit.title} #${edit.tag}`
        : `Removed #${edit.tag} from ${edit.title}`
    case 'delete':
      return `Delete ${TARGET_NOUN[edit.target]}${edit.name}`
  }
}

/** What the open document contributes to every run: the caret window and the selection. */
export const AgentFocus = z.object({
  /** Text before the caret, at most `AGENT_CARET_CHARS`; empty with no editor. */
  beforeCaret: z.string().max(AGENT_CARET_CHARS),
  /** The selected passage, at most `AGENT_SELECTION_CHARS`; empty for a caret. */
  selection: z.string().max(AGENT_SELECTION_CHARS)
})
export type AgentFocus = z.infer<typeof AgentFocus>
