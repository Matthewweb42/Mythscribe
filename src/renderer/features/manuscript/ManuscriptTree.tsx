import { useMemo, useRef } from 'react'
import {
  BookOpen,
  ChevronDown,
  ChevronRight,
  File,
  FileText,
  Folder,
  FolderOpen,
  Layers
} from 'lucide-react'
import type { NovelFormat, TreeNode } from '@shared/ipc/contract'
import { sectionLabel, type SectionType } from '@shared/labels'
import { useTreeStore } from './treeStore'

interface VisibleRow {
  id: string
  depth: number
}

/** Depth-first list of the rows currently on screen, in display order (collapsed subtrees skipped). */
function listVisibleRows(
  rootIds: string[],
  childrenOf: Record<string, string[]>,
  collapsed: Record<string, boolean>
): VisibleRow[] {
  const rows: VisibleRow[] = []
  const walk = (ids: string[], depth: number): void => {
    for (const id of ids) {
      rows.push({ id, depth })
      if (!collapsed[id]) walk(childrenOf[id] ?? [], depth + 1)
    }
  }
  walk(rootIds, 1)
  return rows
}

function levelColor(node: TreeNode, section: SectionType): string {
  if (node.kind === 'document' && section !== 'manuscript') return 'text-matter'
  switch (node.hierarchyLevel) {
    case 'part':
      return 'text-level-part'
    case 'chapter':
      return 'text-level-chapter'
    case 'scene':
      return 'text-level-scene'
    case null:
      return 'text-level-generic'
  }
}

/** Per-level icon: sections and generic folders show a folder, levels their own glyph, generic documents a plain file. */
function LevelIcon({
  node,
  expanded,
  className
}: {
  node: TreeNode
  expanded: boolean
  className: string
}): React.JSX.Element {
  const props = { size: 14, 'aria-hidden': true, className }
  if (node.sectionType !== null || (node.kind === 'folder' && node.hierarchyLevel === null)) {
    return expanded ? <FolderOpen {...props} /> : <Folder {...props} />
  }
  switch (node.hierarchyLevel) {
    case 'part':
      return <Layers {...props} />
    case 'chapter':
      return <BookOpen {...props} />
    case 'scene':
      return <FileText {...props} />
    case null:
      return <File {...props} />
  }
}

interface TreeItemProps {
  id: string
  depth: number
  format: NovelFormat
  activeId: string | null
  register: (id: string, element: HTMLLIElement | null) => void
}

