import { useId, useState } from 'react'
import { ChevronDown, ChevronRight, Info } from 'lucide-react'
import type { CardField } from '@shared/memory/claims'
import type { TypedField } from '@shared/memory/typedVsText'
import type { MemoryPause, TypedComparisonView } from '@shared/memory/views'
import { CardValueInfo } from '@renderer/features/memory/CardValue'
import { useMemoryStore, useSceneMemory } from '@renderer/features/memory/memoryStore'
import { aiReadNote, typedNote, type CardChecked } from '@renderer/features/memory/memoryView'
import { useRecordStore } from '@renderer/features/records/recordStore'

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
 * where, when, POV and year. Each row follows decision 4's rule (`memory.typed`, the same rule as
 * Here and the conflicts): the text's value shows only where it stands as the text's (a checked
 * POV or year, a place or time in the quote's own words, its sentence unedited since), with ⓘ
 * (its quote, *Go there*, how it was checked, *Not right*) and, where the author typed something
 * else, the typed value dimmed beside it, "you typed: the harbour" (the conflict itself is asked
 * in Needs a look). Anywhere else the typed value stands, marked "(typed)", and what the AI read
 * is dimmed under it: "AI read: Tomas, not checked", or "· re-checking after you pause" when its
 * sentence was edited since. Mood and theme close it. A scene not read yet says when it will be.
 */
export function CardBlock({ id }: { id: string }): React.JSX.Element | null {
  const [open, setOpen] = useState(false)
  const sectionId = useId()
  const memory = useSceneMemory(id)
  const byId = useRecordStore((s) => s.byId)
  const paused = useMemoryStore((s) => s.status?.paused ?? null)
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
                  if (field === null && comparison.typed === null) return null
                  return (
                    <CardFieldRow
                      key={key}
                      nodeId={id}
                      fieldKey={key}
                      label={label}
                      field={field}
                      read={field === null ? null : valueOf(key, field)}
                      stale={card.stale.includes(key)}
                      paused={paused}
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

/**
 * One field: the text's value with ⓘ and the typed one dimmed where they differ; or the typed
 * value with what the AI read dimmed (decision 4).
 */
function CardFieldRow({
  nodeId,
  fieldKey,
  label,
  field,
  read,
  stale,
  paused,
  comparison
}: {
  nodeId: string
  fieldKey: (typeof FIELDS)[number]['key']
  label: string
  field: CardField | null
  /** The card's value as the author reads it, when the card gives one. */
  read: string | null
  stale: boolean
  paused: MemoryPause | null
  comparison: TypedComparisonView
}): React.JSX.Element {
  const [info, setInfo] = useState(false)
  // The text's value stands only where decision 4's comparison counts it as the text's.
  const fromText = comparison.text !== null && field !== null
  const shown = fromText ? (comparison.text ?? '') : (read ?? '')
  const checked: CardChecked =
    !fromText || field === null ? 'none' : field.verified ? 'verified' : 'code'
  const infoButton = (
    <button
      type="button"
      aria-label={`Where this comes from: ${label} ${shown}`}
      aria-expanded={info}
      onClick={() => setInfo(!info)}
      className={`${SMALL} flex items-center`}
    >
      <Info size={11} aria-hidden="true" />
    </button>
  )
  return (
    <>
      <dt className="text-fg-muted">{label}</dt>
      <dd
        className="m-0 flex min-w-0 flex-wrap items-baseline gap-x-1"
        data-testid={`card-${label}`}
      >
        {fromText ? (
          <>
            <span>{shown}</span>
            {infoButton}
            {comparison.outcome === 'differs' && comparison.typed !== null ? (
              <span className="text-fg-subtle opacity-70" data-testid="typed-dimmed">
                {typedNote(comparison.typed)}
              </span>
            ) : null}
          </>
        ) : (
          <>
            {comparison.typed === null ? null : (
              <span className="text-fg-muted">{comparison.typed} (typed)</span>
            )}
            {field === null || read === null ? null : (
              <>
                <span className="text-fg-subtle opacity-70" data-testid="ai-read">
                  {aiReadNote(read, stale, paused)}
                </span>
                {infoButton}
              </>
            )}
          </>
        )}
        {info && field !== null ? (
          <CardValueInfo
            nodeId={nodeId}
            field={fieldKey}
            value={field.value}
            shown={shown}
            quote={field.quote}
            p={field.p}
            checked={checked}
          />
        ) : null}
      </dd>
    </>
  )
}
