import { useState } from 'react'
import { GripVertical, MoreHorizontal } from 'lucide-react'
import {
  DOCK_PANEL_LABEL,
  dropTargetAt,
  movePanel,
  stepPanel,
  type DockPanelId,
  type DockTarget
} from '@shared/dock'
import { columnLimits, columnWidth, type LayoutPanel } from '@shared/layout'
import { ContextMenu } from '@renderer/features/manuscript/ContextMenu'
import { DOCK_DRAG_TYPE, resetDockDrag, useDockDragStore } from './dockDragStore'
import { isColumnShown, resizePanelBy, useLayoutStore } from './layoutStore'
import { ResizeHandle } from './ResizeHandle'

const CONTROL =
  'rounded p-0.5 text-fg-subtle hover:bg-surface-raised hover:text-fg focus-visible:text-fg'
const COMPACT = 'rounded text-fg-subtle hover:text-fg focus-visible:text-fg'

/**
 * A panel's grip and menu (layout 3c). The grip is the drag handle: drop on the gap beside
 * another panel for a new column there, or on its top or bottom half to stack with it. The menu
 * is the keyboard alternative: Move left, Move right (disabled where there is nowhere to go), and
 * Close (not for the editor). `vertical` stacks the two, unpadded, for the editor's 12 px rail.
 */
export function DockPanelControls({
  id,
  vertical = false
}: {
  id: DockPanelId
  vertical?: boolean
}): React.JSX.Element {
  const [menuAt, setMenuAt] = useState<{ x: number; y: number } | null>(null)
  const layout = useLayoutStore((s) => s.layout)
  const label = DOCK_PANEL_LABEL[id]
  const shown = (column: readonly DockPanelId[]): boolean => isColumnShown(layout, column)
  const canMove = (direction: 'left' | 'right'): boolean =>
    stepPanel(layout.dock.columns, id, direction, shown) !== layout.dock.columns
  const items = [
    { id: 'left', label: 'Move left', disabled: !canMove('left') },
    { id: 'right', label: 'Move right', disabled: !canMove('right') },
    ...(id === 'editor' ? [] : [{ id: 'close', label: 'Close' }])
  ]
  const choose = (item: string): void => {
    setMenuAt(null)
    const store = useLayoutStore.getState()
    if (item === 'left' || item === 'right') store.stepPanel(id, item)
    else if (item === 'close' && id !== 'editor') store.toggle(id)
  }
  return (
    <div className={`flex shrink-0 items-center gap-0.5 ${vertical ? 'flex-col' : ''}`}>
      <button
        type="button"
        draggable
        aria-label={`Move ${label}`}
        title={`Drag to move ${label.toLowerCase()}`}
        onDragStart={(event) => {
          event.dataTransfer.effectAllowed = 'move'
          event.dataTransfer.setData(DOCK_DRAG_TYPE, id)
          useDockDragStore.setState({ dragging: id, over: null })
        }}
        onDragEnd={resetDockDrag}
        className={`${vertical ? COMPACT : CONTROL} cursor-grab`}
      >
        <GripVertical size={vertical ? 12 : 14} aria-hidden="true" />
      </button>
      <button
        type="button"
        aria-label={`${label} panel options`}
        title={`${label} panel options`}
        aria-haspopup="menu"
        aria-expanded={menuAt !== null}
        onClick={(event) => {
          const rect = event.currentTarget.getBoundingClientRect()
          setMenuAt(menuAt ? null : { x: rect.left, y: rect.bottom })
        }}
        className={vertical ? COMPACT : CONTROL}
      >
        <MoreHorizontal size={vertical ? 12 : 14} aria-hidden="true" />
      </button>
      {menuAt ? (
        <ContextMenu
          x={menuAt.x}
          y={menuAt.y}
          items={items}
          onSelect={choose}
          onClose={() => setMenuAt(null)}
        />
      ) : null}
    </div>
  )
}

/** Where the drop indicator sits inside a slot, per target. */
const INDICATOR: Record<string, string> = {
  left: 'inset-y-0 left-0 w-1',
  right: 'inset-y-0 right-0 w-1',
  before: 'inset-x-0 top-0 h-1',
  after: 'inset-x-0 bottom-0 h-1'
}

