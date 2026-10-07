import { useEffect, useMemo, useState } from 'react'
import { ImagePlus, Pin } from 'lucide-react'
import { hasPin, pinKey, type ReferencePin } from '@shared/references'
import { useEntityStore } from '@renderer/features/entities/entityStore'
import { useTreeStore } from '@renderer/features/manuscript/treeStore'
import { DockPanelControls } from '@renderer/features/shell/Dock'
import { useLayoutStore } from '@renderer/features/shell/layoutStore'
import { toast } from '@renderer/features/shell/dialogs/dialogStore'
import { useDocumentTagStore } from '@renderer/features/tags/documentTagStore'
import { useMentionStore } from '@renderer/features/tags/mentionStore'
import { describeError } from '@renderer/lib/errors'
import { ReferenceCard, SceneEntityCard } from './ReferenceCard'
import { useReferenceStore } from './referenceStore'
import { sceneEntityIds, useOpenSceneId } from './sceneEntities'

const SECTION_LABEL = 'm-0 text-xs font-medium tracking-wide text-fg-subtle uppercase'
const CARD_LIST = 'm-0 flex list-none flex-col gap-2 p-0'

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
 * The quick reference panel (F-9.6): a dock panel (layout 3c; by default its own column between
 * the tags and the assistant), so what the author pinned stays in view beside the manuscript and
 * beside an entity page alike. Its open state lives in the layout store (F-7.2); its column and
 * width are the dock's (`DockColumn`). Renders nothing while closed; not mounted in focus mode.
 */
export function ReferencePanel(): React.JSX.Element | null {
  const references = useLayoutStore((s) => s.layout.references)
  if (!references.open) return null
  return (
    <aside
      aria-label="References"
      data-testid="references-panel"
      className="flex min-h-0 flex-1 flex-col bg-surface"
    >
      <div className="flex shrink-0 items-center gap-2 pt-3 pr-4 pb-2 pl-2">
        <DockPanelControls id="references" />
        <h2 className="m-0 min-w-0 flex-1 truncate text-sm font-medium text-fg-muted">
          References
        </h2>
        <button
          type="button"
          onClick={() => void useReferenceStore.getState().addImages()}
          className="flex items-center gap-1.5 rounded-md border border-line px-2 py-0.5 text-xs hover:bg-surface-raised"
        >
          <ImagePlus size={12} aria-hidden="true" />
          Add image…
        </button>
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-4 pb-4">
        <InThisScene />
        <PinList />
      </div>
    </aside>
  )
}

/**
 * The automatic section above the pins (F-9.7): a card for every entity the open scene names,
 * from what main's mention scan recorded (F-4.12, refreshed after each save) and the scene's
 * tag links. Nothing is asked of any AI. An entity the author pinned shows once, among the
 * pins. Not rendered when no scene is open.
 */
function InThisScene(): React.JSX.Element | null {
  const sceneId = useOpenSceneId()
  const mentions = useMentionStore((s) => (sceneId === null ? undefined : s.byNode[sceneId]))
  const tagIds = useDocumentTagStore((s) =>
    sceneId === null ? undefined : s.tagIdsByNode[sceneId]
  )
  const entities = useEntityStore((s) => s.byId)
  const pins = useReferenceStore((s) => s.pins)

  useEffect(() => {
    if (sceneId === null) return
    // The panel shows beside an entity page too, where no tag bar has loaded the scene's rows.
    const failed = (err: unknown): void => void toast.error(describeError(err))
    useMentionStore.getState().loadForNode(sceneId).catch(failed)
    useDocumentTagStore.getState().load(sceneId).catch(failed)
  }, [sceneId])

  const ids = useMemo(
    () => sceneEntityIds(Object.values(entities), mentions ?? [], tagIds ?? []),
    [entities, mentions, tagIds]
  )
  if (sceneId === null) return null
  const shown = ids.filter((id) => !hasPin(pins, { type: 'entity', id }))

  return (
    <section aria-label="In this scene" className="flex flex-col gap-2 pb-2">
      <p className={SECTION_LABEL}>In this scene</p>
      {shown.length === 0 ? (
        <p className="m-0 text-sm text-fg-muted">
          {ids.length === 0
            ? 'No one from your story bible is named in this scene yet.'
            : 'Everyone named in this scene is pinned below.'}
        </p>
      ) : (
        <ul role="list" aria-label="In this scene" className={CARD_LIST}>
          {shown.map((id) => (
            <SceneEntityCard key={id} id={id} />
          ))}
        </ul>
      )}
      <p className={SECTION_LABEL}>Pinned</p>
    </section>
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
      <p className="m-0 text-sm text-fg-muted">
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
    <ul role="list" aria-label="Pinned references" className={CARD_LIST}>
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
