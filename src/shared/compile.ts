import { z } from 'zod'
import { HierarchyLevel, NodeKind } from './labels'
import { SceneMeta } from './sceneMeta'
import { TiptapNode } from './tiptap'

/**
 * The compiled preview (F-3.12): the manuscript section read top to bottom as one read-only
 * text. Main walks the manuscript root's descendants in reading order and answers one entry per
 * node; the renderer decides what each prints (a part or chapter its title as a heading, a scene
 * its metadata header, a document its text).
 */

/** The metadata fields a scene header shows: Location, Time (the timeline field), and POV. */
export const CompiledSceneMeta = SceneMeta.pick({ location: true, pov: true, timeline: true })
export type CompiledSceneMeta = z.infer<typeof CompiledSceneMeta>

/** A tag linked to a node, with what a chip needs to paint. */
export const CompiledTag = z.object({ id: z.string(), name: z.string(), color: z.string() })
export type CompiledTag = z.infer<typeof CompiledTag>

export const CompiledEntry = z.object({
  id: z.string(),
  kind: NodeKind,
  level: HierarchyLevel.nullable(),
  /** 0 for a child of the manuscript root, one more per folder below it. */
  depth: z.number().int().nonnegative(),
  title: z.string(),
  /** Null unless one of the shown fields has text. */
  meta: CompiledSceneMeta.nullable(),
  /** The tags linked to the node (F-4.4), in name order. */
  tags: z.array(CompiledTag),
  /** The document's text; null for a folder and for a document with no readable content. */
  content: TiptapNode.nullable()
})
export type CompiledEntry = z.infer<typeof CompiledEntry>

export const CompiledManuscript = z.object({ entries: z.array(CompiledEntry) })
export type CompiledManuscript = z.infer<typeof CompiledManuscript>

/** The scene header's fields, or null when every one is empty (whitespace counts as empty). */
export function compiledSceneMeta(meta: CompiledSceneMeta): CompiledSceneMeta | null {
  const trimmed = {
    location: meta.location.trim(),
    pov: meta.pov.trim(),
    timeline: meta.timeline.trim()
  }
  return trimmed.location || trimmed.pov || trimmed.timeline ? trimmed : null
}
