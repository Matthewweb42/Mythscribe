import { useCallback, useMemo, useRef, useState } from 'react'
import { ChevronDown, ChevronRight, FileText, Folder, FolderOpen } from 'lucide-react'
import { NOTEBOOK_TITLE_MAX } from '@shared/notebook'
import { inTemplates } from '@shared/notebookTemplates'
import { useCanWrite } from '@renderer/features/account/appAccessStore'
import { ContextMenu } from '@renderer/features/manuscript/ContextMenu'
import type { MenuItem } from '@renderer/features/manuscript/contextMenuItems'
import { toast } from '@renderer/features/shell/dialogs/dialogStore'
import { InlineRenameInput } from '@renderer/features/shell/InlineRenameInput'
import { describeError } from '@renderer/lib/errors'
import { useNotebookStore } from './notebookStore'
import { NotebookTemplateMenu } from './NotebookTemplateMenu'
import {
  NOTEBOOK_ROOT,
  notebookDropTarget,
  notebookDropZone,
  notebookRows,
  type NotebookDropZone
} from './notebookIndex'

/** The drag type of a row being moved inside the tree (never a file from outside). */
export const NOTEBOOK_DRAG_TYPE = 'application/x-mythscribe-notebook'

interface MenuAnchor {
  id: string
  x: number
  y: number
}

interface DragOver {
  id: string
  zone: NotebookDropZone
}

const failed = (err: unknown): void => {
  toast.error(describeError(err))
}

/**
 * A row's menu: a folder makes a page (blank or from a template) or a folder inside it; a page
 * outside the Templates folder can be saved as a template (note templates, phase 6).
 */
function menuItems(kind: 'folder' | 'page', template = false): MenuItem[] {
  return [
    ...(kind === 'folder'
      ? [
          { id: 'new-page', label: 'New page here' },
          { id: 'new-from-template', label: 'New from template ›' },
          { id: 'new-folder', label: 'New folder here' }
        ]
      : []),
    { id: 'rename', label: 'Rename' },
    ...(kind === 'page' && !template ? [{ id: 'save-template', label: 'Save as template' }] : []),
    { id: 'delete', label: 'Delete' }
  ]
}

const START_BUTTON =
  'rounded-md border border-line px-2 py-1 text-xs text-fg-muted hover:bg-surface-raised hover:text-fg disabled:opacity-40'

function zoneOf(kind: 'folder' | 'page', event: React.DragEvent<HTMLElement>): NotebookDropZone {
  const rect = event.currentTarget.getBoundingClientRect()
  const ratio = rect.height > 0 ? (event.clientY - rect.top) / rect.height : 0.5
  return notebookDropZone(kind, ratio)
}

/**
 * The Notes tree (notes redesign phase 1, slice 1): the notebook's folders and pages, drawn like
 * the manuscript tree (F-2.1: rows, chevrons, the shared rename field and context menu, the
 * before / into / after drag zones of F-2.4), over the notebook store. A click on a page opens it;
 * a double-click or F2 renames; the menu renames, deletes (with Undo on the toast) and makes a
 * page (blank or from a template) or folder inside a folder, and saves a page as a template. An
 * empty Notes offers the starter folders or a blank page (note templates, phase 6). Rows drag
 * onto a folder to go inside it, or onto a row's top or bottom edge to go beside it.
 */
