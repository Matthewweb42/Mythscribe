import { useRef } from 'react'
import {
  ASSISTANT_MODES,
  ASSISTANT_MODE_LABEL,
  ASSISTANT_MODE_MEANING,
  type AssistantMode
} from '@shared/aiSettings'
import { useAiSettingsStore } from './aiSettingsStore'
import { useAssistantName } from '@renderer/features/shell/viewStore'
import { nameAssistant } from '@shared/assistantName'

/** One segment of the switch. */
const MODE_RADIO =
  'rounded px-2 py-px text-[11px] leading-4 text-fg-muted hover:text-fg focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-40 disabled:hover:text-fg-muted aria-checked:bg-bg aria-checked:text-fg aria-checked:shadow-sm'

/**
 * The chat mode switch under the assistant's message box (decided by the author 2026-10-07):
 * Auto · Ask · Plan as an ARIA radiogroup named "Mode" (roving tabindex; arrow keys, Home, and
 * End move and select), each option's meaning in its tooltip. One setting per project, written
 * through the AI settings store (`chatMode`), so every conversation tab shares it. Disabled
 * while Use AI is off (the note above the box says where to turn it on); nothing renders until
 * the project's settings load.
 */
export function AssistantModeControl(): React.JSX.Element | null {
  const settings = useAiSettingsStore((s) => s.settings)
  const update = useAiSettingsStore((s) => s.update)
  const assistantName = useAssistantName()
  const radios = useRef(new Map<AssistantMode, HTMLButtonElement>())
  if (settings === null) return null
  const current = settings.chatMode
  const off = settings.dial === 0

  const select = (mode: AssistantMode): void => {
    if (mode !== current) update({ chatMode: mode })
    radios.current.get(mode)?.focus()
  }

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    const index = ASSISTANT_MODES.indexOf(current)
    const last = ASSISTANT_MODES.length - 1
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
    const target = ASSISTANT_MODES[next]
    if (target !== undefined) select(target)
  }

  return (
    <div
      role="radiogroup"
      aria-label="Mode"
      data-testid="assistant-mode"
      onKeyDown={off ? undefined : onKeyDown}
      className="inline-flex items-center rounded-md bg-surface-raised p-0.5"
    >
      {ASSISTANT_MODES.map((mode) => (
        <button
          key={mode}
          ref={(element) => {
            if (element) radios.current.set(mode, element)
            else radios.current.delete(mode)
          }}
          type="button"
          role="radio"
          aria-checked={mode === current}
          tabIndex={mode === current ? 0 : -1}
          disabled={off}
          title={`${ASSISTANT_MODE_LABEL[mode]}: ${nameAssistant(ASSISTANT_MODE_MEANING[mode], assistantName)}`}
          onClick={() => select(mode)}
          className={MODE_RADIO}
        >
          {ASSISTANT_MODE_LABEL[mode]}
        </button>
      ))}
    </div>
  )
}
