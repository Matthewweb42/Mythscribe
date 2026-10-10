import { create } from 'zustand'

/**
 * The one dialog service (FEATURES.md F-7.6). Every confirm, prompt, and toast in the app goes
 * through here; native alert/confirm/prompt are forbidden.
 */

export interface ConfirmOptions {
  title: string
  message: string
  confirmLabel?: string
  cancelLabel?: string
  danger?: boolean
}

export interface PromptOptions {
  title: string
  message?: string
  placeholder?: string
  initialValue?: string
  confirmLabel?: string
  cancelLabel?: string
  /** Return an error message to block submission, or null to allow it. */
  validate?: (value: string) => string | null
}

/** One answer of a `choose` dialog. */
export interface Choice<T extends string> {
  value: T
  label: string
}

/** A question with more than one way forward, plus Cancel (Escape, a click outside). */
export interface ChooseOptions<T extends string> {
  title: string
  message: string
  /** Lines shown as a list under the message (the facts the choice rests on). */
  details?: string[]
  choices: Choice<T>[]
  /** The highlighted answer, which Enter picks; the first choice when absent. */
  primary?: T
  cancelLabel?: string
}

export type ToastKind = 'success' | 'error' | 'warning' | 'info'

export interface Toast {
  id: string
  kind: ToastKind
  message: string
}

export type Modal =
  | { kind: 'confirm'; id: string; options: ConfirmOptions; resolve: (value: boolean) => void }
  | { kind: 'prompt'; id: string; options: PromptOptions; resolve: (value: string | null) => void }
  | {
      kind: 'choose'
      id: string
      options: ChooseOptions<string>
      resolve: (value: string | null) => void
    }

interface DialogState {
  modals: Modal[]
  toasts: Toast[]
  confirm: (options: ConfirmOptions) => Promise<boolean>
  prompt: (options: PromptOptions) => Promise<string | null>
  choose: (options: ChooseOptions<string>) => Promise<string | null>
  resolveConfirm: (id: string, value: boolean) => void
  resolvePrompt: (id: string, value: string | null) => void
  resolveChoose: (id: string, value: string | null) => void
  toast: (kind: ToastKind, message: string, durationMs?: number) => string
  dismissToast: (id: string) => void
}

const DEFAULT_TOAST_MS: Record<ToastKind, number> = {
  success: 3000,
  info: 4000,
  warning: 6000,
  error: 8000
}

let counter = 0
const nextId = (): string => `dlg-${++counter}`

export const useDialogStore = create<DialogState>((set, get) => ({
  modals: [],
  toasts: [],

  confirm(options) {
    return new Promise<boolean>((resolve) => {
      const id = nextId()
      set((s) => ({ modals: [...s.modals, { kind: 'confirm', id, options, resolve }] }))
    })
  },

  prompt(options) {
    return new Promise<string | null>((resolve) => {
      const id = nextId()
      set((s) => ({ modals: [...s.modals, { kind: 'prompt', id, options, resolve }] }))
    })
  },

  choose(options) {
    return new Promise<string | null>((resolve) => {
      const id = nextId()
      set((s) => ({ modals: [...s.modals, { kind: 'choose', id, options, resolve }] }))
    })
  },

  resolveConfirm(id, value) {
    const modal = get().modals.find((m) => m.id === id)
    if (modal?.kind !== 'confirm') return
    set((s) => ({ modals: s.modals.filter((m) => m.id !== id) }))
    modal.resolve(value)
  },

  resolvePrompt(id, value) {
    const modal = get().modals.find((m) => m.id === id)
    if (modal?.kind !== 'prompt') return
    set((s) => ({ modals: s.modals.filter((m) => m.id !== id) }))
    modal.resolve(value)
  },

  resolveChoose(id, value) {
    const modal = get().modals.find((m) => m.id === id)
    if (modal?.kind !== 'choose') return
    set((s) => ({ modals: s.modals.filter((m) => m.id !== id) }))
    modal.resolve(value)
  },

  toast(kind, message, durationMs = DEFAULT_TOAST_MS[kind]) {
    const id = nextId()
    set((s) => ({ toasts: [...s.toasts, { id, kind, message }] }))
    if (durationMs > 0) setTimeout(() => get().dismissToast(id), durationMs)
    return id
  },

  dismissToast(id) {
    set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }))
  }
}))

/** Convenience API for non-component code. */
export const dialogs = {
  confirm: (options: ConfirmOptions) => useDialogStore.getState().confirm(options),
  prompt: (options: PromptOptions) => useDialogStore.getState().prompt(options),
  /** The value of the choice the author picked, or null for Cancel. */
  async choose<T extends string>(options: ChooseOptions<T>): Promise<T | null> {
    const picked = await useDialogStore.getState().choose(options)
    return options.choices.find((c) => c.value === picked)?.value ?? null
  }
}

export const toast = {
  success: (message: string) => useDialogStore.getState().toast('success', message),
  error: (message: string) => useDialogStore.getState().toast('error', message),
  warning: (message: string) => useDialogStore.getState().toast('warning', message),
  info: (message: string) => useDialogStore.getState().toast('info', message)
}