function TreeItem({
  id,
  depth,
  format,
  activeId,
  register
}: TreeItemProps): React.JSX.Element | null {
  const node = useTreeStore((s) => s.byId[id])
  const childIds = useTreeStore((s) => s.childrenOf[id])
  const section = useTreeStore((s) => s.sectionOf[id] ?? 'manuscript')
  const wordCount = useTreeStore((s) => s.wordCountRollup[id] ?? 0)
  const collapsed = useTreeStore((s) => s.collapsed[id] === true)
  const selected = useTreeStore((s) => s.selectedId === id)
  const select = useTreeStore((s) => s.select)
  const toggle = useTreeStore((s) => s.toggle)
  if (!node) return null

  const isSection = node.sectionType !== null
  const isFolder = node.kind === 'folder'
  const expanded = isFolder && !collapsed
  const label = node.sectionType ? sectionLabel(format, node.sectionType) : node.title
  const isMatter = node.kind === 'document' && section !== 'manuscript'

  return (
    <li
      ref={(element) => register(id, element)}
      role="treeitem"
      aria-label={label}
      aria-level={depth}
      aria-expanded={isFolder ? expanded : undefined}
      aria-selected={selected}
      data-node-id={id}
      data-matter={isMatter ? 'true' : undefined}
      tabIndex={activeId === id ? 0 : -1}
      className="m-0 list-none p-0 outline-none"
    >
      <div
        onClick={() => (isSection ? toggle(id) : select(id))}
        style={{ paddingLeft: depth * 12 + 8 }}
        className={`flex h-7 cursor-default items-center gap-1 rounded-md pr-2 text-sm select-none ${
          selected ? 'bg-accent/15 text-fg' : 'hover:bg-surface-raised'
        } ${isSection ? 'font-medium tracking-wide uppercase text-xs text-fg-muted' : ''}`}
      >
        {isFolder ? (
          <button
            type="button"
            tabIndex={-1}
            aria-label={`${expanded ? 'Collapse' : 'Expand'} ${label}`}
            onClick={(event) => {
              event.stopPropagation()
              toggle(id)
            }}
            className="flex h-4 w-4 shrink-0 items-center justify-center rounded text-fg-subtle hover:text-fg"
          >
            {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          </button>
        ) : (
          <span aria-hidden="true" className="h-4 w-4 shrink-0" />
        )}
        <LevelIcon
          node={node}
          expanded={expanded}
          className={`shrink-0 ${levelColor(node, section)}`}
        />
        <span className="min-w-0 flex-1 truncate">{label}</span>
        <span aria-hidden="true" className="ml-auto text-xs text-fg-subtle tabular-nums">
          {wordCount.toLocaleString()}
        </span>
      </div>
      {isFolder && expanded && childIds && childIds.length > 0 ? (
        <ul role="group" className="m-0 list-none p-0">
          {childIds.map((childId) => (
            <TreeItem
              key={childId}
              id={childId}
              depth={depth + 1}
              format={format}
              activeId={activeId}
              register={register}
            />
          ))}
        </ul>
      ) : null}
    </li>
  )
}

/**
 * The document tree (F-2.1): the three sections and their nested folders and documents, with
 * collapse/expand, per-level icons and colors, rolled-up word counts, and the active document
 * highlighted. Reads `useTreeStore`; the parent decides when to `load()`.
 */
export function ManuscriptTree({ format }: { format: NovelFormat }): React.JSX.Element | null {
  const loaded = useTreeStore((s) => s.loaded)
  const rootIds = useTreeStore((s) => s.rootIds)
  const childrenOf = useTreeStore((s) => s.childrenOf)
  const collapsed = useTreeStore((s) => s.collapsed)
  const selectedId = useTreeStore((s) => s.selectedId)
  const byId = useTreeStore((s) => s.byId)
  const select = useTreeStore((s) => s.select)
  const toggle = useTreeStore((s) => s.toggle)
  const items = useRef(new Map<string, HTMLLIElement>())

  const rows = useMemo(
    () => listVisibleRows(rootIds, childrenOf, collapsed),
    [rootIds, childrenOf, collapsed]
  )
  const selectedVisible = selectedId !== null && rows.some((row) => row.id === selectedId)
  const activeId = selectedVisible ? selectedId : (rows[0]?.id ?? null)

  const register = (id: string, element: HTMLLIElement | null): void => {
    if (element) items.current.set(id, element)
    else items.current.delete(id)
  }
  const focusItem = (id: string | null): void => {
    if (id) items.current.get(id)?.focus()
  }

  const onKeyDown = (event: React.KeyboardEvent<HTMLUListElement>): void => {
    if (!(event.target instanceof HTMLElement)) return
    const id = event.target.closest<HTMLElement>('[data-node-id]')?.dataset.nodeId
    if (!id) return
    const index = rows.findIndex((row) => row.id === id)
    const node = byId[id]
    if (index < 0 || !node) return
    const isFolder = node.kind === 'folder'
    const expanded = isFolder && !collapsed[id]
    let target: string | null = null
    switch (event.key) {
      case 'ArrowDown':
        target = rows[index + 1]?.id ?? null
        break
      case 'ArrowUp':
        target = rows[index - 1]?.id ?? null
        break
      case 'ArrowRight':
        if (!isFolder) return
        if (expanded) target = childrenOf[id]?.[0] ?? null
        else toggle(id)
        break
      case 'ArrowLeft':
        if (expanded) toggle(id)
        else target = node.parentId
        break
      case 'Enter':
      case ' ':
        if (node.sectionType !== null) toggle(id)
        else select(id)
        break
      default:
        return
    }
    event.preventDefault()
    focusItem(target)
  }

  if (!loaded) return null
  if (rootIds.length === 0) {
    return <p className="m-0 p-3 text-sm text-fg-muted">This project has no sections yet.</p>
  }
  return (
    <ul role="tree" aria-label="Document tree" onKeyDown={onKeyDown} className="m-0 list-none p-1">
      {rootIds.map((id) => (
        <TreeItem
          key={id}
          id={id}
          depth={1}
          format={format}
          activeId={activeId}
          register={register}
        />
      ))}
    </ul>
  )
}
