import { useId, useState } from 'react'
import { ChevronDown, ChevronRight, Info } from 'lucide-react'
import type { CardField } from '@shared/memory/claims'
import type { TypedField } from '@shared/memory/typedVsText'
import type { TypedComparisonView } from '@shared/memory/views'
import { useSceneMemory } from '@renderer/features/memory/memoryStore'
import { typedNote } from '@renderer/features/memory/memoryView'
import { useRecordStore } from '@renderer/features/records/recordStore'
import { toast } from '@renderer/features/shell/dialogs/dialogStore'
import { describeError } from '@renderer/lib/errors'
import { locateText } from './locateText'
import { openPassage } from './openPassage'

const BUTTON =
  'flex shrink-0 items-center gap-1 rounded-md whitespace-nowrap px-1.5 py-1 text-xs text-fg-muted hover:bg-surface-raised hover:text-fg aria-expanded:text-fg'
const SMALL =
  'rounded px-1.5 py-0.5 text-xs text-fg-muted hover:bg-surface-raised hover:text-fg aria-expanded:bg-surface-raised'

/** The card's fields scene details show, each beside the typed detail it may differ from. */
const FIELDS: { key: 'where' | 'when' | 'pov' | 'year'; label: string; typed: TypedField }[] = [
  { key: 'where', label: 'Where', typed: 'place' },
  { key: 'when', label: 'When', typed: 'time' },
  { key: 'pov', label: 'POV', typed: 'pov' },
  { key: 'year', label: 'Year', typed: 'year' }
]

/**
 * Story memory v2's **card** in scene details (F-16.18), in place of v1's summary block: the
 * reading's line and gist, captioned as the AI's map of the scene (findable, never quoted), then
 * where, when, POV and year as the text quotes them, each with ⓘ (its quote, *Go there*, and
 * whether a second read checked it); where the author typed something else, the text's value
 * shows with the typed one dimmed beside it, "you typed: the harbour" (decision 4; the conflict
 * itself is asked in Needs a look). Mood and theme close it. A scene not read yet says when it
 * will be.
 */
export function CardBlock({ id }: { id: string }): React.JSX.Element | null {
  const [open, setOpen] = useState(false)
  const sectionId = useId()
  const memory = useSceneMemory(id)
  const byId = useRecordStore((s) => s.byId)
  if (memory === undefined) return null
  const { card } = memory
  const valueOf = (key: (typeof FIELDS)[number]['key'], field: CardField): string =>
    key === 'pov' ? (byId[field.value]?.name ?? field.value) : field.value
  return (
    <>
      <div className="flex flex-wrap items-center gap-1">
        <button
          type="button"
          aria-expanded={open}
          aria-controls={open ? sectionId : undefined}
          onClick={() => setOpen(!open)}
          className={BUTTON}
        >
          {open ? (
            <ChevronDown size={14} aria-hidden="true" />
          ) : (
            <ChevronRight size={14} aria-hidden="true" />
          )}
          <span className="font-medium">Card</span>
        </button>
        {card === null ? (
          <span className="text-xs text-fg-subtle">Not read yet</span>
        ) : (
          <span className="min-w-0 flex-1 truncate text-xs text-fg-subtle">{card.line}</span>
        )}
      </div>
      {open ? (
        <div id={sectionId} data-testid="card-block" className="flex flex-col gap-1 text-xs">
          {card === null ? (
            <p className="m-0 text-fg-subtle">
              No card yet. The scene is read when you leave it, pause, or press Read now.
            </p>
          ) : (
            <>
              <p className="m-0 text-[11px] text-fg-subtle italic">
                The AI’s map of this scene, never quoted.
              </p>
              <p className="m-0 font-medium">{card.line}</p>
              <p className="m-0 text-fg-muted">{card.gist}</p>
              <dl className="m-0 grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5">
                {FIELDS.map(({ key, label, typed }) => {
                  const field = card.fields[key]
                  const comparison = memory.typed[typed]
                  if (field === null && comparison.outcome !== 'typedOnly') return null
                  return (
                    <CardFieldRow
                      key={key}
                      nodeId={id}
                      label={label}
                      field={field}
                      value={field === null ? null : valueOf(key, field)}
                      comparison={comparison}
                    />
                  )
                })}
              </dl>
              {card.mood === null && card.theme === null ? null : (
                <p className="m-0 text-fg-muted">
                  {[
                    card.mood === null ? null : `Mood: ${card.mood}`,
                    card.theme === null ? null : `Theme: ${card.theme}`
                  ]
                    .filter((part): part is string => part !== null)
                    .join(' · ')}
                </p>
              )}
            </>
          )}
        </div>
      ) : null}
    </>
  )
}

/** One field: the text's value with ⓘ, and the typed value dimmed where it differs. */
function CardFieldRow({
  nodeId,
  label,
  field,
  value,
  comparison
}: {
  nodeId: string
  label: string
  field: CardField | null
  value: string | null
  comparison: TypedComparisonView
}): React.JSX.Element {
  const [info, setInfo] = useState(false)
  const differs = comparison.outcome === 'differs' && comparison.typed !== null
  const goThere = (quote: string): void => {
    openPassage(nodeId, (doc) => locateText(doc, quote)).catch((err: unknown) =>
      toast.error(describeError(err))
    )
  }
  return (
    <>
      <dt className="text-fg-muted">{label}</dt>
      <dd
        className="m-0 flex min-w-0 flex-wrap items-baseline gap-x-1"
        data-testid={`card-${label}`}
      >
        {field === null || value === null ? (
          <span className="text-fg-muted">{comparison.typed ?? ''} (typed)</span>
        ) : (
          <>
            <span>{value}</span>
            <button
              type="button"
              aria-label={`Where this comes from: ${label} ${value}`}
              aria-expanded={info}
              onClick={() => setInfo(!info)}
              className={`${SMALL} flex items-center`}
            >
              <Info size={11} aria-hidden="true" />
            </button>
            {differs ? (
              <span className="text-fg-subtle opacity-70" data-testid="typed-dimmed">
                {typedNote(comparison.typed ?? '')}
              </span>
            ) : null}
            {info ? (
              <span className="flex w-full flex-wrap items-baseline gap-1 rounded-md border border-line bg-surface px-1.5 py-1">
                <q className="min-w-0 flex-1">{field.quote}</q>
                <button type="button" className={SMALL} onClick={() => goThere(field.quote)}>
                  Go there
                </button>
                <span className="w-full text-fg-muted">
                  {`¶${field.p + 1} · ${field.verified ? 'checked by a second AI read' : 'read by AI, not checked'}`}
                </span>
              </span>
            ) : null}
          </>
        )}
      </dd>
    </>
  )
}
