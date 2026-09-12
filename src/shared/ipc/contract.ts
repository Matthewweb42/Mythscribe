import { z } from 'zod'
import { EditorSettings } from '../editorSettings'
import { HierarchyLevel, NodeKind, SectionType } from '../labels'
import { Layout } from '../layout'
import { MatterTemplateId } from '../matterTemplates'
import { HEX_COLOR, TAG_NAME_MAX, TagCategory } from '../tags'
import { TagTemplateId } from '../tagTemplates'
import { TiptapNode } from '../tiptap'

/**
 * The single IPC contract shared by main, preload, and renderer.
 * Every channel declares its input and output schema. Main validates inputs,
 * the renderer validates outputs, and both sides are typed from this file.
 */

export const NovelFormat = z.enum(['novel', 'epic', 'webnovel'])
export type NovelFormat = z.infer<typeof NovelFormat>

export const ProjectInfo = z.object({
  id: z.string(),
  name: z.string(),
  format: NovelFormat,
  path: z.string(),
  created: z.string(),
  modified: z.string(),
  lastOpened: z.string(),
  schemaVersion: z.number().int().nonnegative()
})
export type ProjectInfo = z.infer<typeof ProjectInfo>

/** Longest allowed project name; the create wizard validates against the same limit. */
export const PROJECT_NAME_MAX = 200

/** Maximum number of projects remembered on the welcome screen. */
export const RECENTS_MAX = 10

export const RecentProjectEntry = z.object({
  path: z.string(),
  name: z.string(),
  format: NovelFormat,
  lastOpened: z.string()
})
export type RecentProjectEntry = z.infer<typeof RecentProjectEntry>

/** A recent entry as shown to the renderer; `exists` reflects whether the folder is still a project. */
export const RecentProject = RecentProjectEntry.extend({ exists: z.boolean() })
export type RecentProject = z.infer<typeof RecentProject>

/** One row of the document tree (F-1.3, F-2.1): structure and metadata, never content. */
export const TreeNode = z.object({
  id: z.string(),
  parentId: z.string().nullable(),
  sectionType: SectionType.nullable(),
  kind: NodeKind,
  hierarchyLevel: HierarchyLevel.nullable(),
  title: z.string(),
  position: z.number().int(),
  wordCount: z.number().int(),
  matterType: z.string().nullable(),
  preset: z.string().nullable(),
  created: z.string(),
  modified: z.string()
})
export type TreeNode = z.infer<typeof TreeNode>

/** Longest allowed node title (F-2.2). */
export const NODE_TITLE_MAX = 200

/** One tag of the tag bank (F-4.1); `usageCount` is derived from `document_tag`, never stored. */
export const Tag = z.object({
  id: z.string(),
  name: z.string(),
  category: TagCategory,
  color: z.string().regex(HEX_COLOR),
  parentId: z.string().nullable(),
  usageCount: z.number().int().nonnegative(),
  created: z.string(),
  modified: z.string()
})
export type Tag = z.infer<typeof Tag>

