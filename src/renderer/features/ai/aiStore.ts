import { create } from 'zustand'
import type { AiModelMap, AiStatus, AiTestConnectionResult } from '@shared/ai'
import { ipc } from '@renderer/lib/ipc'

/**
 * The renderer owner of the AI provider status (F-5.1): whether a key is saved (as a masked
 * hint; the key itself never reaches the renderer), how it is protected, and the last
 * connection test. App-wide, not per project, so nothing clears it on project close. `load`,
 * `setKey`, and `clearKey` let unexpected errors propagate for the caller to toast; `test`
 * stores the expected failures the channel answers as data and only throws for a real error.
 */
interface AiState {
  /** null until the first `load` resolves. */
  status: AiStatus | null
  testResult: AiTestConnectionResult | null
  testing: boolean
  load: () => Promise<void>
  /** Sends the key once; a fresh status (with the mask) comes back and any old test result is dropped. */
  setKey: (key: string) => Promise<void>
  clearKey: () => Promise<void>
  /** Replaces the tier → model mapping (F-5.11); the last test result named the old model, so it is dropped. */
  setModels: (models: AiModelMap) => Promise<void>
  test: () => Promise<void>
}

/** Bumped by every reset so a response from a superseded request is dropped. */
let generation = 0

export const useAiStore = create<AiState>((set) => ({
  status: null,
  testResult: null,
  testing: false,

  async load() {
    const mine = generation
    const status = await ipc().invoke('ai:getStatus', undefined)
    if (mine !== generation) return
    set({ status })
  },

  async setKey(key) {
    const mine = generation
    const status = await ipc().invoke('ai:setKey', { key })
    if (mine !== generation) return
    set({ status, testResult: null })
  },

  async clearKey() {
    const mine = generation
    const status = await ipc().invoke('ai:clearKey', undefined)
    if (mine !== generation) return
    set({ status, testResult: null })
  },

  async setModels(models) {
    const mine = generation
    const status = await ipc().invoke('ai:setModels', { provider: 'openai', models })
    if (mine !== generation) return
    set({ status, testResult: null })
  },

  async test() {
    const mine = generation
    set({ testing: true, testResult: null })
    try {
      const testResult = await ipc().invoke('ai:testConnection', undefined)
      if (mine !== generation) return
      set({ testResult })
    } finally {
      if (mine === generation) set({ testing: false })
    }
  }
}))

/** Empties the store and invalidates in-flight requests. For tests only. */
export function resetAiStore(): void {
  generation++
  useAiStore.setState({ status: null, testResult: null, testing: false })
}
