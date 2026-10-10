import { useId, useState } from 'react'
import { ASSISTANT_NAME_MAX, DEFAULT_ASSISTANT_NAME } from '@shared/assistantName'
import { useViewStore } from '@renderer/features/shell/viewStore'

const FIELD = 'min-w-0 flex-1 rounded-md border border-line bg-bg px-2 py-1 text-sm'

/**
 * The assistant's name (F-7.12), at the top of Settings › AI: committed on blur or Enter like
 * the other text fields of the tab. A blank commit goes back to Ms Scribe; an unchanged one
 * writes nothing. The name is app-wide (every project, the menus), which the hint says.
 */
export function AssistantNameField(): React.JSX.Element {
  const hintId = useId()
  const value = useViewStore((s) => s.assistantName)
  const loaded = useViewStore((s) => s.loaded)
  const setAssistantName = useViewStore((s) => s.setAssistantName)
  const [draft, setDraft] = useState<string | null>(null)
  const [seen, setSeen] = useState(value)
  if (seen !== value) {
    setSeen(value)
    setDraft(null)
  }

  const commit = (): void => {
    if (draft === null) return
    if (draft.trim() === value) {
      setDraft(null)
      return
    }
    void setAssistantName(draft).then(() => setDraft(null))
  }

  return (
    <div className="flex flex-col gap-1">
      <label className="flex items-center gap-3">
        <span className="w-24 shrink-0">Assistant name</span>
        <input
          type="text"
          data-testid="assistant-name"
          maxLength={ASSISTANT_NAME_MAX}
          placeholder={DEFAULT_ASSISTANT_NAME}
          aria-describedby={hintId}
          value={draft ?? value}
          disabled={!loaded}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault()
              commit()
            }
          }}
          className={FIELD}
        />
      </label>
      <p id={hintId} className="m-0 pl-27 text-xs text-fg-muted">
        What the chat panel, the menus, and these settings call the assistant, in every project.
        Leave it blank for {DEFAULT_ASSISTANT_NAME}.
      </p>
    </div>
  )
}
