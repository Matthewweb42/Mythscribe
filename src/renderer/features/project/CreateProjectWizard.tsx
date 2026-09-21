import { useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent } from 'react'
import { AI_SOURCE_LABEL, AI_SOURCE_MEANING, AiSource } from '@shared/aiSettings'
import { PROJECT_NAME_MAX, type NovelFormat } from '@shared/ipc/contract'
import { PROJECT_FORMATS } from './formats'

type Step = 'name' | 'format' | 'source'

const STEPS: readonly Step[] = ['name', 'format', 'source']

const STEP_TITLE: Record<Step, string> = {
  name: 'New project',
  format: 'Choose a format',
  source: 'Choose an AI source'
}

/**
 * What the choice asks of the author next (F-15.11). Neither option is a dead end: the key and
 * the account are both set up in Settings once the project is open, and AI installs at Off.
 */
const sourceHint = (source: AiSource, signedInEmail: string | null): string =>
  source === 'ownKey'
    ? 'Add or change your OpenAI key under Settings › AI once the project is open.'
    : signedInEmail !== null
      ? `Signed in as ${signedInEmail}. Buy credits under Settings › Account.`
      : 'Sign in and buy credits under Settings › Account once the project is open.'

function validateName(name: string): string | null {
  if (name.length === 0) return 'A name is required'
  if (name.length > PROJECT_NAME_MAX) return `Keep the name under ${PROJECT_NAME_MAX} characters`
  return null
}

const SECONDARY_BUTTON =
  'rounded-md border border-line px-3 py-1.5 text-sm hover:bg-surface disabled:opacity-60'
const PRIMARY_BUTTON =
  'rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-accent-fg hover:bg-accent-hover disabled:opacity-60'
const OPTION =
  'block cursor-pointer rounded-md border border-line bg-surface px-3 py-2 hover:bg-bg has-checked:border-accent has-focus-visible:outline-2 has-focus-visible:outline-accent'

/**
 * Three-step create-project form: name, then format (F-1.2), then where AI requests go
 * (F-15.11; switchable later in the AI tab). The caller owns the save location.
 */
export function CreateProjectWizard({
  busy,
  signedInEmail,
  onCancel,
  onCreate
}: {
  busy: boolean
  /** The MythScribe account this machine is signed in to, or null; only the Cloud hint reads it. */
  signedInEmail: string | null
  onCancel: () => void
  onCreate: (name: string, format: NovelFormat, aiSource: AiSource) => Promise<void>
}): React.JSX.Element {
  const titleId = useId()
  const [step, setStep] = useState<Step>('name')
  const [name, setName] = useState('')
  const [format, setFormat] = useState<NovelFormat>('novel')
  const [aiSource, setAiSource] = useState<AiSource>('ownKey')
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
    if (step === 'format') {
      setStep('source')
      return
    }
    setError(null)
    try {
      await onCreate(trimmed, format, aiSource)
    } catch (err) {
      // The author is looking at this form, so the failure belongs here, not in a toast.
      setError(err instanceof Error ? err.message : 'Something went wrong')
    }
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
        {STEP_TITLE[step]}
      </h2>
      <p className="mt-1 mb-0 text-xs text-fg-muted">
        {`Step ${STEPS.indexOf(step) + 1} of ${STEPS.length}`}
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
          {step === 'format' ? (
            <fieldset ref={fieldsetRef} className="mt-4 m-0 flex flex-col gap-2 border-0 p-0">
              <legend className="mb-2 p-0 text-sm font-medium">Format</legend>
              {PROJECT_FORMATS.map((option) => (
                <label key={option.id} className={OPTION}>
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
          ) : (
            <>
              <fieldset ref={fieldsetRef} className="mt-4 m-0 flex flex-col gap-2 border-0 p-0">
                <legend className="mb-2 p-0 text-sm font-medium">AI source</legend>
                {AiSource.options.map((option) => (
                  <label key={option} className={OPTION}>
                    <input
                      type="radio"
                      name="aiSource"
                      value={option}
                      className="sr-only"
                      checked={aiSource === option}
                      onChange={() => setAiSource(option)}
                    />
                    <span className="block text-sm font-medium">{AI_SOURCE_LABEL[option]}</span>
                    <span className="block text-sm text-fg-muted">{AI_SOURCE_MEANING[option]}</span>
                  </label>
                ))}
              </fieldset>
              <p data-testid="wizard-source-hint" className="mt-3 mb-0 text-xs text-fg-muted">
                {sourceHint(aiSource, signedInEmail)} AI stays off until you turn it on, and you can
                switch the source any time in Settings › AI.
              </p>
              <p className="mt-2 mb-0 text-xs text-fg-muted">
                Next, choose where to save it (defaults to Documents/MythScribe).
              </p>
            </>
          )}
          {error ? (
            <p role="alert" className="mt-2 mb-0 text-sm text-danger">
              {error}
            </p>
          ) : null}
          <div className="mt-5 flex justify-end gap-2">
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                setError(null)
                setStep(step === 'source' ? 'format' : 'name')
              }}
              className={SECONDARY_BUTTON}
            >
              Back
            </button>
            <button type="button" disabled={busy} onClick={onCancel} className={SECONDARY_BUTTON}>
              Cancel
            </button>
            <button type="submit" disabled={busy} className={PRIMARY_BUTTON}>
              {step === 'source' ? 'Create' : 'Next'}
            </button>
          </div>
        </>
      )}
    </form>
  )
}
