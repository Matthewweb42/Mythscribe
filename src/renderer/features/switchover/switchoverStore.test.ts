import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { defaultAiSettings } from '@shared/aiSettings'
import type { Channel, Input, Output, ProjectInfo } from '@shared/ipc/contract'
import type { RebuildEstimate, SwitchoverPlan } from '@shared/memory/switchover'
import type { RebuildStartResult } from '@shared/memory/views'
import { resetMemoryStore, useMemoryStore } from '@renderer/features/memory/memoryStore'
import { resetCloudSyncStore } from '@renderer/features/project/cloudSyncStore'
import { resetPendingSaves } from '@renderer/features/project/pendingSaves'
import { useProjectStore } from '@renderer/features/project/projectStore'
import { useDialogStore } from '@renderer/features/shell/dialogs/dialogStore'
import { setIpcClient, type IpcClient } from '@renderer/lib/ipc'
import { resetSwitchoverStore, useSwitchoverStore, type SwitchoverPhase } from './switchoverStore'

const PROJECT: ProjectInfo = {
  id: 'real',
  name: 'Book',
  format: 'novel',
  path: '/books/Book.mythscribe',
  created: 'c',
  modified: 'm',
  lastOpened: 'l',
  schemaVersion: 40,
  storyMemory: 'v1'
}
const COPY_PATH = '/books/Book (story memory test 2026-10-14 1000).mythscribe'
const BACKUP = '/backups/Book before story memory 2026-10-14 100000.zip'
const DATED = '/books/Book (before story memory 2026-10-14 1000).mythscribe'

const PLAN: SwitchoverPlan = {
  kept: [],
  converted: [],
  dropped: [],
  merges: [],
  filedByAi: [],
  notes: [],
  inlineTags: 0,
  rebuild: {
    scenes: 0,
    requests: 0,
    tokensIn: 0,
    tokensOut: 0,
    costUsd: 0,
    priced: true,
    source: 'ownKey',
    fastModel: 'f',
    strongModel: 's',
    minutes: 0
  }
}

/** The switched project's rebuild price. */
const ESTIMATE: RebuildEstimate = { ...PLAN.rebuild, scenes: 4, costUsd: 0.01, minutes: 1 }

let calls: { channel: Channel; input: unknown }[]
/** What `memory:rebuild` answers. */
let started: RebuildStartResult
/** Answers held until the test releases them, by channel. */
let held: Partial<Record<Channel, Promise<void>>>
/** Channels that throw. */
let failing: Partial<Record<Channel, Error>>

/** A held channel and the function that lets it answer. */
function hold(channel: Channel): () => void {
  let release = (): void => {}
  held[channel] = new Promise((resolve) => {
    release = resolve
  })
  return release
}

const phases: SwitchoverPhase[] = []
let unsubscribe: () => void = () => {}

