import { Sparkles } from 'lucide-react'
import type { SceneCard, SceneCardValue } from '@shared/sceneCard'
import { THREAD_EVENT_LABEL } from '@shared/threads'

const CHIP = 'rounded-full border border-line bg-surface-raised px-2 py-0.5 text-xs'

/** The AI's mark on a card value it read (the author's own scene metadata carries none). */
function AiMark(): React.JSX.Element {
  return (
    <span title="Read from the scene by the AI" className="inline-flex text-accent">
      <Sparkles size={10} aria-label="AI" />
    </span>
  )
}

function CardLine({
  label,
  value
}: {
  label: string
  value: SceneCardValue | null
}): React.JSX.Element | null {
  if (value === null) return null
  return (
    <div className="flex items-baseline gap-1.5 text-xs">
      <dt className="shrink-0 text-fg-muted">{label}</dt>
      <dd className="m-0 flex min-w-0 items-baseline gap-1 wrap-anywhere">
        {value.value}
        {value.origin === 'ai' ? <AiMark /> : null}
      </dd>
    </div>
  )
}

/**
 * A scene card (F-9.14): who, where, when, POV, what changed, and the threads it moved. Main puts
 * it together (`summary:get`'s `card`): the author's own scene metadata wins, a value the AI read
 * carries its mark. `compact` is the Outline row's one-line version.
 */
export function SceneCardView({
  card,
  compact = false
}: {
  card: SceneCard
  compact?: boolean
}): React.JSX.Element {
  if (compact) {
    const head = [card.cast.join(', '), card.where?.value ?? '', card.when?.value ?? '']
      .filter((part) => part !== '')
      .join(' · ')
    return (
      <div data-testid="outline-card" className="flex flex-col gap-0.5 pl-4 text-xs text-fg-muted">
        {head !== '' ? <p className="m-0 truncate">{head}</p> : null}
        {card.changed !== '' ? <p className="m-0 line-clamp-1">{card.changed}</p> : null}
        {card.threads.length > 0 ? (
          <p className="m-0 truncate text-fg-subtle">
            {card.threads
              .map((thread) => `${thread.name} (${THREAD_EVENT_LABEL[thread.event].toLowerCase()})`)
              .join(', ')}
          </p>
        ) : null}
      </div>
    )
  }
  return (
    <section
      aria-label="Scene card"
      data-testid="scene-card"
      className="flex flex-col gap-1 rounded-md border border-line px-2 py-1.5"
    >
      {card.cast.length > 0 ? (
        <ul role="list" aria-label="Who" className="m-0 flex list-none flex-wrap gap-1 p-0">
          {card.cast.map((name) => (
            <li key={name} className={CHIP}>
              {name}
            </li>
          ))}
        </ul>
      ) : null}
      <dl className="m-0 flex flex-col gap-0.5">
        <CardLine label="Where" value={card.where} />
        <CardLine label="When" value={card.when} />
        <CardLine label="POV" value={card.pov} />
        {card.changed !== '' ? (
          <div className="flex items-baseline gap-1.5 text-xs">
            <dt className="shrink-0 text-fg-muted">Changed</dt>
            <dd className="m-0 flex min-w-0 items-baseline gap-1 wrap-anywhere">
              {card.changed}
              <AiMark />
            </dd>
          </div>
        ) : null}
      </dl>
      {card.threads.length > 0 ? (
        <ul
          role="list"
          aria-label="Threads in this scene"
          className="m-0 flex list-none flex-wrap gap-1 p-0"
        >
          {card.threads.map((thread) => (
            <li key={thread.entityId} className={CHIP}>
              {thread.name} · {THREAD_EVENT_LABEL[thread.event].toLowerCase()}
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  )
}
