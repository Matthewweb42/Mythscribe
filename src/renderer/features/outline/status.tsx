import { useId } from 'react'
import { SCENE_STATUSES, SCENE_STATUS_LABELS, type SceneStatus } from '@shared/sceneMeta'
import { STATUS_BG } from './statusColors'

/** The status colour as a small dot, labelled for assistive tech unless the status is unset. */
export function StatusDot({
  status,
  className = ''
}: {
  status: SceneStatus
  className?: string
}): React.JSX.Element {
  const unset = status === 'none'
  return (
    <span
      role={unset ? undefined : 'img'}
      aria-label={unset ? undefined : `Status: ${SCENE_STATUS_LABELS[status]}`}
      aria-hidden={unset ? true : undefined}
      className={`inline-block size-2 shrink-0 rounded-full ${STATUS_BG[status]} ${className}`}
    />
  )
}

/** The status picker of the metadata pane and the index card (F-11.1): a labelled native select. */
export function StatusSelect({
  value,
  onChange,
  disabled = false,
  label = 'Status',
  labelClassName = 'w-16 shrink-0 text-xs text-fg-muted',
  className = ''
}: {
  value: SceneStatus
  onChange: (status: SceneStatus) => void
  disabled?: boolean
  label?: string
  labelClassName?: string
  className?: string
}): React.JSX.Element {
  const id = useId()
  return (
    <div className={`flex items-center gap-2 ${className}`}>
      <label htmlFor={id} className={labelClassName}>
        {label}
      </label>
      <StatusDot status={value} />
      <select
        id={id}
        value={value}
        disabled={disabled}
        onChange={(event) => {
          const next = SCENE_STATUSES.find((status) => status === event.target.value)
          if (next !== undefined) onChange(next)
        }}
        className="min-w-0 flex-1 rounded-md border border-line bg-bg px-1 py-px text-xs leading-5 disabled:opacity-50"
      >
        {SCENE_STATUSES.map((status) => (
          <option key={status} value={status}>
            {SCENE_STATUS_LABELS[status]}
          </option>
        ))}
      </select>
    </div>
  )
}

/**
 * The F-5.6 summary standing in for an empty synopsis (F-11.1): greyed, behind an "AI" mark,
 * display only. Shared by the index card and the outline row; `className` sets the clamp.
 */
export function AiSummaryLine({
  summary,
  className,
  testId
}: {
  summary: string
  className: string
  testId?: string
}): React.JSX.Element {
  return (
    <p data-testid={testId} className={`m-0 text-xs text-fg-subtle ${className}`}>
      <span
        title="AI summary, shown until you write a synopsis"
        className="mr-1 rounded border border-line px-0.5 text-[10px] font-medium"
      >
        AI
      </span>
      {summary}
    </p>
  )
}
