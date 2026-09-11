import { useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent } from 'react'
import { PROJECT_NAME_MAX, type NovelFormat } from '@shared/ipc/contract'
import { PROJECT_FORMATS } from './formats'

type Step = 'name' | 'format'

function validateName(name: string): string | null {
  if (name.length === 0) return 'A name is required'
  if (name.length > PROJECT_NAME_MAX) return `Keep the name under ${PROJECT_NAME_MAX} characters`
  return null
}

const SECONDARY_BUTTON =
  'rounded-md border border-line px-3 py-1.5 text-sm hover:bg-surface disabled:opacity-60'
const PRIMARY_BUTTON =
  'rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-accent-fg hover:bg-accent-hover disabled:opacity-60'

/** Two-step create-project form (F-1.2): name, then format. The caller owns the save location. */
export function CreateProjectWizard({
  busy,
  onCancel,
  onCreate
}: {
  busy: boolean
  onCancel: () => void
  onCreate: (name: string, format: NovelFormat) => Promise<void>
}): React.JSX.Element {
  const titleId = useId()
  const [step, setStep] = useState<Step>('name')
  const [name, setName] = useState('')
  const [format, setFormat] = useState<NovelFormat>('novel')
  const [error, setError] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const fieldsetRef = useRef<HTMLFieldSetElement>(null)

  useEffect(() => {
    if (step === 'name') inputRef.current?.focus()
    else fieldsetRef.current?.querySelector<HTMLInputElement>('input:checked')?.focus()
  }, [step])

  const onKeyDown = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') {
      e.preventDefault()
      if (!busy) onCancel()
    }
  }

  const onSubmit = async (e: FormEvent): Promise<void> => {
    e.preventDefault()
    const trimmed = name.trim()
    if (step === 'name') {
      const problem = validateName(trimmed)
      if (problem) {
        setError(problem)
        return
      }
      setStep('format')
      return
    }
    await onCreate(trimmed, format)
  }

  return (
    <form
      role="dialog"
      aria-labelledby={titleId}
      onSubmit={(e) => void onSubmit(e)}
      onKeyDown={onKeyDown}
      className="w-full rounded-lg border border-line bg-surface-raised p-5 text-left shadow-panel"
    >
      <h2 id={titleId} className="m-0 text-base font-semibold">
        {step === 'name' ? 'New project' : 'Choose a format'}
      </h2>
      <p className="mt-1 mb-0 text-xs text-fg-muted">
        {step === 'name' ? 'Step 1 of 2' : 'Step 2 of 2'}
      </p>

      {step === 'name' ? (
        <>
          <div className="mt-4">
            <input
              ref={inputRef}
              aria-label="Project name"
              aria-invalid={error ? true : undefined}
              value={name}
              placeholder="My Epic Novel"
              onChange={(e) => {
                setName(e.target.value)
                setError(null)
              }}
              className="w-full rounded-md border border-line bg-bg px-3 py-2 text-sm"
            />
            {error ? (
              <p role="alert" className="mt-1 mb-0 text-xs text-danger">
                {error}
              </p>
            ) : null}
          </div>
          <div className="mt-5 flex justify-end gap-2">
            <button type="button" onClick={onCancel} className={SECONDARY_BUTTON}>
              Cancel
            </button>
            <button type="submit" className={PRIMARY_BUTTON}>
              Next
            </button>
          </div>
        </>
      ) : (
        <>
          <fieldset ref={fieldsetRef} className="mt-4 m-0 flex flex-col gap-2 border-0 p-0">
            <legend className="mb-2 p-0 text-sm font-medium">Format</legend>
            {PROJECT_FORMATS.map((option) => (
              <label
                key={option.id}
                className="block cursor-pointer rounded-md border border-line bg-surface px-3 py-2 hover:bg-bg has-checked:border-accent has-focus-visible:outline-2 has-focus-visible:outline-accent"
              >
                <input
                  type="radio"
                  name="format"
                  value={option.id}
                  className="sr-only"
                  checked={format === option.id}
                  onChange={() => setFormat(option.id)}
                />
                <span className="block text-sm font-medium">{option.label}</span>
                <span className="block text-sm text-fg-muted">{option.summary}</span>
                <span className="mt-1 block text-xs text-fg-subtle">{option.structure}</span>
              </label>
            ))}
          </fieldset>
          <p className="mt-3 mb-0 text-xs text-fg-muted">
            Next, choose where to save it (defaults to Documents/MythScribe).
          </p>
          <div className="mt-5 flex justify-end gap-2">
            <button
              type="button"
              disabled={busy}
              onClick={() => setStep('name')}
              className={SECONDARY_BUTTON}
            >
              Back
            </button>
            <button type="button" disabled={busy} onClick={onCancel} className={SECONDARY_BUTTON}>
              Cancel
            </button>
            <button type="submit" disabled={busy} className={PRIMARY_BUTTON}>
              Create
            </button>
          </div>
        </>
      )}
    </form>
  )
}
