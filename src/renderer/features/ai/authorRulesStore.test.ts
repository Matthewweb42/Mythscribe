import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AuthorRules, defaultAuthorRules } from '@shared/authorRules'
import type { Channel, Input, Output, VoiceProfile } from '@shared/ipc/contract'
import { computeStylometrics } from '@shared/stylometry'
import { SETTINGS_SAVE_DELAY_MS } from '@renderer/features/editor/settingsStore'
import { flushPendingSaves, resetPendingSaves } from '@renderer/features/project/pendingSaves'
import { useDialogStore } from '@renderer/features/shell/dialogs/dialogStore'
import { setIpcClient, type IpcClient } from '@renderer/lib/ipc'
import { resetAuthorRulesStore, useAuthorRulesStore } from './authorRulesStore'
import { resetVoiceStore, useVoiceStore } from './voiceStore'

interface PendingSet {
  value: AuthorRules
  resolve: () => void
  reject: (err: Error) => void
}

const PROFILE: VoiceProfile = {
  rules: [],
  stats: computeStylometrics(''),
  exemplars: [],
  confidence: 0,
  wordCount: 0,
  authorRules: defaultAuthorRules()
}

/** `authorRules:get` answers with `stored`; `authorRules:set` resolves only when the test says so. */
function deferredClient(stored: AuthorRules): {
  client: IpcClient
  sets: PendingSet[]
  profileCalls: () => number
} {
  const sets: PendingSet[] = []
  let profileCalls = 0
  const client: IpcClient = {
    async invoke<C extends Channel>(channel: C, input: Input<C>): Promise<Output<C>> {
      if (channel === 'authorRules:get') return stored as Output<C>
      if (channel === 'voice:profile') {
        profileCalls++
        return PROFILE as Output<C>
      }
      if (channel === 'authorRules:set') {
        const value = AuthorRules.parse(input)
        return new Promise<Output<C>>((resolve, reject) => {
          sets.push({ value, resolve: () => resolve(value as Output<C>), reject })
        })
      }
      throw new Error(`unexpected ${channel}`)
    },
    on: () => () => {}
  }
  return { client, sets, profileCalls: () => profileCalls }
}

const STORED: AuthorRules = { rules: 'British spelling.', bannedPhrases: ['delve', 'tapestry'] }
let sets: PendingSet[]
let profileCalls: () => number

const store = (): ReturnType<typeof useAuthorRulesStore.getState> => useAuthorRulesStore.getState()
const toasts = (): string[] => useDialogStore.getState().toasts.map((t) => t.message)

async function settle(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0)
}

beforeEach(() => {
  vi.useFakeTimers()
  resetAuthorRulesStore()
  resetVoiceStore()
  resetPendingSaves()
  useDialogStore.setState({ modals: [], toasts: [] })
  const deferred = deferredClient(STORED)
  sets = deferred.sets
  profileCalls = deferred.profileCalls
  setIpcClient(deferred.client)
})
afterEach(() => {
  resetAuthorRulesStore()
  resetVoiceStore()
  vi.useRealTimers()
})