beforeEach(() => {
  resetSwitchoverStore()
  resetPendingSaves()
  resetCloudSyncStore()
  useDialogStore.setState({ modals: [], toasts: [] })
  useProjectStore.setState({ current: PROJECT, busy: false })
  calls = []
  held = {}
  failing = {}
  started = { ok: true, queued: 4, estimate: ESTIMATE }
  resetMemoryStore()
  phases.length = 0
  unsubscribe = useSwitchoverStore.subscribe((state, before) => {
    if (state.phase !== before.phase) phases.push(state.phase)
  })
  const client: IpcClient = {
    async invoke<C extends Channel>(channel: C, input: Input<C>): Promise<Output<C>> {
      calls.push({ channel, input })
      const wait = held[channel]
      if (wait !== undefined) await wait
      const error: Error | undefined = failing[channel]
      if (error !== undefined) throw error
      switch (channel) {
        case 'switchover:trial':
          return null as Output<C>
        case 'switchover:trialCopy':
          return {
            folder: COPY_PATH,
            info: { ...PROJECT, id: 'copy', path: COPY_PATH }
          } as Output<C>
        case 'switchover:safety':
          return { ok: true, backup: BACKUP, datedCopy: DATED } as Output<C>
        case 'switchover:plan':
          return PLAN as Output<C>
        case 'switchover:consent':
          return [] as Output<C>
        case 'switchover:convert':
          return {
            ok: true,
            folder: PROJECT.path,
            trial: false,
            backup: BACKUP,
            datedCopy: DATED,
            counts: {
              records: 0,
              labels: 0,
              research: 0,
              scenesWithDetails: 0,
              dismissals: 0,
              merged: 0,
              tokens: 0,
              documents: 0
            }
          } as Output<C>
        case 'project:open':
          return { ...PROJECT, storyMemory: 'v2' } as Output<C>
        case 'project:cloudSyncNow':
          return null as Output<C>
        case 'switchover:leave':
          return null as Output<C>
        case 'recovery:list':
          return [] as Output<C>
        case 'memory:status':
          return {
            lastRead: null,
            paused: null,
            todayUsd: 0,
            cloud: null,
            rebuild: null,
            check: null
          } as Output<C>
        case 'aiSettings:get':
          return { ...defaultAiSettings(), dial: 1 } as Output<C>
        case 'memory:rebuildEstimate':
          return ESTIMATE as Output<C>
        case 'memory:rebuild':
          return started as Output<C>
        case 'memory:notices':
          return [] as Output<C>
        case 'memory:cardLines':
          return {} as Output<C>
        default:
          throw new Error(`unexpected ${channel}`)
      }
    },
    on: () => () => {}
  }
  setIpcClient(client)
})

afterEach(() => {
  unsubscribe()
  resetMemoryStore()
  // A switched project left open would run the next file's stores on the new memory.
  useProjectStore.setState({ current: null, busy: false })
  resetSwitchoverStore()
  resetCloudSyncStore()
  setIpcClient(null)
})

const store = useSwitchoverStore.getState
const channels = (): Channel[] => calls.map((call) => call.channel)
const toasts = (): string[] => useDialogStore.getState().toasts.map((t) => t.message)

/** The flow on the project itself, up to the consent screen. */
async function toConsent(): Promise<void> {
  await store().open()
  await store().switchThis()
  await store().toConsent()
}

