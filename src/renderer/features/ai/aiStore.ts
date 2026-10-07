import { create } from 'zustand'
import {
  DEFAULT_OWN_KEY_PROVIDER,
  OwnKeyProvider,
  USAGE_HISTORY_PAGE,
  type AiFeatureId,
  type AiModelMap,
  type AiProviderId,
  type AiStatus,
  type AiTestConnectionResult,
  type AiUsageHistory,
  type AiUsageSummary,
  type Tier
} from '@shared/ai'
import {
  autoTable,
  hostedAutoTable,
  resolveTier,
  type AiModelChoice,
  type AiRouting
} from '@shared/aiRouting'
import { providerForSource, type AiSource } from '@shared/aiSettings'
import { ipc } from '@renderer/lib/ipc'
import { flushAiSettings } from './aiSettingsStore'

/**
 * The renderer owner of the AI provider status (F-5.1): whether a key is saved (as a masked
 * hint; the key itself never reaches the renderer), how it is protected, and the last
 * connection test. App-wide, not per project, so nothing clears it on project close. `load`,
 * `setKey`, and `clearKey` let unexpected errors propagate for the caller to toast; `test`
 * stores the expected failures the channel answers as data and only throws for a real error.
 * `usage` (F-5.14) mixes the app-wide day with the open project's ledger, so the tab reloads
 * it on every mount instead of trusting a figure from another project.
 */
interface AiState {
  /** null until the first `load` resolves. */
  status: AiStatus | null
  testResult: AiTestConnectionResult | null
  testing: boolean
  /** null until the first `loadUsage` resolves. */
  usage: AiUsageSummary | null
  load: () => Promise<void>
  loadUsage: () => Promise<void>
  /** Replaces the app-wide daily spend cap (F-5.14); the summary answered carries it. */
  setDailyCap: (dailyCapUsd: number) => Promise<void>
  /** Sends the key once; a fresh status (with the mask) comes back and any old test result is dropped. */
  setKey: (key: string) => Promise<void>
  clearKey: () => Promise<void>
  /**
   * Replaces one provider's tier → model mapping (F-5.11; the provider is the project's AI
   * source, F-15.4). The last test result named the old model, so it is dropped.
   */
  setModels: (provider: AiProviderId, models: AiModelMap) => Promise<void>
  /** F-5.15: where the local model server answers. */
  setLocalEndpoint: (baseUrl: string) => Promise<void>
  test: () => Promise<void>
  /** 2026-10-07: which provider an own key is for (OpenRouter or OpenAI). */
  setOwnKeyProvider: (provider: OwnKeyProvider) => Promise<void>
  /** Model choice (AI-BILLING-SPEC M8, R4): the overrides and the Cloud table; null until loaded. */
  choice: AiModelChoice | null
  loadChoice: () => Promise<void>
  setRouting: (routing: AiRouting) => Promise<void>
  /** One page of the usage history (E7); null until a page is asked for. */
  history: AiUsageHistory | null
  historyOffset: number
  loadHistory: (offset: number) => Promise<void>
}

/** Bumped by every reset so a response from a superseded request is dropped. */
let generation = 0

export const useAiStore = create<AiState>((set) => ({
  status: null,
  testResult: null,
  testing: false,
  usage: null,
  choice: null,
  history: null,
  historyOffset: 0,

  async load() {
    const mine = generation
    const status = await ipc().invoke('ai:getStatus', undefined)
    if (mine !== generation) return
    set({ status })
  },

  async loadUsage() {
    const mine = generation
    const usage = await ipc().invoke('ai:usageSummary', undefined)
    if (mine !== generation) return
    set({ usage })
  },

  async setDailyCap(dailyCapUsd) {
    const mine = generation
    const usage = await ipc().invoke('ai:setDailyCap', { dailyCapUsd })
    if (mine !== generation) return
    set({ usage })
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

  async setModels(provider, models) {
    const mine = generation
    const status = await ipc().invoke('ai:setModels', { provider, models })
    if (mine !== generation) return
    set({ status, testResult: null })
  },

  async setLocalEndpoint(baseUrl) {
    const mine = generation
    const status = await ipc().invoke('ai:setLocalEndpoint', { baseUrl })
    if (mine !== generation) return
    set({ status, testResult: null })
  },

  async setOwnKeyProvider(provider) {
    const mine = generation
    const status = await ipc().invoke('ai:setOwnKeyProvider', { provider })
    if (mine !== generation) return
    set({ status, testResult: null })
  },

  async loadChoice() {
    const mine = generation
    const choice = await ipc().invoke('ai:getModelChoice', undefined)
    if (mine !== generation) return
    set({ choice })
  },

  async setRouting(routing) {
    const mine = generation
    const choice = await ipc().invoke('ai:setRouting', routing)
    if (mine !== generation) return
    set({ choice })
  },

  async loadHistory(offset) {
    const mine = generation
    const history = await ipc().invoke('ai:usageHistory', {
      offset,
      limit: USAGE_HISTORY_PAGE
    })
    if (mine !== generation) return
    set({ history, historyOffset: offset })
  },

  async test() {
    const mine = generation
    set({ testing: true, testResult: null })
    try {
      // Main reads the project's AI source (F-15.4) from the saved settings row, so a source
      // just picked in the tab has to land before the test is sent; otherwise a test clicked
      // inside the settings debounce answers for the source the author just left.
      await flushAiSettings()
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
  useAiStore.setState({
    status: null,
    testResult: null,
    testing: false,
    usage: null,
    choice: null,
    history: null,
    historyOffset: 0
  })
}

/** The provider an own key is for, from the status main answered; the default before it loads. */
export function ownKeyOf(status: AiStatus | null): OwnKeyProvider {
  const parsed = OwnKeyProvider.safeParse(status?.provider)
  return parsed.success ? parsed.data : DEFAULT_OWN_KEY_PROVIDER
}

/** The provider whose models a source uses, given what main answered (F-15.4, 2026-10-07). */
export function providerOf(status: AiStatus | null, source: AiSource): AiProviderId {
  return providerForSource(source, ownKeyOf(status))
}

/**
 * The tier a feature's request goes out on, as main's request path routes it (`resolveTier`):
 * the author's overrides, then the Auto table (the Cloud one on Cloud). Before the choice has
 * loaded, the tier the feature asks for.
 */
export function routedTier(
  choice: AiModelChoice | null,
  source: AiSource,
  feature: AiFeatureId,
  requested: Tier
): Tier {
  if (choice === null) return requested
  const cloudTable = source === 'cloud' ? hostedAutoTable(choice.cloudPricing) : null
  return resolveTier({ feature, requested, routing: choice.routing, table: autoTable(cloudTable) })
}
