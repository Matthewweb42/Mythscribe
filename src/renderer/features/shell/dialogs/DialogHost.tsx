import { useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent } from 'react'
import { X } from 'lucide-react'
import { useDialogStore, type Modal, type Toast, type ToastKind } from './dialogStore'

/** Mount once near the root. Renders the active modal (first in queue) and the toast stack. */
export function DialogHost(): React.JSX.Element {
  const modal = useDialogStore((s) => s.modals[0])
  const toasts = useDialogStore((s) => s.toasts)
  return (
    <>
      {modal ? <ModalView key={modal.id} modal={modal} /> : null}
      <ToastStack toasts={toasts} />
    </>
  )
}

function ModalView({ modal }: { modal: Modal }): React.JSX.Element {
  const titleId = useId()
  const descId = useId()
  const resolveConfirm = useDialogStore((s) => s.resolveConfirm)
  const resolvePrompt = useDialogStore((s) => s.resolvePrompt)
  const resolveChoose = useDialogStore((s) => s.resolveChoose)
  const [value, setValue] = useState(
    modal.kind === 'prompt' ? (modal.options.initialValue ?? '') : ''
  )
  const [error, setError] = useState<string | null>(null)
  const primaryRef = useRef<HTMLButtonElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (modal.kind === 'prompt') inputRef.current?.focus()
    else primaryRef.current?.focus()
  }, [modal.kind])

  const cancel = (): void => {
    if (modal.kind === 'confirm') resolveConfirm(modal.id, false)
    else if (modal.kind === 'choose') resolveChoose(modal.id, null)
    else resolvePrompt(modal.id, null)
  }

  const primaryChoice =
    modal.kind === 'choose' ? (modal.options.primary ?? modal.options.choices[0]?.value) : undefined

  const submit = (): void => {
    if (modal.kind === 'confirm') {
      resolveConfirm(modal.id, true)
      return
    }
    if (modal.kind === 'choose') {
      resolveChoose(modal.id, primaryChoice ?? null)
      return
    }
    const problem = modal.options.validate?.(value) ?? null
    if (problem) {
      setError(problem)
      return
    }
    resolvePrompt(modal.id, value)
  }

  const onKeyDown = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') {
      e.preventDefault()
      cancel()
    }
  }

  const onSubmit = (e: FormEvent): void => {
    e.preventDefault()
    submit()
  }

  const danger = modal.kind === 'confirm' && modal.options.danger
  const confirmLabel =
    modal.kind === 'choose'
      ? ''
      : (modal.options.confirmLabel ?? (modal.kind === 'confirm' ? 'OK' : 'Save'))
  const cancelLabel = modal.options.cancelLabel ?? 'Cancel'
  const primaryClass =
    'rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-accent-fg hover:bg-accent-hover'
  const secondaryClass = 'rounded-md border border-line px-3 py-1.5 text-sm hover:bg-surface'

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) cancel()
      }}
    >
      <form
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={modal.options.message ? descId : undefined}
        onSubmit={onSubmit}
        onKeyDown={onKeyDown}
        className="w-[420px] max-w-[90vw] rounded-lg border border-line bg-surface-raised p-5 shadow-panel"
      >
        <h2 id={titleId} className="m-0 text-base font-semibold">
          {modal.options.title}
        </h2>
        {modal.options.message ? (
          <p id={descId} className="mt-2 mb-0 text-sm text-fg-muted">
            {modal.options.message}
          </p>
        ) : null}
        {modal.kind === 'choose' && modal.options.details?.length ? (
          <ul className="mt-3 mb-0 list-disc pl-5 text-sm">
            {modal.options.details.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        ) : null}
        {modal.kind === 'prompt' ? (
          <div className="mt-4">
            <input
              ref={inputRef}
              aria-label={modal.options.title}
              aria-invalid={error ? true : undefined}
              value={value}
              placeholder={modal.options.placeholder}
              onChange={(e) => {
                setValue(e.target.value)
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
        ) : null}
        <div className="mt-5 flex flex-wrap justify-end gap-2">
          <button type="button" onClick={cancel} className={secondaryClass}>
            {cancelLabel}
          </button>
          {modal.kind === 'choose' ? (
            modal.options.choices.map((choice) =>
              choice.value === primaryChoice ? (
                <button key={choice.value} ref={primaryRef} type="submit" className={primaryClass}>
                  {choice.label}
                </button>
              ) : (
                <button
                  key={choice.value}
                  type="button"
                  onClick={() => resolveChoose(modal.id, choice.value)}
                  className={secondaryClass}
                >
                  {choice.label}
                </button>
              )
            )
          ) : (
            <button
              ref={primaryRef}
              type="submit"
              className={
                danger
                  ? 'rounded-md bg-danger px-3 py-1.5 text-sm font-medium text-danger-fg hover:opacity-90'
                  : primaryClass
              }
            >
              {confirmLabel}
            </button>
          )}
        </div>
      </form>
    </div>
  )
}

const TOAST_BORDER: Record<ToastKind, string> = {
  success: 'border-l-success',
  error: 'border-l-danger',
  warning: 'border-l-warning',
  info: 'border-l-info'
}

function ToastStack({ toasts }: { toasts: Toast[] }): React.JSX.Element {
  const dismiss = useDialogStore((s) => s.dismissToast)
  return (
    <div
      role="status"
      aria-live="polite"
      className="pointer-events-none fixed right-4 bottom-4 z-40 flex w-[360px] max-w-[90vw] flex-col gap-2"
    >
      {toasts.map((t) => (
        <div
          key={t.id}
          data-kind={t.kind}
          className={`pointer-events-auto flex items-start gap-3 rounded-md border border-line border-l-4 bg-surface-raised px-3 py-2 text-sm shadow-panel ${TOAST_BORDER[t.kind]}`}
        >
          <span className="flex-1">{t.message}</span>
          {t.action !== undefined ? (
            <button
              type="button"
              onClick={() => {
                dismiss(t.id)
                t.action?.run()
              }}
              className="font-medium text-accent hover:underline"
            >
              {t.action.label}
            </button>
          ) : null}
          <button
            type="button"
            aria-label="Dismiss notification"
            onClick={() => dismiss(t.id)}
            className="text-fg-muted hover:text-fg"
          >
            <X size={14} />
          </button>
        </div>
      ))}
    </div>
  )
}