export const contract = {
  'app:info': {
    input: z.undefined(),
    output: z.object({ version: z.string(), platform: z.string() })
  },
  'project:create': {
    input: z.object({
      name: z.string().trim().min(1).max(PROJECT_NAME_MAX),
      format: NovelFormat,
      /** When omitted, main shows a native save dialog. */
      directory: z.string().optional()
    }),
    output: ProjectInfo.nullable()
  },
  'project:open': {
    input: z.object({
      /** When omitted, main shows a native open dialog. */
      path: z.string().optional()
    }),
    output: ProjectInfo.nullable()
  },
  'project:close': { input: z.undefined(), output: z.null() },
  'project:current': { input: z.undefined(), output: ProjectInfo.nullable() },
  'recents:list': { input: z.undefined(), output: z.array(RecentProject) },
  'recents:remove': { input: z.object({ path: z.string() }), output: z.array(RecentProject) },
  'tree:list': { input: z.undefined(), output: z.array(TreeNode) },
  'tree:create': {
    input: z.object({
      parentId: z.string(),
      kind: NodeKind,
      hierarchyLevel: HierarchyLevel.nullable(),
      /** Omitted → main fills in "Untitled <level|kind>" from the project's format. */
      title: z.string().trim().min(1).max(NODE_TITLE_MAX).optional(),
      /** Omitted → append as the parent's last child. */
      afterId: z.string().optional(),
      /**
       * Fills the document from a front/end matter template (F-2.6): title (unless `title` is
       * given), content, cached word count, and `matterType`. Only for `kind: 'document'` under
       * the template's own section; anything else is refused with VALIDATION.
       */
      template: MatterTemplateId.optional()
    }),
    output: TreeNode
  },
  'tree:rename': {
    input: z.object({ id: z.string(), title: z.string().trim().min(1).max(NODE_TITLE_MAX) }),
    output: TreeNode
  },
  /** Copies a node and its subtree right after the original (F-2.3): the copy's root first, then its descendants. */
  'tree:duplicate': { input: z.object({ id: z.string() }), output: z.array(TreeNode) },
  /** Deletes a node and everything inside it (F-2.3); later siblings close the gap. */
  'tree:delete': { input: z.object({ id: z.string() }), output: z.null() },
  /**
   * Moves a node (with its subtree) under `parentId` within the same section (F-2.4). Old siblings
   * close the gap, new siblings make room. Returns the moved row.
   */
  'tree:move': {
    input: z.object({
      id: z.string(),
      parentId: z.string(),
      /** Omitted → append as the parent's last child; null → insert first; id → after that sibling. */
      afterId: z.string().nullable().optional()
    }),
    output: TreeNode
  },
  /**
   * The Tiptap JSON of one document (F-3.1); `content` is null until something is written to it.
   * Folders and sections are refused with VALIDATION. `document:save` is the write path.
   */
  'document:get': {
    input: z.object({ id: z.string() }),
    output: z.object({ id: z.string(), content: TiptapNode.nullable() })
  },
  /**
   * Replaces a document's content (F-3.2) and caches its word count on the row. Folders and
   * sections are refused with VALIDATION. Returns the new count and the row's `modified` stamp.
   */
  'document:save': {
    input: z.object({ id: z.string(), content: TiptapNode }),
    output: z.object({ wordCount: z.number().int().nonnegative(), modified: z.string() })
  },
  /**
   * The Tiptap JSON of a node's notes (F-3.7); `notes` is null until something is written.
   * Documents and folders both have notes; section roots are refused with VALIDATION.
   * `notes:save` is the write path.
   */
  'notes:get': {
    input: z.object({ id: z.string() }),
    output: z.object({ id: z.string(), notes: TiptapNode.nullable() })
  },
  /** Replaces a node's notes (F-3.7) and stamps the row's `modified`. Same refusals as `notes:get`. */
  'notes:save': {
    input: z.object({ id: z.string(), notes: TiptapNode }),
    output: z.object({ modified: z.string() })
  },
  /**
   * The project's editor formatting (F-3.6). A missing or unreadable row answers with the
   * format's defaults, so the editor always has something to apply.
   */
  'editorSettings:get': { input: z.undefined(), output: EditorSettings },
  /** Replaces the project's editor formatting (F-3.6); out-of-range values are refused with VALIDATION. */
  'editorSettings:set': { input: EditorSettings, output: EditorSettings },
  /** Every tag of the open project (F-4.1), ordered by name. */
  'tag:list': { input: z.undefined(), output: z.array(Tag) },
  /**
   * Creates a tag (F-4.1). The name is kebab-cased (`toTagName`); a name that empties or collides
   * after normalization is refused with VALIDATION or ALREADY_EXISTS. A missing parent is NOT_FOUND.
   */
  'tag:create': {
    input: z.object({
      name: z.string().trim().min(1).max(TAG_NAME_MAX),
      category: TagCategory,
      /** Omitted → the category's default color. */
      color: z.string().regex(HEX_COLOR).optional(),
      parentId: z.string().nullable().optional()
    }),
    output: Tag
  },
  /**
   * Patches the given fields of a tag (F-4.1); omitted fields keep their value. Same refusals as
   * `tag:create`, plus VALIDATION for a parent that is the tag itself or one of its descendants.
   */
  'tag:update': {
    input: z.object({
      id: z.string(),
      name: z.string().trim().min(1).max(TAG_NAME_MAX).optional(),
      category: TagCategory.optional(),
      color: z.string().regex(HEX_COLOR).optional(),
      parentId: z.string().nullable().optional()
    }),
    output: Tag
  },
  /** Deletes a tag (F-4.1): its document links go with it, its child tags become top-level. */
  'tag:delete': { input: z.object({ id: z.string() }), output: z.null() },
  /**
   * Loads a tag template (F-4.3): creates every template tag whose normalized name is not already
   * in the bank, using the category's default color; existing names are skipped, not overwritten.
   */
  'tag:loadTemplate': {
    input: z.object({ template: TagTemplateId }),
    output: z.object({ created: z.array(Tag), skipped: z.array(z.string()) })
  },
  /** The app-wide panel layout (F-7.2) from app-state.json; the defaults until one has been saved. */
  'layout:get': { input: z.undefined(), output: Layout },
  /** Replaces the panel layout (F-7.2); sizes outside the panel limits are refused with VALIDATION. */
  'layout:set': { input: Layout, output: Layout },
  /** Closes the project and every window once the renderer has flushed its pending saves. */
  'window:close': { input: z.undefined(), output: z.null() },
  /** The renderer could not flush, so the close it was asked for (and any quit behind it) is abandoned. */
  'window:close-cancelled': { input: z.undefined(), output: z.null() }
} as const satisfies Record<string, { input: z.ZodType; output: z.ZodType }>

