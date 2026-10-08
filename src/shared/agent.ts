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

/**
 * 2026-10-07 (author report: a draft inside the JSON reply hit the cap and the raw JSON showed):
 * prose never travels inside a step. The model names what to write (`brief`, `words`) and where;
 * the app drafts the prose afterwards through the voice-checked drafting path and streams it into
 * the editor as ghost text (an insertion) or into the change card (a rewrite of a passage).
 */
/** The `max_tokens` one step asks for; small, since a step carries no prose any more. */
export const AGENT_STEP_MAX_TOKENS = 1_500
/** What the one retry of a reply that was cut off or did not parse asks for (`outputBudget('agent')`). */
export const AGENT_RETRY_MAX_TOKENS = 3_000
/** The longest brief an edit may carry: what to write, in a sentence or two. */
export const AGENT_BRIEF_MAX = 600
/** The length an insertion may ask for, in words; outside it the ask is clamped. */
export const AGENT_WORDS_MIN = 20
export const AGENT_WORDS_MAX = 900
/** The length of an insertion that names none. */
export const AGENT_WORDS_DEFAULT = 150
/** What the chat says when a step's reply was still cut off or unreadable after the retry. */
export const AGENT_CUT_OFF_MESSAGE =
  "The model's reply was cut off. Try again, or pick a faster model in Settings › AI."

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
/** What the app is to write (2026-10-07); empty for an edit that carries its text itself. */
const Brief = z.string().max(AGENT_BRIEF_MAX).default('')

/**
 * One edit as main resolved it: real ids, the titles the chat names them by, and for a
 * replacement the current value it replaces (`before`), so the Ask view can show what goes.
 */
export const AgentEdit = z.discriminatedUnion('kind', [
  /**
   * Replace one passage of a document (`replace` empty removes it). With a `brief` (2026-10-07)
   * the replacement is drafted by the app: `replace` stays empty until the draft is in.
   */
  z.object({
    kind: z.literal('text'),
    ...NodeRef,
    find: Passage.min(1),
    replace: Passage,
    brief: Brief
  }),
  /**
   * New prose after the paragraph holding `after` (empty: at the caret of the open document,
   * else at the end). With a `brief` (2026-10-07) the app drafts it at `words` words and streams
   * it into the editor as ghost text; `text` holds what the author accepted, empty until then.
   * Without one (an older turn) `text` is the prose itself.
   */
  z.object({
    kind: z.literal('insert'),
    ...NodeRef,
    after: Passage,
    text: Passage,
    brief: Brief,
    words: z.number().int().min(0).max(AGENT_WORDS_MAX).default(0)
  }),
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

/**
 * Where an edit stands. 2026-10-07: `writing` while the app drafts an edit's prose (streaming
 * into the editor or the card), `shown` while a drafted insertion waits in the editor as ghost
 * text for Tab or Escape (or the card's Accept and Dismiss). Neither survives a reload: a turn
 * stored in either is read back as `pending` (`settledAfterReload`).
 */
export const AGENT_CHANGE_STATUSES = [
  'pending',
  'writing',
  'shown',
  'applied',
  'skipped',
  'undone',
  'failed'
] as const
export const AgentChangeStatus = z.enum(AGENT_CHANGE_STATUSES)
export type AgentChangeStatus = z.infer<typeof AgentChangeStatus>

/** One edit on its turn, with where it stands. */
export const AgentChange = z.object({
  id: z.string(),
  edit: AgentEdit,
  status: AgentChangeStatus,
  /** The voice check's complaint about the edit's prose (F-14.7); such an edit asks even in Auto. */
  violation: z.string().nullable(),
  /** Why applying or undoing it failed, shown on the line. */
  error: z.string().nullable(),
  /**
   * 2026-10-07: the proposal of the prose the app drafted for this edit (F-14.5), which its
   * accepted text is marked with (F-14.6); null for an edit whose text came with the answer.
   */
  proposalId: z.string().nullable().default(null),
  /**
   * 2026-10-07: what the author should know about how the edit landed ("“…” is not in the
   * scene; placed at the caret instead."), shown on its line; null for nothing to say.
   */
  notice: z.string().nullable().default(null)
})
export type AgentChange = z.infer<typeof AgentChange>

/** A change as a reload finds it: a draft that was in flight or showing is waiting again. */
export function settledAfterReload(change: AgentChange): AgentChange {
  return change.status === 'writing' || change.status === 'shown'
    ? { ...change, status: 'pending' }
    : change
}

/** An insertion whose prose the app drafts (2026-10-07): a brief and no text yet. */
export function isDraftIntent(edit: AgentEdit): boolean {
  return edit.kind === 'insert' && edit.brief !== '' && edit.text === ''
}

/** A rewrite of a passage whose replacement the app drafts (2026-10-07): a brief, no replacement yet. */
export function isRewriteIntent(edit: AgentEdit): boolean {
  return edit.kind === 'text' && edit.brief !== '' && edit.replace === ''
}

/** What an agent turn carries beside its answer text (stored with the conversation). */
export const AgentTurn = z.object({
  access: AgentAccess,
  steps: z.array(AgentStep),
  changes: z.array(AgentChange)
})
export type AgentTurn = z.infer<typeof AgentTurn>

/** Deleting or merging away scenes, chapters, sheets, or tags: these ask even in Auto. */
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
      if (isRewriteIntent(edit)) return `Rewrite a passage of ${edit.title}`
      return edit.replace === '' ? `Cut a passage from ${edit.title}` : `Changed ${edit.title}`
    case 'insert':
      return isDraftIntent(edit) ? `Write in ${edit.title}` : `Added to ${edit.title}`
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
