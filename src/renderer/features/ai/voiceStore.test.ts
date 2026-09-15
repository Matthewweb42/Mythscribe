import { beforeEach, describe, expect, it } from 'vitest'
import type {
  Channel,
  Input,
  Output,
  VoiceConsistencyReport,
  VoiceExemplar,
  VoiceProfile
} from '@shared/ipc/contract'
import { computeStylometrics } from '@shared/stylometry'
import { setIpcClient, type IpcClient } from '@renderer/lib/ipc'
import { resetVoiceStore, useVoiceStore } from './voiceStore'

const exemplar = (id: string, text = `Passage ${id}`): VoiceExemplar => ({
  id,
  nodeId: 'scene-1',
  text,
  pov: null,
  kind: 'mixed',
  created: '2026-09-14T08:00:00.000Z'
})

const profileOf = (exemplars: VoiceExemplar[]): VoiceProfile => ({
  rules: ['Narration is in past tense.'],
  stats: computeStylometrics(''),
  exemplars,
  confidence: 0.2,
  wordCount: 2_000
})

const REPORT: VoiceConsistencyReport = {
  profileWordCount: 2_000,
  documents: [{ id: 'scene-1', title: 'Scene 1', wordCount: 2_000, status: 'ok', violations: [] }]
}

interface Fake {
  client: IpcClient
  calls: { channel: Channel; input: unknown }[]
  exemplars: VoiceExemplar[]
  /** Resolves every pending `voice:listExemplars`; the answer is held until called. */
  releaseList: () => void
}

function fakeClient(initial: VoiceExemplar[]): Fake {
  const calls: Fake['calls'] = []
  let pending: (() => void)[] = []
  const fake: Fake = {
    calls,
    exemplars: initial,
    releaseList: () => {
      const release = pending
      pending = []
      for (const fn of release) fn()
    },
    client: {
      async invoke<C extends Channel>(channel: C, input: Input<C>): Promise<Output<C>> {
        calls.push({ channel, input })
        switch (channel) {
          case 'voice:listExemplars':
            await new Promise<void>((resolve) => pending.push(resolve))
            return fake.exemplars as Output<C>
          case 'voice:profile':
            return profileOf(fake.exemplars) as Output<C>
          case 'voice:consistencyReport':
            await new Promise<void>((resolve) => pending.push(resolve))
            return REPORT as Output<C>
          case 'voice:addExemplar': {
            const { text } = input as Input<'voice:addExemplar'>
            const added = exemplar(`e${fake.exemplars.length + 1}`, text)
            fake.exemplars = [...fake.exemplars, added]
            return added as Output<C>
          }
          case 'voice:removeExemplar':
            fake.exemplars = fake.exemplars.filter(
              (e) => e.id !== (input as Input<'voice:removeExemplar'>).id
            )
            return null as Output<C>
          default:
            throw new Error(`unexpected ${channel}`)
        }
      },
      on: () => () => {}
    }
  }
  return fake
}

let fake: Fake
const store = (): ReturnType<typeof useVoiceStore.getState> => useVoiceStore.getState()

beforeEach(() => {
  resetVoiceStore()
  fake = fakeClient([exemplar('e1')])
  setIpcClient(fake.client)
})

describe('voiceStore (F-14.1)', () => {
  it('starts empty, loads the exemplars, and loads the profile separately', async () => {
    expect(store().exemplars).toBeNull()
    expect(store().profile).toBeNull()
    const load = store().load()
    fake.releaseList()
    await load
    expect(store().exemplars).toEqual([exemplar('e1')])
    expect(store().profile).toBeNull()
    await store().loadProfile()
    expect(store().profile).toEqual(profileOf([exemplar('e1')]))
  })

  it('add merges the answer without re-listing and refreshes a held profile', async () => {
    const load = store().load()
    fake.releaseList()
    await load
    const added = await store().add('scene-1', 'A passage long enough to mark.')
    expect(added.text).toBe('A passage long enough to mark.')
    expect(store().exemplars).toEqual([exemplar('e1'), added])
    expect(fake.calls.map((c) => c.channel)).toEqual(['voice:listExemplars', 'voice:addExemplar'])
    await store().loadProfile()
    await store().add('scene-1', 'Another passage long enough to mark.')
    expect(fake.calls.map((c) => c.channel).slice(-2)).toEqual([
      'voice:addExemplar',
      'voice:profile'
    ])
    await Promise.resolve()
    expect(store().profile?.exemplars).toHaveLength(3)
  })

  it('remove drops the row locally and refreshes a held profile', async () => {
    const load = store().load()
    fake.releaseList()
    await load
    await store().loadProfile()
    await store().remove('e1')
    expect(store().exemplars).toEqual([])
    expect(fake.calls.map((c) => c.channel).slice(-2)).toEqual([
      'voice:removeExemplar',
      'voice:profile'
    ])
  })

  it('lets a refused write propagate and changes nothing', async () => {
    fake.client.invoke = () => Promise.reject(new Error('nope'))
    await expect(store().add('scene-1', 'x')).rejects.toThrow('nope')
    await expect(store().remove('e1')).rejects.toThrow('nope')
    expect(store().exemplars).toBeNull()
  })

  it('loads the consistency report on demand and drops it with clear (F-14.7)', async () => {
    expect(store().report).toBeNull()
    const loading = store().loadReport()
    fake.releaseList()
    await loading
    expect(store().report).toEqual(REPORT)
    expect(fake.calls).toEqual([{ channel: 'voice:consistencyReport', input: {} }])
    const late = store().loadReport()
    store().clear()
    expect(store().report).toBeNull()
    fake.releaseList()
    await late
    expect(store().report).toBeNull()
  })

  it('clear empties the store and drops a response that arrives afterwards', async () => {
    const load = store().load()
    store().clear()
    fake.releaseList()
    await load
    expect(store().exemplars).toBeNull()
    const later = store().load()
    fake.releaseList()
    await later
    expect(store().exemplars).toEqual([exemplar('e1')])
    store().clear()
    expect(store().exemplars).toBeNull()
    expect(store().profile).toBeNull()
  })
})
