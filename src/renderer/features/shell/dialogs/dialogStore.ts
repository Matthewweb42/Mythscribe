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

export type ToastKind = 'success' | 'error' | 'warning' | 'info'

export interface Toast {
  id: string
  kind: ToastKind
  message: string
}

export type Modal =
  | { kind: 'confirm'; id: string; options: ConfirmOptions; resolve: (value: boolean) => void }
  | { kind: 'prompt'; id: string; options: PromptOptions; resolve: (value: string | null) => void }

interface DialogState {
  modals: Modal[]
  toasts: Toast[]
  confirm: (options: ConfirmOptions) => Promise<boolean>
  prompt: (options: PromptOptions) => Promise<string | null>
  resolveConfirm: (id: string, value: boolean) => void
  resolvePrompt: (id: string, value: string | null) => void
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
  prompt: (options: PromptOptions) => useDialogStore.getState().prompt(options)
}

export const toast = {
  success: (message: string) => useDialogStore.getState().toast('success', message),
  error: (message: string) => useDialogStore.getState().toast('error', message),
  warning: (message: string) => useDialogStore.getState().toast('warning', message),
  info: (message: string) => useDialogStore.getState().toast('info', message)
}
