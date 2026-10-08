import { useEffect, useId, useState, type DragEvent, type KeyboardEvent } from 'react'
import { ChevronDown, ChevronUp, Pin, PinOff, X } from 'lucide-react'
import { assetDisplayName } from '@shared/assets'
import { docToText } from '@shared/docText'
import { entityImageUrl } from '@shared/entities'
import { useCategory } from '@renderer/features/entities/categoryStore'
import { referenceImageUrl, type ReferencePin } from '@shared/references'
import { EMPTY_DOC, type TiptapNodeT } from '@shared/tiptap'
import { useNotesStore } from '@renderer/features/editor/notesStore'
import { ObservedFacts } from '@renderer/features/entities/ObservedFacts'
import { useEntityStore } from '@renderer/features/entities/entityStore'
import { useTreeStore } from '@renderer/features/manuscript/treeStore'
import { dialogs, toast } from '@renderer/features/shell/dialogs/dialogStore'
import { useLayoutStore } from '@renderer/features/shell/layoutStore'
import { describeError } from '@renderer/lib/errors'
import { ipc } from '@renderer/lib/ipc'
import { useReferenceStore } from './referenceStore'

const ICON_BUTTON =
  'rounded-md p-1 text-fg-muted hover:bg-surface-raised hover:text-fg disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-fg-muted'
const TEXT_BUTTON = 'rounded-md border border-line px-2 py-0.5 text-xs hover:bg-surface-raised'
const LINK_BUTTON = 'self-start text-xs text-fg-muted underline hover:text-fg'

/** How many filled fields an entity card shows before `Show more`. */
export const CARD_FIELDS_COLLAPSED = 3
/** A text longer than this (or with a line break) is clamped until `Show more`. */
export const CARD_TEXT_COLLAPSED_CHARS = 120

const capitalize = (word: string): string => `${word[0]?.toUpperCase() ?? ''}${word.slice(1)}`

const isLong = (text: string): boolean =>
  text.length > CARD_TEXT_COLLAPSED_CHARS || text.includes('\n')

/** What the panel hands every card: where it may move, and the drag-and-drop wiring. */
export interface CardFrameProps {
  /** Moves the card one place up among the cards shown; null for the first one. */
  onMoveUp: (() => void) | null
  /** Moves the card one place down among the cards shown; null for the last one. */
  onMoveDown: (() => void) | null
  /** True while another card is dragged over this one. */
  dropTarget: boolean
  onDragStart: (event: DragEvent<HTMLLIElement>) => void
  onDragOver: (event: DragEvent<HTMLLIElement>) => void
  onDragLeave: () => void
  onDrop: (event: DragEvent<HTMLLIElement>) => void
  onDragEnd: () => void
}

/**
 * One quick-view card of the reference panel (F-9.6). The card is a view of its target, never a
 * copy: an entity card reads the entity store, a notes card the notes of its node, an image card
 * the file. A target that is gone renders nothing (the panel does not list it; main drops the pin
 * on the next load).
 */
export function ReferenceCard({
  pin,
  frame
}: {
  pin: ReferencePin
  frame: CardFrameProps
}): React.JSX.Element | null {
  switch (pin.type) {
    case 'entity':
      return <EntityCard pin={pin} id={pin.id} frame={frame} />
    case 'note':
      return <NoteCard pin={pin} id={pin.id} frame={frame} />
    case 'image':
      return <ImageCard pin={pin} file={pin.file} frame={frame} />
  }
}

const CARD = 'flex flex-col gap-2 rounded-md border border-line bg-bg p-2.5'

/**
 * The header every card shares (title, what it is, move, unpin) around the card's own body. A
 * card without a `frame` is one the panel put there itself (F-9.7): it has no place to move to
 * and nothing to unpin, and offers `Pin` instead.
 */
function CardFrame({
  title,
  typeLabel,
  frame,
  onPinToggle,
  children
}: {
  title: string
  typeLabel: string
  frame: CardFrameProps | null
  /** Unpins a pinned card; pins an automatic one. */
  onPinToggle: () => void
  children: React.ReactNode
}): React.JSX.Element {
  const heading = (
    <>
      <h3 className="m-0 truncate text-sm font-medium">{title}</h3>
      <p className="m-0 text-xs text-fg-subtle">{typeLabel}</p>
    </>
  )
  if (frame === null) {
    return (
      <li aria-label={title} className={CARD}>
        <div className="flex items-start gap-1">
          <div className="min-w-0 flex-1">{heading}</div>
          <button
            type="button"
            aria-label={`Pin ${title}`}
            title="Pin"
            onClick={onPinToggle}
            className={ICON_BUTTON}
          >
            <Pin size={14} aria-hidden="true" />
          </button>
        </div>
        {children}
      </li>
    )
  }
  return (
    <li
      aria-label={title}
      draggable
      data-drop-target={frame.dropTarget}
      onDragStart={frame.onDragStart}
      onDragOver={frame.onDragOver}
      onDragLeave={frame.onDragLeave}
      onDrop={frame.onDrop}
      onDragEnd={frame.onDragEnd}
      className={`${CARD} data-[drop-target=true]:border-accent`}
    >
      <div className="flex items-start gap-1">
        <div className="min-w-0 flex-1 cursor-grab">{heading}</div>
        <button
          type="button"
          aria-label="Move up"
          title="Move up"
          disabled={frame.onMoveUp === null}
          onClick={() => frame.onMoveUp?.()}
          className={ICON_BUTTON}
        >
          <ChevronUp size={14} aria-hidden="true" />
        </button>
        <button
          type="button"
          aria-label="Move down"
          title="Move down"
          disabled={frame.onMoveDown === null}
          onClick={() => frame.onMoveDown?.()}
          className={ICON_BUTTON}
        >
          <ChevronDown size={14} aria-hidden="true" />
        </button>
        <button
          type="button"
          aria-label={`Unpin ${title}`}
          title="Unpin"
          onClick={onPinToggle}
          className={ICON_BUTTON}
        >
          <PinOff size={14} aria-hidden="true" />
        </button>
      </div>
      {children}
    </li>
  )
}