describe('useAuthorRulesStore (F-14.2)', () => {
  it('starts empty and loads the stored rules', async () => {
    expect(store().settings).toBeNull()
    await store().load()
    expect(store().settings).toEqual(STORED)
  })

  it('applies a rules change at once and writes it after the debounce', async () => {
    await store().load()
    store().update({ rules: 'Mira never swears.' })
    expect(store().settings?.rules).toBe('Mira never swears.')
    expect(sets).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(SETTINGS_SAVE_DELAY_MS - 1)
    expect(sets).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(1)
    expect(sets).toHaveLength(1)
    expect(sets[0]?.value).toEqual({ ...STORED, rules: 'Mira never swears.' })
    sets[0]?.resolve()
    await settle()
    expect(store().settings?.rules).toBe('Mira never swears.')
  })

  it('normalises a phrase list through the schema and coalesces rapid updates into one write', async () => {
    await store().load()
    store().update({ bannedPhrases: ['delve', 'tapestry', 'a  testament   to'] })
    await vi.advanceTimersByTimeAsync(SETTINGS_SAVE_DELAY_MS - 50)
    store().update({ bannedPhrases: ['delve', 'tapestry', 'a testament to', 'Delve', ''] })
    expect(sets).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(SETTINGS_SAVE_DELAY_MS)
    expect(sets).toHaveLength(1)
    expect(sets[0]?.value.bannedPhrases).toEqual(['delve', 'tapestry', 'a testament to'])
  })

  it('refreshes the voice profile after a successful write, but only when one is held', async () => {
    await store().load()
    store().update({ rules: 'No rhetorical questions.' })
    await vi.advanceTimersByTimeAsync(SETTINGS_SAVE_DELAY_MS)
    sets[0]?.resolve()
    await settle()
    expect(profileCalls()).toBe(0) // the AI tab was never opened; nothing to refresh
    await useVoiceStore.getState().loadProfile()
    expect(profileCalls()).toBe(1)
    store().update({ rules: 'No rhetorical questions in narration.' })
    await vi.advanceTimersByTimeAsync(SETTINGS_SAVE_DELAY_MS)
    sets[1]?.resolve()
    await settle()
    expect(profileCalls()).toBe(2)
  })

  it('reverts to the value before the failed write and toasts', async () => {
    await store().load()
    store().update({ rules: 'One.' })
    await vi.advanceTimersByTimeAsync(SETTINGS_SAVE_DELAY_MS)
    store().update({ rules: 'Two.' })
    await vi.advanceTimersByTimeAsync(SETTINGS_SAVE_DELAY_MS)
    expect(sets).toHaveLength(2)
    sets[0]?.resolve()
    sets[1]?.reject(new Error('disk full'))
    await settle()
    expect(store().settings?.rules).toBe('One.')
    expect(toasts()).toEqual(['disk full'])
  })

  it('keeps the revert baseline when a newer change is pending while a write fails', async () => {
    await store().load()
    store().update({ rules: 'One.' })
    await vi.advanceTimersByTimeAsync(SETTINGS_SAVE_DELAY_MS)
    expect(sets).toHaveLength(1)
    store().update({ rules: 'Two.' }) // pending while the first write is on the wire
    sets[0]?.reject(new Error('locked'))
    await settle()
    expect(store().settings?.rules).toBe('Two.')
    await vi.advanceTimersByTimeAsync(SETTINGS_SAVE_DELAY_MS)
    expect(sets).toHaveLength(2)
    sets[1]?.reject(new Error('locked again'))
    await settle()
    expect(store().settings).toEqual(STORED)
    expect(toasts()).toEqual(['locked', 'locked again'])
  })

  it('ignores an update before anything is loaded', async () => {
    store().update({ rules: 'Too early.' })
    expect(store().settings).toBeNull()
    await vi.advanceTimersByTimeAsync(SETTINGS_SAVE_DELAY_MS)
    expect(sets).toHaveLength(0)
    await store().load()
    expect(store().settings).toEqual(STORED)
  })

  it('writes a pending change when the pending saves are flushed (project close)', async () => {
    await store().load()
    store().update({ bannedPhrases: [] })
    const flushing = flushPendingSaves()
    await settle()
    expect(sets).toHaveLength(1)
    expect(sets[0]?.value.bannedPhrases).toEqual([])
    sets[0]?.resolve()
    await flushing
    await flushPendingSaves()
    expect(sets).toHaveLength(1)
  })

  it('surfaces a failed flush to the caller', async () => {
    await store().load()
    store().update({ rules: 'One.' })
    const flushing = flushPendingSaves()
    await settle()
    sets[0]?.reject(new Error('read-only'))
    await expect(flushing).rejects.toThrow('read-only')
    expect(store().settings).toEqual(STORED)
  })

  it('clear empties the store and cancels the pending write', async () => {
    await store().load()
    store().update({ rules: 'One.' })
    store().clear()
    expect(store().settings).toBeNull()
    await vi.advanceTimersByTimeAsync(SETTINGS_SAVE_DELAY_MS)
    expect(sets).toHaveLength(0)
    await flushPendingSaves()
    expect(sets).toHaveLength(0)
  })

  it('drops the response of a load superseded by clear', async () => {
    const loading = store().load()
    store().clear()
    await loading
    expect(store().settings).toBeNull()
  })
})
