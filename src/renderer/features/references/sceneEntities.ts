import type { Entity } from '@shared/ipc/contract'
import type { TagMentions } from '@shared/mentions'
import { useActiveEditorStore } from '@renderer/features/editor/activeEditorStore'
import { useTreeStore } from '@renderer/features/manuscript/treeStore'

/**
 * The entities named in one scene (F-9.7), as ids in the order the panel shows them: an entity
 * is in the scene when its linked tag (F-9.4) was found by the mention scan (F-4.12) or is
 * linked to the scene (F-4.4). Those the text names come first, in the order of their first
 * occurrence; those only tagged follow, by name. An entity without a tag cannot be found and is
 * left out. Pure: nothing here scans text or asks main.
 */
export function sceneEntityIds(
  entities: readonly Entity[],
  mentions: readonly TagMentions[],
  tagIds: readonly string[]
): string[] {
  const firstAt = new Map<string, number>()
  for (const mention of mentions) {
    const starts = mention.ranges.map(([from]) => from)
    // A row whose positions could not be read still says the name occurs; it sorts last.
    firstAt.set(mention.tagId, starts.length > 0 ? Math.min(...starts) : Number.MAX_SAFE_INTEGER)
  }
  const linked = new Set(tagIds)
  const named: { entity: Entity; at: number }[] = []
  const tagged: Entity[] = []
  for (const entity of entities) {
    if (entity.tagId === null) continue
    const at = firstAt.get(entity.tagId)
    if (at !== undefined) named.push({ entity, at })
    else if (linked.has(entity.tagId)) tagged.push(entity)
  }
  named.sort((a, b) => a.at - b.at || a.entity.name.localeCompare(b.entity.name))
  tagged.sort((a, b) => a.name.localeCompare(b.name))
  return [...named.map(({ entity }) => entity.id), ...tagged.map((entity) => entity.id)]
}

/**
 * The scene the author has open (F-9.7): the selected document, or, for a selected folder shown
 * as a stack, the document whose editor they last worked in. null when neither is a document.
 * An open entity page leaves the tree selection alone, so its scene stays the open one.
 */
export function useOpenSceneId(): string | null {
  const selected = useTreeStore((s) => (s.selectedId === null ? undefined : s.byId[s.selectedId]))
  const activeId = useActiveEditorStore((s) => s.active?.id ?? null)
  const active = useTreeStore((s) => (activeId === null ? undefined : s.byId[activeId]))
  if (selected?.kind === 'document') return selected.id
  if (selected !== undefined && active?.kind === 'document') return active.id
  return null
}