/**
 * The card of an entity named in the open scene (F-9.7): the pinned entity card without a place
 * in the author's order. `Pin` adds it to the pins, where it stays when the scene changes.
 */
export function SceneEntityCard({ id }: { id: string }): React.JSX.Element | null {
  return <EntityCard pin={{ type: 'entity', id }} id={id} frame={null} />
}

function MoreToggle({
  expanded,
  onToggle
}: {
  expanded: boolean
  onToggle: () => void
}): React.JSX.Element {
  return (
    <button type="button" aria-expanded={expanded} onClick={onToggle} className={LINK_BUTTON}>
      {expanded ? 'Show less' : 'Show more'}
    </button>
  )
}

function unpin(pin: ReferencePin): void {
  void useReferenceStore.getState().unpin(pin)
}

/**
 * An entity (F-9.1): its thumbnail when it has an image, then what its template holds — the
 * filled fields of a structured page, or the start of a blank page — clamped until `Show more`.
 * `Open` shows the full page in the main pane.
 */
function EntityCard({
  pin,
  id,
  frame
}: {
  pin: ReferencePin
  id: string
  frame: CardFrameProps | null
}): React.JSX.Element | null {
  const entity = useEntityStore((s) => s.byId[id])
  const [expanded, setExpanded] = useState(false)
  const category = useCategory(entity?.kind ?? '')
  if (!entity) return null

  const fields =
    entity.template === 'structured'
      ? category.fields.flatMap((field) => {
          const value = (entity.fields[field.id] ?? '').trim()
          return value === '' ? [] : [{ id: field.id, label: field.label, value }]
        })
      : []
  const body = entity.template === 'blank' ? (entity.body ?? '').trim() : ''
  const hasMore =
    fields.length > CARD_FIELDS_COLLAPSED || fields.some((f) => isLong(f.value)) || isLong(body)
  const shown = expanded ? fields : fields.slice(0, CARD_FIELDS_COLLAPSED)

  return (
    <CardFrame
      title={entity.name}
      typeLabel={capitalize(category.noun)}
      frame={frame}
      onPinToggle={() => (frame === null ? void useReferenceStore.getState().pin(pin) : unpin(pin))}
    >
      {category.hasImage && entity.image !== null ? (
        <img
          alt=""
          src={entityImageUrl(entity.image)}
          className="size-16 rounded-md border border-line object-cover"
        />
      ) : null}
      {fields.length === 0 && body === '' ? (
        <p className="m-0 text-xs text-fg-muted">Nothing written yet.</p>
      ) : null}
      {shown.length > 0 ? (
        <dl className="m-0 flex flex-col gap-1.5">
          {shown.map((field) => (
            <div key={field.id}>
              <dt className="text-xs font-medium text-fg-muted">{field.label}</dt>
              <dd className={`m-0 text-sm whitespace-pre-wrap ${expanded ? '' : 'line-clamp-2'}`}>
                {field.value}
              </dd>
            </div>
          ))}
        </dl>
      ) : null}
      {body === '' ? null : (
        <p className={`m-0 text-sm whitespace-pre-wrap ${expanded ? '' : 'line-clamp-4'}`}>
          {body}
        </p>
      )}
      <ObservedFacts entity={entity} compact />
      <div className="flex items-center justify-between gap-2">
        {hasMore ? (
          <MoreToggle expanded={expanded} onToggle={() => setExpanded(!expanded)} />
        ) : (
          <span />
        )}
        <button
          type="button"
          aria-label={`Open ${entity.name}`}
          onClick={() => useEntityStore.getState().select(id)}
          className={TEXT_BUTTON}
        >
          Open
        </button>
      </div>
    </CardFrame>
  )
}

/**
 * The notes of `id` as they stand: the notes store's copy while an editor has them loaded (so
 * the card follows the author's typing and keeps the last text after the editor closes), else
 * what `notes:get` answers. Null until one of the two has arrived.
 */
