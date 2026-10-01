import { useState } from 'react'
import { ImagePlus, Pin } from 'lucide-react'
import { LAYOUT_LIMITS } from '@shared/layout'
import { pinKey, type ReferencePin } from '@shared/references'
import { useEntityStore } from '@renderer/features/entities/entityStore'
import { useTreeStore } from '@renderer/features/manuscript/treeStore'
import { resizePanelBy, useLayoutStore } from '@renderer/features/shell/layoutStore'
import { ResizeHandle } from '@renderer/features/shell/ResizeHandle'
import { ReferenceCard } from './ReferenceCard'
import { useReferenceStore } from './referenceStore'

/** The header toggle for the reference panel (F-9.6); `aria-pressed` reflects whether it is open. */
export function ReferencesToggleButton(): React.JSX.Element {
  const open = useLayoutStore((s) => s.layout.references.open)
  const toggle = useLayoutStore((s) => s.toggle)
  return (
    <button
      type="button"
      aria-label="References"
      title="References"
      aria-pressed={open}
      onClick={() => toggle('references')}
      className="rounded-md p-1.5 text-fg-muted hover:bg-surface-raised hover:text-fg aria-pressed:bg-surface-raised aria-pressed:text-accent"
    >
      <Pin size={16} aria-hidden="true" />
    </button>
  )
}

/**
 * The quick reference panel (F-9.6): a column at the right of the project screen, between the
 * main pane and the assistant, so what the author pinned stays in view beside the manuscript and
 * beside an entity page alike. Its open state and width live in the layout store (F-7.2), as a
 * fraction of the window rendered in `vw`. Renders nothing while closed; not mounted in focus
 * mode.
 */
export function ReferencePanel(): React.JSX.Element | null {
  const references = useLayoutStore((s) => s.layout.references)
  if (!references.open) return null
  return (
    <aside
      aria-label="References"
      data-testid="references-panel"
      className="relative flex shrink-0 flex-col border-l border-line bg-surface"
      style={{ width: `${references.size * 100}vw` }}
    >
      <ResizeHandle
        side="left"
        value={references.size}
        min={LAYOUT_LIMITS.references[0]}
        max={LAYOUT_LIMITS.references[1]}
        ariaLabel="Resize references"
        onChange={(deltaPx) => resizePanelBy('references', deltaPx)}
      />
      <div className="flex shrink-0 items-center justify-between gap-2 px-4 pt-4 pb-2">
        <h2 className="m-0 text-sm font-medium text-fg-muted">References</h2>
        <button
          type="button"
          onClick={() => void useReferenceStore.getState().addImages()}
          className="flex items-center gap-1.5 rounded-md border border-line px-2 py-0.5 text-xs hover:bg-surface-raised"
        >
          <ImagePlus size={12} aria-hidden="true" />
          Add image…
        </button>
      </div>
      <PinList />
    </aside>
  )
}

/**
 * The cards, in the author's order. A pin whose entity or node is gone is not listed (main drops
 * it from the stored list on the next load), and the move buttons step over it, so a card always
 * trades places with the card the author sees next to it. Cards reorder by drag and drop too.
 */
function PinList(): React.JSX.Element {
  const pins = useReferenceStore((s) => s.pins)
  const entities = useEntityStore((s) => s.byId)
  const nodes = useTreeStore((s) => s.byId)
  /** The position (in `pins`) of the card being dragged, and the one it is over. */
  const [dragFrom, setDragFrom] = useState<number | null>(null)
  const [dragOver, setDragOver] = useState<number | null>(null)

  const exists = (pin: ReferencePin): boolean =>
    pin.type === 'entity'
      ? entities[pin.id] !== undefined
      : pin.type === 'note'
        ? nodes[pin.id] !== undefined
        : true
  const shown = pins.map((pin, index) => ({ pin, index })).filter(({ pin }) => exists(pin))

  if (shown.length === 0) {
    return (
      <p className="m-0 px-4 py-2 text-sm text-fg-muted">
        Nothing pinned yet. Pin a character, a setting, notes, or an image.
      </p>
    )
  }

  const move = (from: number, to: number): void => {
    void useReferenceStore.getState().move(from, to)
  }
  const endDrag = (): void => {
    setDragFrom(null)
    setDragOver(null)
  }

  return (
    <ul
      role="list"
      aria-label="Pinned references"
      className="m-0 flex min-h-0 flex-1 list-none flex-col gap-2 overflow-y-auto px-4 pt-0 pb-4"
    >
      {shown.map(({ pin, index }, place) => {
        const previous = shown[place - 1]
        const next = shown[place + 1]
        return (
          <ReferenceCard
            key={pinKey(pin)}
            pin={pin}
            frame={{
              onMoveUp: previous ? () => move(index, previous.index) : null,
              onMoveDown: next ? () => move(index, next.index) : null,
              dropTarget: dragFrom !== null && dragFrom !== index && dragOver === index,
              onDragStart: (event) => {
                event.dataTransfer.effectAllowed = 'move'
                event.dataTransfer.setData('text/plain', pinKey(pin))
                setDragFrom(index)
              },
              onDragOver: (event) => {
                // Only a card of this list may land here; anything else keeps the "no drop" cursor.
                if (dragFrom === null) return
                event.preventDefault()
                event.dataTransfer.dropEffect = 'move'
                if (dragOver !== index) setDragOver(index)
              },
              onDragLeave: () => {
                if (dragOver === index) setDragOver(null)
              },
              onDrop: (event) => {
                if (dragFrom === null) return
                event.preventDefault()
                move(dragFrom, index)
                endDrag()
              },
              onDragEnd: endDrag
            }}
          />
        )
      })}
    </ul>
  )
}