export function NotebookTree(): React.JSX.Element | null {
  const loaded = useNotebookStore((s) => s.loaded)
  const byId = useNotebookStore((s) => s.byId)
  const childrenOf = useNotebookStore((s) => s.childrenOf)
  const collapsed = useNotebookStore((s) => s.collapsed)
  const selectedId = useNotebookStore((s) => s.selectedId)
  const openId = useNotebookStore((s) => s.openId)
  const renamingId = useNotebookStore((s) => s.renamingId)
  const [menu, setMenu] = useState<MenuAnchor | null>(null)
  const [templateMenu, setTemplateMenu] = useState<MenuAnchor | null>(null)
  const writable = useCanWrite()
  const [dragId, setDragId] = useState<string | null>(null)
  const [over, setOver] = useState<DragOver | null>(null)
  const items = useRef(new Map<string, HTMLLIElement>())

  const index = useMemo(() => ({ byId, childrenOf }), [byId, childrenOf])
  const rows = useMemo(() => notebookRows(index, collapsed), [index, collapsed])
  const activeId =
    selectedId !== null && rows.some((row) => row.id === selectedId)
      ? selectedId
      : (rows[0]?.id ?? null)

  const closeMenu = useCallback((): void => {
    setMenu((open) => {
      if (open) items.current.get(open.id)?.focus()
      return null
    })
  }, [])

  const onMenuSelect = (itemId: string): void => {
    if (menu === null) return
    const id = menu.id
    setMenu(null)
    const store = useNotebookStore.getState()
    if (itemId === 'rename') store.startRename(id)
    else if (itemId === 'delete') store.remove(id).catch(failed)
    else if (itemId === 'new-page') store.create('page', id).catch(failed)
    else if (itemId === 'new-folder') store.create('folder', id).catch(failed)
    else if (itemId === 'new-from-template') setTemplateMenu(menu)
    else if (itemId === 'save-template') store.saveAsTemplate(id).catch(failed)
  }

  const onKeyDown = (event: React.KeyboardEvent<HTMLUListElement>): void => {
    if (!(event.target instanceof HTMLElement) || event.target instanceof HTMLInputElement) return
    const id = event.target.closest<HTMLElement>('[data-notebook-id]')?.dataset.notebookId
    const item = id === undefined ? undefined : byId[id]
    const at = rows.findIndex((row) => row.id === id)
    if (item === undefined || at < 0) return
    const store = useNotebookStore.getState()
    const folder = item.kind === 'folder'
    const expanded = folder && collapsed[item.id] !== true
    let target: string | null = null
    switch (event.key) {
      case 'ArrowDown':
        target = rows[at + 1]?.id ?? null
        break
      case 'ArrowUp':
        target = rows[at - 1]?.id ?? null
        break
      case 'ArrowRight':
        if (!folder) return
        if (expanded) target = childrenOf[item.id]?.[0] ?? null
        else store.toggle(item.id)
        break
      case 'ArrowLeft':
        if (expanded) store.toggle(item.id)
        else target = item.parentId
        break
      case 'Enter':
      case ' ':
        store.select(item.id)
        break
      case 'F2':
        store.startRename(item.id)
        break
      default:
        return
    }
    event.preventDefault()
    if (target !== null) items.current.get(target)?.focus()
  }

  if (!loaded) return null
  if (rows.length === 0) {
    return (
      <div className="flex flex-col gap-2 p-3 text-sm text-fg-muted">
        <p className="m-0">
          No notes yet. Start with a few folders, a blank page, or drop files here.
        </p>
        <div className="flex flex-wrap gap-1.5">
          <button
            type="button"
            disabled={!writable}
            title="Characters, Places, World, Plot and Timeline folders, and a Style guide page"
            onClick={() => {
              useNotebookStore.getState().startWithFolders().catch(failed)
            }}
            className={START_BUTTON}
          >
            Start with folders
          </button>
          <button
            type="button"
            disabled={!writable}
            onClick={() => {
              useNotebookStore.getState().create('page').catch(failed)
            }}
            className={START_BUTTON}
          >
            Start blank
          </button>
        </div>
      </div>
    )
  }

  const renderRow = (id: string, depth: number): React.JSX.Element | null => {
    const item = byId[id]
    if (item === undefined) return null
    const folder = item.kind === 'folder'
    const expanded = folder && collapsed[id] !== true
    const children = childrenOf[id] ?? []
    const zone = over?.id === id ? over.zone : null
    const renaming = renamingId === id
    const Icon = folder ? (expanded ? FolderOpen : Folder) : FileText
    return (
      <li
        key={id}
        ref={(element) => {
          if (element) items.current.set(id, element)
          else items.current.delete(id)
        }}
        role="treeitem"
        aria-label={item.title}
        aria-level={depth}
        aria-expanded={folder ? expanded : undefined}
        aria-selected={selectedId === id}
        aria-current={openId === id ? 'page' : undefined}
        data-notebook-id={id}
        tabIndex={activeId === id ? 0 : -1}
        className="m-0 list-none p-0 outline-none"
      >
        <div
          onClick={() => useNotebookStore.getState().select(id)}
          onDoubleClick={() => useNotebookStore.getState().startRename(id)}
          onContextMenu={(event) => {
            event.preventDefault()
            event.stopPropagation()
            setMenu({ id, x: event.clientX, y: event.clientY })
          }}
          draggable={!renaming}
          onDragStart={(event) => {
            event.dataTransfer.effectAllowed = 'move'
            event.dataTransfer.setData(NOTEBOOK_DRAG_TYPE, id)
            setDragId(id)
          }}
          onDragOver={(event) => {
            if (dragId === null) return
            const where = zoneOf(item.kind, event)
            if (notebookDropTarget(index, dragId, id, where) === null) {
              setOver(null)
              return
            }
            event.preventDefault()
            event.stopPropagation()
            event.dataTransfer.dropEffect = 'move'
            if (over?.id !== id || over.zone !== where) setOver({ id, zone: where })
          }}
          onDrop={(event) => {
            if (dragId === null) return
            event.preventDefault()
            event.stopPropagation()
            const target = notebookDropTarget(index, dragId, id, zoneOf(item.kind, event))
            const moving = dragId
            setDragId(null)
            setOver(null)
            if (target === null) return
            useNotebookStore.getState().move(moving, target.parentId, target.position).catch(failed)
          }}
          onDragEnd={() => {
            setDragId(null)
            setOver(null)
          }}
          data-drop={zone ?? undefined}
          style={{ paddingLeft: depth * 12 + 8 }}
          className={`relative flex h-7 cursor-default items-center gap-1 rounded-md pr-2 text-sm select-none ${
            selectedId === id ? 'bg-accent/15 text-fg' : 'hover:bg-surface-raised'
          } ${zone === 'into' ? 'ring-2 ring-accent ring-inset' : ''}`}
        >
          {folder ? (
            <button
              type="button"
              tabIndex={-1}
              aria-label={`${expanded ? 'Collapse' : 'Expand'} ${item.title}`}
              onClick={(event) => {
                event.stopPropagation()
                useNotebookStore.getState().toggle(id)
              }}
              onDoubleClick={(event) => event.stopPropagation()}
              className="flex h-4 w-4 shrink-0 items-center justify-center rounded text-fg-subtle hover:text-fg"
            >
              {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
            </button>
          ) : (
            <span aria-hidden="true" className="h-4 w-4 shrink-0" />
          )}
          <Icon size={14} aria-hidden="true" className="shrink-0 text-fg-subtle" />
          {renaming ? (
            <InlineRenameInput
              value={item.title}
              maxLength={NOTEBOOK_TITLE_MAX}
              onCommit={(next) => useNotebookStore.getState().rename(id, next)}
              onDone={() => useNotebookStore.getState().endRename()}
            />
          ) : (
            <span className="min-w-0 flex-1 truncate">{item.title}</span>
          )}
          {zone === 'before' || zone === 'after' ? (
            <span
              aria-hidden="true"
              style={{ left: depth * 12 + 8 }}
              className={`pointer-events-none absolute right-2 h-0.5 bg-accent ${
                zone === 'before' ? 'top-0' : 'bottom-0'
              }`}
            />
          ) : null}
        </div>
        {expanded && children.length > 0 ? (
          <ul role="group" className="m-0 list-none p-0">
            {children.map((child) => renderRow(child, depth + 1))}
          </ul>
        ) : null}
      </li>
    )
  }

  const menuItem = menu === null ? undefined : byId[menu.id]
  return (
    <>
      <ul
        role="tree"
        aria-label="Notes"
        onKeyDown={onKeyDown}
        onDragLeave={(event) => {
          if (
            event.relatedTarget instanceof Node &&
            !event.currentTarget.contains(event.relatedTarget)
          ) {
            setOver(null)
          }
        }}
        className="m-0 list-none p-1"
      >
        {(childrenOf[NOTEBOOK_ROOT] ?? []).map((id) => renderRow(id, 1))}
      </ul>
      {menu !== null && menuItem !== undefined ? (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          items={menuItems(menuItem.kind, inTemplates(Object.values(byId), menuItem.parentId))}
          onSelect={onMenuSelect}
          onClose={closeMenu}
        />
      ) : null}
      {templateMenu !== null ? (
        <NotebookTemplateMenu
          x={templateMenu.x}
          y={templateMenu.y}
          parentId={templateMenu.id}
          onClose={() => setTemplateMenu(null)}
        />
      ) : null}
    </>
  )
}