/** The key of a target inside `INDICATOR`. */
function indicatorOf(target: DockTarget): string {
  return target.kind === 'beside' ? target.side : target.position
}

/**
 * One panel's place in a column and its drop zone (layout 3c). While a grip drags a panel, the
 * pointer's position over the slot picks the target (`dropTargetAt`: the outer strips open a new
 * column, the halves stack) and a bar shows where it lands; dropping moves the panel through the
 * layout store. Listens in the capture phase and only while a panel is dragged, so the editor,
 * the tree, and the cards keep their own drag and drop.
 */
export function DockSlot({
  id,
  first,
  children
}: {
  id: DockPanelId
  first: boolean
  children: React.ReactNode
}): React.JSX.Element {
  const dragging = useDockDragStore((s) => s.dragging)
  const over = useDockDragStore((s) => (s.over?.panel === id ? s.over : null))
  const targetFor = (event: React.DragEvent<HTMLElement>): DockTarget | null => {
    if (dragging === null) return null
    const rect = event.currentTarget.getBoundingClientRect()
    const target = dropTargetAt(id, rect, event.clientX, event.clientY)
    const columns = useLayoutStore.getState().layout.dock.columns
    return movePanel(columns, dragging, target) === columns ? null : target
  }
  return (
    <div
      data-dock-panel={id}
      className={`relative flex min-h-0 min-w-0 flex-1 flex-col ${first ? '' : 'border-t border-line'}`}
      onDragOverCapture={(event) => {
        if (dragging === null) return
        event.preventDefault()
        event.stopPropagation()
        const target = targetFor(event)
        event.dataTransfer.dropEffect = target ? 'move' : 'none'
        const current = useDockDragStore.getState().over
        if (JSON.stringify(current) !== JSON.stringify(target))
          useDockDragStore.setState({ over: target })
      }}
      onDropCapture={(event) => {
        if (dragging === null) return
        event.preventDefault()
        event.stopPropagation()
        const target = targetFor(event)
        resetDockDrag()
        if (target) useLayoutStore.getState().movePanel(dragging, target)
      }}
    >
      {children}
      {over ? (
        <div
          aria-hidden="true"
          data-testid="dock-drop-indicator"
          data-target={indicatorOf(over)}
          className={`pointer-events-none absolute z-20 bg-accent ${INDICATOR[indicatorOf(over)] ?? ''}`}
        />
      ) : null}
    </div>
  )
}

/**
 * A side column (layout 3c): as wide as its first open panel (a fraction of the window rendered
 * in `vw`), with the resize handle on the edge that faces the editor (`side`), and its open
 * panels stacked top to bottom, each in a `DockSlot`.
 */
export function DockColumn({
  column,
  side,
  render
}: {
  column: readonly DockPanelId[]
  side: 'left' | 'right'
  render: (id: DockPanelId) => React.ReactNode
}): React.JSX.Element | null {
  const layout = useLayoutStore((s) => s.layout)
  if (!isColumnShown(layout, column)) return null
  const open = column.filter((id): id is LayoutPanel => id !== 'editor' && layout[id].open)
  const first = open[0]
  if (first === undefined) return null
  const width = columnWidth(layout, column)
  const [min, max] = columnLimits(layout, first)
  return (
    <div
      data-testid="dock-column"
      className={`relative flex shrink-0 flex-col border-line bg-surface ${side === 'left' ? 'border-l' : 'border-r'}`}
      style={{ width: `${width * 100}vw` }}
    >
      {open.map((id, index) => (
        <DockSlot key={id} id={id} first={index === 0}>
          {render(id)}
        </DockSlot>
      ))}
      <ResizeHandle
        side={side}
        value={width}
        min={min}
        max={max}
        ariaLabel={`Resize ${DOCK_PANEL_LABEL[first].toLowerCase()}`}
        onChange={(deltaPx) => resizePanelBy(first, deltaPx)}
      />
    </div>
  )
}
