import type { AgentProject } from './agentTools'
import { positionNote } from './context/storyTime'

/**
 * Where a scene stands for one agent run (F-5.23, F-5.24): its index in reading order, now's,
 * the refs behind a value, and the head a v6 tool gives a scene. Shared by the v1 tools
 * (`agentTools.ts`) and the story-memory v2 ones (`agentToolsV2.ts`, F-16.4).
 */

/** A scene's index in reading order; -1 for an undated statement, past the end for one outside it. */
export function readingIndex(project: AgentProject, nodeId: string | null): number {
  if (nodeId === null) return -1
  const at = project.time.order.indexOf(nodeId)
  return at === -1 ? project.time.order.length : at
}

/** Now's index in reading order; with no now, the end of the book. */
export function nowIndex(project: AgentProject): number {
  const at = project.time.nowId === null ? -1 : project.time.order.indexOf(project.time.nowId)
  return at === -1 ? project.time.order.length : at
}

/** The refs of the scenes behind a value, in order, without repeats. */
export function refsOf(project: AgentProject, nodeIds: readonly (string | null)[]): string {
  const refs = [
    ...new Set(
      nodeIds.flatMap((id) => {
        const ref = id === null ? undefined : project.refOf.get(id)
        return ref === undefined ? [] : [ref]
      })
    )
  ]
  return refs.length > 0 ? ` (${refs.join(', ')})` : ''
}

/** `n7 Chapter 1 › The ferry landing (before now: has happened)`, as the v6 tools head a scene. */
export function sceneHead(project: AgentProject, nodeId: string): string {
  return `${project.refOf.get(nodeId) ?? '?'} ${project.titleOf(nodeId)} (${positionNote(project.time, nodeId)})`
}
