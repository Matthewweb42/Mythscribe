import { z } from 'zod'
import { HierarchyLevel, NodeKind, SectionType } from '../labels'

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
  /** Closes the project and every window once the renderer has flushed its pending saves. */
  'window:close': { input: z.undefined(), output: z.null() }
} as const satisfies Record<string, { input: z.ZodType; output: z.ZodType }>

export type Contract = typeof contract
export type Channel = keyof Contract
export type Input<C extends Channel> = z.input<Contract[C]['input']>
export type Output<C extends Channel> = z.output<Contract[C]['output']>
export const channels = Object.keys(contract) as Channel[]

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
