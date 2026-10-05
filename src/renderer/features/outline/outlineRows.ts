export interface OutlineRowEntry {
  id: string
  depth: number
}

/**
 * The manuscript section's nodes depth-first in tree order (reading order), the section root
 * itself left out. Shared by the Outline tab's outline (F-11.1) and its beat board (F-11.1b).
 */
export function listOutline(
  rootIds: string[],
  childrenOf: Record<string, string[]>,
  sectionOf: Record<string, string>
): OutlineRowEntry[] {
  const root = rootIds.find((id) => sectionOf[id] === 'manuscript')
  if (root === undefined) return []
  const rows: OutlineRowEntry[] = []
  const walk = (ids: string[], depth: number): void => {
    for (const id of ids) {
      rows.push({ id, depth })
      walk(childrenOf[id] ?? [], depth + 1)
    }
  }
  walk(childrenOf[root] ?? [], 0)
  return rows
}
