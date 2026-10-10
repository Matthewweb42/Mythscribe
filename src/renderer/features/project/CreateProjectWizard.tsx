import { useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent } from 'react'
import {
  AI_SOURCE_LABEL,
  AI_SOURCE_MEANING,
  ASSISTANT_MODE_LABEL,
  AiSource,
  CLOUD_COMING_SOON,
  DEFAULT_ASSISTANT_MODE,
  USE_AI_LABEL,
  USE_AI_MEANING,
  type AiSwitch
} from '@shared/aiSettings'
import { CLOUD_AI_AVAILABLE } from '@shared/cloudApi'
import { PROJECT_NAME_MAX, type NovelFormat } from '@shared/ipc/contract'
import { useLibraryStore } from '@renderer/features/library/libraryStore'
import { PROJECT_FORMATS } from './formats'
import { useAssistantName } from '@renderer/features/shell/viewStore'
import { nameAssistant } from '@shared/assistantName'

type Step = 'name' | 'format' | 'source' | 'dial' | 'context'

const STEPS: readonly Step[] = ['name', 'format', 'source', 'dial', 'context']

const STEP_TITLE: Record<Step, string> = {
  name: 'New project',
  format: 'Choose a format',
  source: 'Choose an AI source',
  dial: 'Choose whether AI helps',
  context: 'Have worldbuilding docs? Add them'
}

/**
 * The wizard's AI step (F-5.18; since 2026-10-07 Use AI on or off, decided by the author): on is
 * recommended and preselected, so the background work runs (summaries with the story bible and
 * tags, PLAN.md §2.6) and the chat starts in Ask, where every AI edit asks first. The author
 * still chooses; off is one click away. On is sent as the `ask` position, off as `off`.
 */
const USE_AI_OPTIONS = ['on', 'off'] as const
type UseAi = (typeof USE_AI_OPTIONS)[number]
const RECOMMENDED_USE_AI: UseAi = 'on'
const USE_AI_OPTION_LABEL: Record<UseAi, string> = { on: 'On', off: 'Off' }
const switchFor = (useAi: UseAi): AiSwitch => (useAi === 'on' ? 'ask' : 'off')

/**
 * What the choice asks of the author next (F-15.11). Neither option is a dead end: the key and
 * the account are both set up in Settings once the project is open, and AI installs at Off.
 */
const sourceHint = (source: AiSource, signedInEmail: string | null): string =>
  source === 'ownKey'
    ? 'Add or change your OpenAI key under Settings › AI once the project is open.'
    : source === 'local'
      ? 'Start Ollama or LM Studio, then set its address and models under Settings › AI.'
      : signedInEmail !== null
        ? `Signed in as ${signedInEmail}. Add to your balance under Settings › Account.`
        : 'Sign in and add to your balance under Settings › Account once the project is open.'

/** What the previous step leads to: the dial step, or back to the source. */
const PREVIOUS: Record<Exclude<Step, 'name'>, Step> = {
  format: 'name',
  source: 'format',
  dial: 'source',
  context: 'dial'
}

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
  'block cursor-pointer rounded-md border border-line bg-surface px-3 py-2 hover:bg-bg has-checked:border-accent has-focus-visible:outline-2 has-focus-visible:outline-accent has-disabled:cursor-not-allowed has-disabled:opacity-60 has-disabled:hover:bg-surface'

/**
 * Five-step create-project form: name, then format (F-1.2), then where AI requests go
 * (F-15.11), then whether AI helps (F-5.18, Use AI); both AI choices are switchable later in the AI
 * tab. Last, optional, the author's worldbuilding files for the context library (F-9.8), only
 * picked here; the caller adds them once the project exists. The caller owns the save location. Own key is preselected; while Cloud does not serve AI
 * yet (decided by the author 2026-10-07) its option is shown disabled with "Coming soon".
 */