export type Contract = typeof contract
export type Channel = keyof Contract
export type Input<C extends Channel> = z.input<Contract[C]['input']>
export type Output<C extends Channel> = z.output<Contract[C]['output']>
export const channels = Object.keys(contract) as Channel[]

export type TreeCreateInput = Input<'tree:create'>
export type TreeMoveInput = Input<'tree:move'>
export type TagCreateInput = Input<'tag:create'>
export type TagUpdateInput = Input<'tag:update'>
export type TagLoadTemplateInput = Input<'tag:loadTemplate'>

/** Events pushed from main to the renderer. */
export const events = {
  'project:changed': ProjectInfo.nullable(),
  /** The OS asked to close the window while a project is open; the renderer flushes, then invokes `window:close`. */
  'window:close-requested': z.null()
} as const satisfies Record<string, z.ZodType>

export type Events = typeof events
export type EventName = keyof Events
export type EventPayload<E extends EventName> = z.output<Events[E]>
export const eventNames = Object.keys(events) as EventName[]

export const IpcErrorCode = z.enum([
  'CANCELLED',
  'VALIDATION',
  'NOT_FOUND',
  'ALREADY_EXISTS',
  'NO_PROJECT',
  'IO',
  'INTERNAL'
])
export type IpcErrorCode = z.infer<typeof IpcErrorCode>

export const IpcError = z.object({
  code: IpcErrorCode,
  message: z.string(),
  details: z.unknown().optional()
})
export type IpcError = z.infer<typeof IpcError>

export type IpcResult<T> = { ok: true; data: T } | { ok: false; error: IpcError }

/** Shape of the bridge exposed on `window.mythscribe` by the preload script. */
export interface IpcBridge {
  invoke: (channel: Channel, input: unknown) => Promise<IpcResult<unknown>>
  on: (event: EventName, listener: (payload: unknown) => void) => () => void
}