function useNotesDoc(id: string): TiptapNodeT | null {
  const live = useNotesStore((s) => s.docs[id]?.content ?? null)
  const [snapshot, setSnapshot] = useState<TiptapNodeT | null>(
    () => useNotesStore.getState().docs[id]?.content ?? null
  )

  useEffect(() => {
    let current = true
    // The last text an editor held stays on the card after that editor unloads the record.
    const unsubscribe = useNotesStore.subscribe((s) => {
      const content = s.docs[id]?.content ?? null
      if (content !== null) setSnapshot(content)
    })
    if (useNotesStore.getState().docs[id]?.content == null) {
      ipc()
        .invoke('notes:get', { id })
        .then(({ notes }) => {
          // What the store delivered meanwhile is newer than what was read from disk.
          if (current) setSnapshot((held) => held ?? notes ?? EMPTY_DOC)
        })
        .catch((err: unknown) => {
          if (current) toast.error(describeError(err))
        })
    }
    return () => {
      current = false
      unsubscribe()
    }
  }, [id])

  return live ?? snapshot
}

/**
 * A node's notes (F-3.7) as plain text, clamped until `Show more`. `Open` selects the node and
 * opens the notes panel, where they are edited.
 */
function NoteCard({
  pin,
  id,
  frame
}: {
  pin: ReferencePin
  id: string
  frame: CardFrameProps
}): React.JSX.Element | null {
  const title = useTreeStore((s) => s.byId[id]?.title)
  // Scenes share titles ("Scene 1" in every chapter), so the card names the parent too.
  const parentTitle = useTreeStore((s) => {
    const parentId = s.byId[id]?.parentId
    return parentId == null ? undefined : s.byId[parentId]?.title
  })
  const [expanded, setExpanded] = useState(false)
  const doc = useNotesDoc(id)
  if (title === undefined) return null
  const text = doc === null ? null : docToText(doc).trim()

  const open = (): void => {
    useTreeStore.getState().select(id)
    const layout = useLayoutStore.getState()
    if (!layout.layout.notes.open) layout.toggle('notes')
  }

  return (
    <CardFrame
      title={title}
      typeLabel={parentTitle === undefined ? 'Notes' : `Notes · ${parentTitle}`}
      frame={frame}
      onPinToggle={() => unpin(pin)}
    >
      {text === null ? null : text === '' ? (
        <p className="m-0 text-xs text-fg-muted">No notes yet.</p>
      ) : (
        <p className={`m-0 text-sm whitespace-pre-wrap ${expanded ? '' : 'line-clamp-6'}`}>
          {text}
        </p>
      )}
      <div className="flex items-center justify-between gap-2">
        {text !== null && isLong(text) ? (
          <MoreToggle expanded={expanded} onToggle={() => setExpanded(!expanded)} />
        ) : (
          <span />
        )}
        <button
          type="button"
          aria-label={`Open notes of ${title}`}
          onClick={open}
          className={TEXT_BUTTON}
        >
          Open
        </button>
      </div>
    </CardFrame>
  )
}

/**
 * A pinned image at the panel's width; a click opens it large over the window. Unpinning deletes
 * the file (the pin is its only record), so it asks first.
 */
function ImageCard({
  pin,
  file,
  frame
}: {
  pin: ReferencePin
  file: string
  frame: CardFrameProps
}): React.JSX.Element {
  const name = assetDisplayName(file)
  const [large, setLarge] = useState(false)

  const confirmUnpin = async (): Promise<void> => {
    const ok = await dialogs.confirm({
      title: `Unpin "${name}"?`,
      message: 'This deletes the image file from the project folder. This cannot be undone.',
      confirmLabel: 'Unpin',
      danger: true
    })
    if (ok) unpin(pin)
  }

  return (
    <CardFrame title={name} typeLabel="Image" frame={frame} onPinToggle={() => void confirmUnpin()}>
      <button
        type="button"
        aria-label={`View ${name} larger`}
        onClick={() => setLarge(true)}
        className="cursor-zoom-in rounded-md border border-line p-0"
      >
        <img
          alt={name}
          src={referenceImageUrl(file)}
          draggable={false}
          className="block w-full rounded-md"
        />
      </button>
      {large ? <ImageViewer name={name} file={file} onClose={() => setLarge(false)} /> : null}
    </CardFrame>
  )
}

/** The larger view of a pinned image: a modal over the window; Escape, the backdrop, or Close leaves it. */
function ImageViewer({
  name,
  file,
  onClose
}: {
  name: string
  file: string
  onClose: () => void
}): React.JSX.Element {
  const closeId = useId()

  useEffect(() => {
    document.getElementById(closeId)?.focus()
  }, [closeId])

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== 'Escape') return
    event.preventDefault()
    event.stopPropagation()
    onClose()
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={name}
      onKeyDown={onKeyDown}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
      className="fixed inset-0 z-50 flex items-center justify-center bg-overlay p-6"
    >
      <button
        id={closeId}
        type="button"
        aria-label="Close image"
        title="Close"
        onClick={onClose}
        className="absolute top-4 right-4 rounded-md bg-surface-raised p-1.5 text-fg-muted hover:text-fg"
      >
        <X size={16} aria-hidden="true" />
      </button>
      <img
        alt={name}
        src={referenceImageUrl(file)}
        className="max-h-full max-w-full rounded-md object-contain shadow-panel"
      />
    </div>
  )
}