describe('switchoverStore (F-16.31 part A)', () => {
  it('goes intro → safety → plan → consent → converting → done on the project itself', async () => {
    await toConsent()
    await store().convert()
    expect(phases).toEqual(['intro', 'safety', 'plan', 'consent', 'converting', 'done'])
    expect(store().target).toBe('project')
    expect(store().source).toBe(PROJECT.path)
    expect(store().safety).toEqual({ backup: BACKUP, datedCopy: DATED })
    expect(channels()).toEqual([
      'switchover:trial',
      'switchover:safety',
      'switchover:plan',
      'switchover:consent',
      'switchover:convert',
      'project:cloudSyncNow',
      'project:open',
      'recovery:list',
      // Switch-over slice 4: the rebuild ask, read once the project is open on v2.
      'memory:status',
      'aiSettings:get',
      'memory:rebuildEstimate'
    ])
    expect(store().ask).toEqual({
      kind: 'offer',
      estimate: ESTIMATE,
      starting: false,
      refused: null
    })
  })

  it('goes intro → copying → plan for a copy first, with no safety step', async () => {
    await store().open()
    await store().tryCopy()
    expect(phases).toEqual(['intro', 'copying', 'plan'])
    expect(store().target).toBe('copy')
    expect(store().copy).toBe(COPY_PATH)
    // The original stays the author's project, which the copy's final screen names.
    expect(store().source).toBe(PROJECT.path)
    expect(channels()).not.toContain('switchover:safety')
  })

  it('sends the id of the project the flow is for with the consent, and refuses with no project open', async () => {
    await toConsent()
    useProjectStore.setState({ current: null })
    await store().convert()
    expect(store().error).toBe('No project is open.')
    expect(channels()).not.toContain('switchover:convert')
    // Another project opened under the dialog (Settings › Backups › Restore, say): Convert still
    // names the one the dry run and the consent were for, so main refuses it as the project step.
    useProjectStore.setState({
      current: { ...PROJECT, id: 'restored', path: '/books/Old.mythscribe' }
    })
    await store().convert()
    expect(calls.find((call) => call.channel === 'switchover:convert')?.input).toEqual({
      consent: { replacements: [], merges: [] },
      projectId: 'real'
    })
  })

  it('names the test copy once the flow has made it', async () => {
    await store().open()
    expect(store().projectId).toBe('real')
    await store().tryCopy()
    expect(store().projectId).toBe('copy')
    expect(store().madeCopy).toBe(true)
  })

  it('drops the safety answer of a flow the author left', async () => {
    await store().open()
    const release = hold('switchover:safety')
    const running = store().switchThis()
    await Promise.resolve()
    store().close()
    release()
    await running
    expect(store().phase).toBe('idle')
    expect(store().safety).toBeNull()
    expect(channels()).not.toContain('switchover:plan')
    // Closed during the safety step: the toast is the cancel after it, never this.
    expect(toasts()).toEqual([])
  })

  it('drops the trial answer of an intro the author left, and a conversion answer too', async () => {
    const releaseTrial = hold('switchover:trial')
    const opening = store().open()
    store().close()
    releaseTrial()
    await opening
    expect(store().phase).toBe('idle')
    expect(store().target).toBeNull()

    delete held['switchover:trial']
    await toConsent()
    const releaseConvert = hold('switchover:convert')
    const converting = store().convert()
    await new Promise((resolve) => setTimeout(resolve, 0))
    store().close()
    releaseConvert()
    await converting
    expect(store().phase).toBe('idle')
    expect(store().result).toBeNull()
    expect(channels()).not.toContain('project:open')
  })

  it('keeps a failed copy on the intro, and a dry run that fails in the copy offers the copy', async () => {
    failing['switchover:trialCopy'] = new Error('The disk is full.')
    await store().open()
    await store().tryCopy()
    expect(store().phase).toBe('intro')
    expect(store().target).toBe('project')
    expect(store().error).toBe('The disk is full.')

    delete failing['switchover:trialCopy']
    failing['switchover:plan'] = new Error('The copy could not be read.')
    await store().tryCopy()
    expect(store().phase).toBe('intro')
    expect(store().target).toBe('copy')
    expect(store().copy).toBe(COPY_PATH)
    // Try again from the copy reads its dry run, with no safety step.
    delete failing['switchover:plan']
    await store().switchThis()
    expect(store().phase).toBe('plan')
    expect(channels()).not.toContain('switchover:safety')
  })

  it('runs the failed step again: the safety step from the intro, the conversion from consent', async () => {
    await store().open()
    await store().retry()
    expect(store().phase).toBe('plan')
    expect(channels().filter((c) => c === 'switchover:safety')).toHaveLength(1)
    await store().toConsent()
    await store().retry()
    expect(store().phase).toBe('done')
    expect(channels().filter((c) => c === 'switchover:convert')).toHaveLength(1)
  })

  it('toasts that nothing changed, with both paths, only when the author leaves after the safety step', async () => {
    await store().open()
    store().close()
    expect(toasts()).toEqual([])

    await store().open()
    await store().switchThis()
    store().close()
    expect(toasts()).toEqual([
      `Nothing was changed. The backup and the dated copy made a moment ago stay where they are: ${BACKUP} · ${DATED}`
    ])

    // Leaving lets main's held v1 jobs go.
    expect(channels().filter((c) => c === 'switchover:leave')).toHaveLength(2)
  })

  it('opens the author’s project again when she leaves the copy the flow made, from any screen before the end', async () => {
    for (const leaveAt of ['plan', 'consent', 'intro'] as const) {
      calls = []
      useProjectStore.setState({ current: PROJECT })
      useDialogStore.setState({ toasts: [] })
      if (leaveAt === 'intro') failing['switchover:plan'] = new Error('The copy could not be read.')
      await store().open()
      await store().tryCopy()
      if (leaveAt === 'consent') await store().toConsent()
      expect(store().phase).toBe(leaveAt)
      expect(useProjectStore.getState().current?.id).toBe('copy')
      store().close()
      await new Promise((resolve) => setTimeout(resolve, 0))
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(calls).toContainEqual({ channel: 'project:open', input: { path: PROJECT.path } })
      expect(toasts()).toEqual([
        `Your project is open again and unchanged. The test copy was not switched. It stays at ${COPY_PATH}.`
      ])
      // A copy flow holds nothing in main.
      expect(channels()).not.toContain('switchover:leave')
      delete failing['switchover:plan']
    }
  })

  it('opens the project the copy was made from on Open my project', async () => {
    await store().open()
    await store().tryCopy()
    await store().openMyProject()
    expect(store().phase).toBe('idle')
    expect(calls.at(-2)).toEqual({ channel: 'project:open', input: { path: PROJECT.path } })
  })

  it('asks for the rebuild once the project is open, and Rebuild now opens the rebuild dialog (slice 4)', async () => {
    await toConsent()
    await store().convert()
    await store().rebuildNow()
    expect(store().phase).toBe('idle')
    expect(channels().filter((c) => c === 'memory:rebuild')).toHaveLength(1)
    // The status is read before the rebuild dialog opens on its progress.
    expect(channels().slice(-3)).toEqual(['memory:status', 'memory:notices', 'memory:cardLines'])
    expect(useMemoryStore.getState().rebuildOpen).toBe('summary')
    // Leaving the project's flow lets main's held v1 jobs go, as any close does.
    expect(channels()).toContain('switchover:leave')
  })

  it('keeps the screen with main’s reason when the rebuild will not start, and starts only what is offered', async () => {
    started = {
      ok: false,
      code: 'NO_KEY',
      message: 'Story memory needs an AI provider to rebuild.',
      nextStep: 'Add a key in Settings › AI.'
    }
    await toConsent()
    await store().convert()
    await store().rebuildNow()
    expect(store().phase).toBe('done')
    expect(store().ask).toEqual({
      kind: 'offer',
      estimate: ESTIMATE,
      starting: false,
      refused: 'Story memory needs an AI provider to rebuild. Add a key in Settings › AI.'
    })
    expect(useMemoryStore.getState().rebuildOpen).toBeNull()
    // A start that throws says why the same way.
    failing['memory:rebuild'] = new Error('The project is busy.')
    await store().rebuildNow()
    expect(store().ask).toMatchObject({ kind: 'offer', refused: 'The project is busy.' })
    // Nothing offered (a held ask): Rebuild now does nothing.
    store().close()
    useSwitchoverStore.setState({ phase: 'done', ask: { kind: 'aiOff' } })
    const before = calls.length
    await store().rebuildNow()
    expect(calls).toHaveLength(before)
  })

  it('drops the ask of a final screen the author closed, and a start answer too', async () => {
    await toConsent()
    const releaseStatus = hold('memory:status')
    const converting = store().convert()
    await new Promise((resolve) => setTimeout(resolve, 0))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(store().ask).toEqual({ kind: 'reading' })
    store().close()
    releaseStatus()
    await converting
    expect(store().ask).toBeNull()
    expect(channels()).not.toContain('memory:rebuildEstimate')

    delete held['memory:status']
    await toConsent()
    await store().convert()
    const releaseStart = hold('memory:rebuild')
    const starting = store().rebuildNow()
    expect(store().ask).toMatchObject({ kind: 'offer', starting: true })
    store().close()
    releaseStart()
    await starting
    expect(store().phase).toBe('idle')
    expect(useMemoryStore.getState().rebuildOpen).toBeNull()
  })
})
