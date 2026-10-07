import { useId, useRef } from 'react'
import {
  AI_SWITCH_LABEL,
  AI_SWITCH_MEANING,
  AI_SWITCH_POSITIONS,
  aiSwitchOf,
  aiSwitchPatch,
  type AiSwitch
} from '@shared/aiSettings'
import { useAiSettingsStore } from './aiSettingsStore'

const FULL_RADIO =
  'flex min-w-0 flex-1 flex-col gap-0.5 rounded-md border border-line px-2 py-1.5 text-left hover:bg-surface focus-visible:outline-2 focus-visible:outline-accent aria-checked:border-accent aria-checked:bg-surface-raised'
/** One segment of the compact switch; the look of the assistant's mode switch beside it. */
const COMPACT_RADIO =
  'rounded px-2 py-px text-[11px] leading-4 text-fg-muted hover:text-fg focus-visible:outline-2 focus-visible:outline-accent aria-checked:bg-bg aria-checked:text-fg aria-checked:shadow-sm'

/**
 * The one AI switch (F-5.21): Off / Ask / Auto as an ARIA radiogroup named "AI switch" (roving
 * tabindex; arrow keys, Home, and End move and select). `full` is the Settings form, each
 * position with its meaning underneath; `compact` is the small segmented control under the
 * assistant's message box, prefixed "AI" and named "AI Off" / "AI Ask" / "AI Auto" so it never
 * reads as the conversation's Auto mode beside it, the meaning in each segment's tooltip. Both write through the AI
 * settings store, so they always agree. Nothing renders until the project's settings load.
 */
export function AiSwitchControl({
  variant
}: {
  variant: 'full' | 'compact'
}): React.JSX.Element | null {
  const settings = useAiSettingsStore((s) => s.settings)
  const update = useAiSettingsStore((s) => s.update)
  const radios = useRef(new Map<AiSwitch, HTMLButtonElement>())
  const labelId = useId()
  if (settings === null) return null
  const current = aiSwitchOf(settings)

  const select = (position: AiSwitch): void => {
    if (position !== current) update(aiSwitchPatch(position))
    radios.current.get(position)?.focus()
  }

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    const index = AI_SWITCH_POSITIONS.indexOf(current)
    const last = AI_SWITCH_POSITIONS.length - 1
    let next: number
    switch (event.key) {
      case 'ArrowRight':
      case 'ArrowDown':
        next = index === last ? 0 : index + 1
        break
      case 'ArrowLeft':
      case 'ArrowUp':
        next = index === 0 ? last : index - 1
        break
      case 'Home':
        next = 0
        break
      case 'End':
        next = last
        break
      default:
        return
    }
    event.preventDefault()
    const target = AI_SWITCH_POSITIONS[next]
    if (target !== undefined) select(target)
  }

  const register = (position: AiSwitch) => (element: HTMLButtonElement | null) => {
    if (element) radios.current.set(position, element)
    else radios.current.delete(position)
  }

  if (variant === 'compact') {
    return (
      <div
        role="radiogroup"
        aria-label="AI switch"
        data-testid="ai-switch"
        onKeyDown={onKeyDown}
        className="inline-flex items-center gap-0.5 rounded-md bg-surface-raised p-0.5"
      >
        <span aria-hidden="true" className="pl-1 text-[10px] font-medium text-fg-subtle">
          AI
        </span>
        {AI_SWITCH_POSITIONS.map((position) => (
          <button
            key={position}
            ref={register(position)}
            type="button"
            role="radio"
            aria-checked={position === current}
            tabIndex={position === current ? 0 : -1}
            aria-label={`AI ${AI_SWITCH_LABEL[position]}`}
            title={`AI ${AI_SWITCH_LABEL[position]}: ${AI_SWITCH_MEANING[position]}`}
            onClick={() => select(position)}
            className={COMPACT_RADIO}
          >
            {AI_SWITCH_LABEL[position]}
          </button>
        ))}
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-1.5">
      <span id={labelId} className="text-xs text-fg-muted">
        AI switch
      </span>
      <div role="radiogroup" aria-labelledby={labelId} onKeyDown={onKeyDown} className="flex gap-2">
        {AI_SWITCH_POSITIONS.map((position) => (
          <FullRadio
            key={position}
            position={position}
            checked={position === current}
            register={register(position)}
            onSelect={select}
          />
        ))}
      </div>
    </div>
  )
}

/** One position of the Settings form: the label is the accessible name, the meaning its description. */
function FullRadio({
  position,
  checked,
  register,
  onSelect
}: {
  position: AiSwitch
  checked: boolean
  register: (element: HTMLButtonElement | null) => void
  onSelect: (position: AiSwitch) => void
}): React.JSX.Element {
  const labelId = useId()
  const meaningId = useId()
  return (
    <button
      ref={register}
      type="button"
      role="radio"
      aria-checked={checked}
      aria-labelledby={labelId}
      aria-describedby={meaningId}
      tabIndex={checked ? 0 : -1}
      onClick={() => onSelect(position)}
      className={FULL_RADIO}
    >
      <span id={labelId} className="font-medium">
        {AI_SWITCH_LABEL[position]}
      </span>
      <span id={meaningId} className="text-xs text-fg-muted">
        {AI_SWITCH_MEANING[position]}
      </span>
    </button>
  )
}