export function CreateProjectWizard({
  busy,
  signedInEmail,
  onCancel,
  onCreate,
  cloudAvailable = CLOUD_AI_AVAILABLE
}: {
  busy: boolean
  /** The MythScribe account this machine is signed in to, or null; only the Cloud hint reads it. */
  signedInEmail: string | null
  onCancel: () => void
  onCreate: (
    name: string,
    format: NovelFormat,
    aiSource: AiSource,
    aiSwitch: AiSwitch,
    /** F-9.8: worldbuilding files for the context library, added once the project exists. */
    contextPaths: string[]
  ) => Promise<void>
  /** Whether the Cloud source can be chosen; the shared flag unless a test says otherwise. */
  cloudAvailable?: boolean
}): React.JSX.Element {
  const titleId = useId()
  const assistantName = useAssistantName()
  const [step, setStep] = useState<Step>('name')
  const [name, setName] = useState('')
  const [format, setFormat] = useState<NovelFormat>('novel')
  const [aiSource, setAiSource] = useState<AiSource>('ownKey')
  const [useAi, setUseAi] = useState<UseAi>(RECOMMENDED_USE_AI)
  const [contextPaths, setContextPaths] = useState<string[]>([])
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
    if (step === 'source') {
      setStep('dial')
      return
    }
    if (step === 'dial') {
      setStep('context')
      return
    }
    setError(null)
    try {
      await onCreate(trimmed, format, aiSource, switchFor(useAi), contextPaths)
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
          ) : step === 'source' ? (
            <>
              <fieldset ref={fieldsetRef} className="mt-4 m-0 flex flex-col gap-2 border-0 p-0">
                <legend className="mb-2 p-0 text-sm font-medium">AI source</legend>
                {AiSource.options.map((option) => {
                  const comingSoon = option === 'cloud' && !cloudAvailable
                  return (
                    <label key={option} className={OPTION}>
                      <input
                        type="radio"
                        name="aiSource"
                        value={option}
                        className="sr-only"
                        disabled={comingSoon}
                        checked={aiSource === option}
                        onChange={() => setAiSource(option)}
                      />
                      <span className="block text-sm font-medium">
                        {AI_SOURCE_LABEL[option]}
                        {comingSoon ? (
                          <span
                            data-testid="wizard-cloud-coming-soon"
                            className="ml-2 rounded-sm border border-line px-1.5 py-0.5 text-xs font-medium text-fg-muted"
                          >
                            {CLOUD_COMING_SOON}
                          </span>
                        ) : null}
                      </span>
                      <span className="block text-sm text-fg-muted">
                        {AI_SOURCE_MEANING[option]}
                      </span>
                    </label>
                  )
                })}
              </fieldset>
              <p data-testid="wizard-source-hint" className="mt-3 mb-0 text-xs text-fg-muted">
                {sourceHint(aiSource, signedInEmail)} You can switch the source any time in Settings
                › AI.
              </p>
            </>
          ) : step === 'context' ? (
            <>
              <p className="mt-4 mb-0 text-sm text-fg-muted">
                Character notes, settings, world rules, a plot outline, maps, or art (Word,
                Markdown, text, PDF, images). They are kept in the project’s Library.
                {useAi === 'on'
                  ? ' Once the project is open, the AI sorts them into your story bible: you see the cost first and review everything before it lands.'
                  : ' Turn on Use AI later to have them sorted into your story bible.'}{' '}
                Optional: skip this and press Create.
              </p>
              <div className="mt-3 flex items-center gap-2">
                <button
                  type="button"
                  data-testid="wizard-context-add"
                  disabled={busy}
                  onClick={() => {
                    useLibraryStore
                      .getState()
                      .choosePaths()
                      .then((chosen) =>
                        setContextPaths((held) => [
                          ...held,
                          ...chosen.filter((file) => !held.includes(file))
                        ])
                      )
                      .catch((err: unknown) =>
                        setError(err instanceof Error ? err.message : 'Something went wrong')
                      )
                  }}
                  className={SECONDARY_BUTTON}
                >
                  Add files…
                </button>
                <span className="text-xs text-fg-subtle">
                  {contextPaths.length === 0
                    ? 'No files yet'
                    : `${contextPaths.length} ${contextPaths.length === 1 ? 'file' : 'files'}`}
                </span>
              </div>
              {contextPaths.length > 0 ? (
                <ul className="mt-2 mb-0 list-none p-0" aria-label="Files to add">
                  {contextPaths.map((file) => {
                    const fileName = file.split(/[\\/]/).pop() ?? file
                    return (
                      <li key={file} className="flex items-center gap-2 text-sm">
                        <span className="min-w-0 flex-1 truncate" title={file}>
                          {fileName}
                        </span>
                        <button
                          type="button"
                          aria-label={`Remove ${fileName}`}
                          disabled={busy}
                          onClick={() => setContextPaths((held) => held.filter((f) => f !== file))}
                          className="rounded px-1.5 text-fg-muted hover:bg-surface hover:text-fg"
                        >
                          ×
                        </button>
                      </li>
                    )
                  })}
                </ul>
              ) : null}
              <p className="mt-3 mb-0 text-xs text-fg-muted">
                Next, choose where to save the project (defaults to Documents/MythScribe).
              </p>
            </>
          ) : (
            <>
              <p data-testid="wizard-dial-explainer" className="mt-4 mb-0 text-sm text-fg-muted">
                You write; with AI on, it works behind you. When you pause typing it summarizes the
                scene, notes what it states about your characters, places, and world in the story
                bible, tags it, and flags contradictions. {assistantName} opens beside the editor
                for questions and one-click actions. It starts in{' '}
                {ASSISTANT_MODE_LABEL[DEFAULT_ASSISTANT_MODE]}: every change it wants to make asks
                you first. Switch to Auto or Plan under the chat box.
              </p>
              <fieldset ref={fieldsetRef} className="mt-3 m-0 flex flex-col gap-2 border-0 p-0">
                <legend className="mb-2 p-0 text-sm font-medium">{USE_AI_LABEL}</legend>
                {USE_AI_OPTIONS.map((option) => (
                  <label key={option} className={OPTION}>
                    <input
                      type="radio"
                      name="useAi"
                      value={option}
                      className="sr-only"
                      checked={useAi === option}
                      onChange={() => setUseAi(option)}
                    />
                    <span className="block text-sm font-medium">
                      {USE_AI_OPTION_LABEL[option]}
                      {option === RECOMMENDED_USE_AI ? (
                        <span className="ml-2 rounded-sm bg-accent px-1.5 py-0.5 text-xs font-medium text-accent-fg">
                          Recommended
                        </span>
                      ) : null}
                    </span>
                    <span className="block text-sm text-fg-muted">
                      {nameAssistant(USE_AI_MEANING[option], assistantName)}
                    </span>
                  </label>
                ))}
              </fieldset>
              <p className="mt-3 mb-0 text-xs text-fg-muted">
                Change it any time in Settings › AI.
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
                setStep(PREVIOUS[step])
              }}
              className={SECONDARY_BUTTON}
            >
              Back
            </button>
            <button type="button" disabled={busy} onClick={onCancel} className={SECONDARY_BUTTON}>
              Cancel
            </button>
            <button type="submit" disabled={busy} className={PRIMARY_BUTTON}>
              {step === 'context' ? 'Create' : 'Next'}
            </button>
          </div>
        </>
      )}
    </form>
  )
}
