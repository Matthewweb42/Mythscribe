import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  UPDATE_CHECK_DELAY_MS,
  UPDATE_CHECK_INTERVAL_MS,
  UPDATE_ERROR_NEXT_STEP,
  defaultUpdateSettings,
  type ReleaseNotes,
  type UpdateSettings,
  type UpdateState
} from '@shared/updates'
import { AppStateStore } from '../appState/appStateStore'
import { AppError } from '../ipc/errors'
import type { Schedule } from '../schedule'
import {
  UpdateService,
  type AppUpdaterLike,
  type UpdaterEvents,
  type UpdaterLogger,
  type UpdaterUpdateInfo
} from './updateService'

const VERSION = '0.1.0'
const NEXT = '0.2.0'
const NOTES_HTML = '<ul><li>Beta reader</li><li>Faster saves</li></ul>'
const NOTES_TEXT = '- Beta reader\n- Faster saves'

/**
 * The updater the service drives, with the one behaviour that matters for the channel order:
 * assigning `channel` turns `allowDowngrade` on, exactly as `electron-updater` does.
 */
class FakeUpdater implements AppUpdaterLike {
  allowPrerelease = false
  autoDownload = false
  autoInstallOnAppQuit = false
  logger: UpdaterLogger | null = { info: () => {}, warn: () => {}, error: () => {} }
  /** Every property the service wrote, in order. */
  readonly writes: string[] = []
  readonly installs: [boolean, boolean][] = []
  /** What the next `checkForUpdates()` does; a rejection drives the failure path. */
  checkResult: Promise<unknown> = Promise.resolve(null)
  checks = 0

  private handlers: { [E in keyof UpdaterEvents]?: UpdaterEvents[E] } = {}
  private channelValue: string | null = null
  private allowDowngradeValue = false

  get channel(): string | null {
    return this.channelValue
  }
  set channel(value: string | null) {
    this.writes.push(`channel=${String(value)}`)
    this.channelValue = value
    // electron-updater turns downgrades on with every channel change; the service turns it off.
    this.allowDowngradeValue = true
  }

  get allowDowngrade(): boolean {
    return this.allowDowngradeValue
  }
  set allowDowngrade(value: boolean) {
    this.writes.push(`allowDowngrade=${String(value)}`)
    this.allowDowngradeValue = value
  }

  on<E extends keyof UpdaterEvents>(event: E, listener: UpdaterEvents[E]): this {
    this.handlers[event] = listener
    return this
  }

  checkForUpdates(): Promise<unknown> {
    this.checks += 1
    return this.checkResult
  }

  quitAndInstall(isSilent: boolean, isForceRunAfter: boolean): void {
    this.installs.push([isSilent, isForceRunAfter])
  }

  checking(): void {
    this.handlers['checking-for-update']?.()
  }
  available(version: string): void {
    this.handlers['update-available']?.({ version })
  }
  notAvailable(): void {
    this.handlers['update-not-available']?.({ version: VERSION })
  }
  progress(percent: number): void {
    this.handlers['download-progress']?.({ percent })
  }
  downloaded(info: UpdaterUpdateInfo): void {
    this.handlers['update-downloaded']?.(info)
  }
  failed(error: Error): void {
    this.handlers.error?.(error)
  }
}

let tmp: string
let file: string
let appState: AppStateStore
let updater: FakeUpdater
let changes: UpdateState[]
let clock: number
/** The timers the service armed and has not cancelled; `tick()` runs the newest one. */
let timers: { run: () => void; ms: number; cancelled: boolean }[]

const schedule: Schedule = (run, ms) => {
  const timer = { run, ms, cancelled: false }
  timers.push(timer)
  return () => {
    timer.cancelled = true
  }
}

const armed = (): { run: () => void; ms: number; cancelled: boolean } | undefined =>
  timers.filter((t) => !t.cancelled).at(-1)

/** Runs the timer that is waiting, then lets the check it started settle. */
const tick = async (): Promise<void> => {
  const timer = armed()
  if (timer === undefined) throw new Error('No timer is armed')
  timer.cancelled = true
  timer.run()
  await new Promise<void>((resolve) => setImmediate(resolve))
}

const stored = (): UpdateSettings => new AppStateStore(file).get().updates

function build(
  options: { updater?: FakeUpdater | null; currentVersion?: string } = {}
): UpdateService {
  const fake = options.updater === undefined ? updater : options.updater
  return new UpdateService({
    updater: fake,
    unsupportedReason: fake === null ? 'This is a development build.' : null,
    appState,
    currentVersion: options.currentVersion ?? VERSION,
    onChange: (state) => changes.push(state),
    now: () => clock,
    schedule
  })
}

/** Writes the stored update settings as an earlier run would have left them. */
function seed(settings: Partial<UpdateSettings>): void {
  appState.update((state) => ({
    ...state,
    updates: { ...defaultUpdateSettings(), ...settings }
  }))
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mythscribe-updates-'))
  file = path.join(tmp, 'userData', 'app-state.json')
  appState = new AppStateStore(file)
  updater = new FakeUpdater()
  changes = []
  clock = Date.parse('2026-09-21T10:00:00.000Z')
  timers = []
})
afterEach(() => {
  vi.restoreAllMocks()
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('UpdateService (F-15.7)', () => {
  it('starts idle on the stable channel and configures the updater', () => {
    const service = build()
    expect(service.state()).toEqual({
      currentVersion: VERSION,
      channel: 'stable',
      autoCheck: true,
      status: { state: 'idle' },
      installedNotes: null,
      unseenNotes: false
    })
    expect(updater.channel).toBe('latest')
    expect(updater.allowPrerelease).toBe(false)
    expect(updater.autoDownload).toBe(true)
    expect(updater.autoInstallOnAppQuit).toBe(true)
    expect(updater.logger).toBeNull()
    expect(changes).toEqual([])
  })

  it('turns downgrades off after setting the channel, which turns them on', () => {
    build()
    expect(updater.writes).toEqual(['channel=latest', 'allowDowngrade=false'])
    expect(updater.allowDowngrade).toBe(false)
  })

  it('follows the stored channel, asking for the beta feed and allowing prereleases', () => {
    seed({ channel: 'beta' })
    const service = build()
    expect(updater.channel).toBe('beta')
    expect(updater.allowPrerelease).toBe(true)
    expect(updater.allowDowngrade).toBe(false)
    expect(service.state().channel).toBe('beta')
  })

  it('reports a build that cannot update itself and refuses to act', async () => {
    const service = build({ updater: null })
    expect(service.state().status).toEqual({
      state: 'unsupported',
      reason: 'This is a development build.'
    })
    expect(await service.check()).toEqual(service.state())
    expect(service.state().status.state).toBe('unsupported')
    expect(() => service.install()).toThrowError(AppError)
    service.start()
    expect(timers).toEqual([])
    expect(changes).toEqual([])
  })

  it('walks checking → downloading → ready, pushing each step once', async () => {
    const service = build()
    const check = service.check()
    updater.checking()
    updater.available(NEXT)
    updater.progress(12.4)
    updater.progress(12.6)
    updater.progress(80)
    updater.downloaded({ version: NEXT, releaseDate: 'd', releaseNotes: NOTES_HTML })
    await check
    expect(changes.map((c) => c.status)).toEqual([
      { state: 'checking' },
      { state: 'downloading', version: NEXT, percent: 0 },
      { state: 'downloading', version: NEXT, percent: 12 },
      { state: 'downloading', version: NEXT, percent: 13 },
      { state: 'downloading', version: NEXT, percent: 80 },
      { state: 'ready', version: NEXT, notes: { version: NEXT, date: 'd', text: NOTES_TEXT } }
    ])
    expect(service.state().status).toEqual({
      state: 'ready',
      version: NEXT,
      notes: { version: NEXT, date: 'd', text: NOTES_TEXT }
    })
  })

  it('stores the downloaded notes so the next run can show what is new', async () => {
    const service = build()
    await service.check()
    updater.downloaded({ version: NEXT, releaseNotes: NOTES_HTML })
    const notes: ReleaseNotes = { version: NEXT, date: null, text: NOTES_TEXT }
    expect(stored().installedNotes).toEqual(notes)
    // They belong to the pending version, not this one, so nothing is "new" yet.
    expect(service.state().unseenNotes).toBe(false)
    expect(service.state().installedNotes).toEqual(notes)
  })

  it('never overwrites the running version’s notes with its own re-download', async () => {
    const notes: ReleaseNotes = { version: VERSION, date: null, text: 'Already installed' }
    seed({ installedNotes: notes, lastSeenVersion: VERSION })
    const service = build()
    await service.check()
    updater.downloaded({ version: VERSION, releaseNotes: '<p>Downloaded again</p>' })
    expect(stored().installedNotes).toEqual(notes)
    expect(service.state().status).toMatchObject({ state: 'ready', version: VERSION })
  })

  it('answers "up to date" with the time of the check', async () => {
    const service = build()
    const check = service.check()
    updater.notAvailable()
    await check
    expect(service.state().status).toEqual({
      state: 'upToDate',
      checkedAt: '2026-09-21T10:00:00.000Z'
    })
  })

  it('turns a refused check into the error status instead of an unhandled rejection', async () => {
    updater.checkResult = Promise.reject(new Error('getaddrinfo ENOTFOUND github.com'))
    const service = build()
    expect((await service.check()).status).toEqual({
      state: 'error',
      message: 'getaddrinfo ENOTFOUND github.com',
      nextStep: UPDATE_ERROR_NEXT_STEP
    })
  })

  it('turns a failure reported by the updater into the same error status', async () => {
    const service = build()
    await service.check()
    updater.failed(new Error('Cannot find beta.yml in the latest release artifacts'))
    expect(service.state().status).toEqual({
      state: 'error',
      message: 'Cannot find beta.yml in the latest release artifacts',
      nextStep: UPDATE_ERROR_NEXT_STEP
    })
  })

  it('does not start a second check while one is running or a download is in flight', async () => {
    const service = build()
    const first = service.check()
    await service.check()
    expect(updater.checks).toBe(1)
    await first
    updater.available(NEXT)
    await service.check()
    expect(updater.checks).toBe(1)
    expect(service.state().status.state).toBe('downloading')
  })

  it('keeps a downloaded update ready instead of asking the feed again', async () => {
    const service = build()
    await service.check()
    updater.downloaded({ version: NEXT, releaseNotes: '<p>Faster search.</p>' })
    // Offline by now: a second request would fail, and must not be made at all.
    expect((await service.check()).status.state).toBe('ready')
    expect(updater.checks).toBe(1)
  })

  it('shows only the first line of an updater error, capped', async () => {
    updater.checkResult = Promise.reject(
      new Error(
        `HttpError: 404 ${'x'.repeat(400)}\nHeaders: {"server": "GitHub.com"}\n    at stack`
      )
    )
    const status = (await build().check()).status
    if (status.state !== 'error') throw new Error('Expected the error status')
    expect(status.message).toHaveLength(300)
    expect(status.message.startsWith('HttpError: 404 x')).toBe(true)
    expect(status.message).not.toContain('Headers')
  })

  it('persists a channel change, applies it, and looks again straight away', async () => {
    const service = build()
    updater.writes.length = 0
    const state = await service.setChannel('beta')
    expect(stored().channel).toBe('beta')
    expect(updater.writes).toEqual(['channel=beta', 'allowDowngrade=false'])
    expect(updater.allowPrerelease).toBe(true)
    expect(updater.checks).toBe(1)
    expect(state.channel).toBe('beta')
    expect(changes[0]?.channel).toBe('beta')
  })

  it('shows the running version’s notes once, until they are marked seen', () => {
    seed({ installedNotes: { version: VERSION, date: null, text: NOTES_TEXT } })
    const service = build()
    expect(service.state().unseenNotes).toBe(true)
    const state = service.markSeen()
    expect(state.unseenNotes).toBe(false)
    expect(stored().lastSeenVersion).toBe(VERSION)
    expect(changes).toHaveLength(1)
    // A second run of the same version has nothing new to say.
    expect(build().state().unseenNotes).toBe(false)
  })

  it('installs only from ready, silently, with a restart after', async () => {
    const service = build()
    expect(() => service.install()).toThrowError(/No update is ready/)
    await service.check()
    updater.available(NEXT)
    expect(() => service.install()).toThrowError(AppError)
    updater.downloaded({ version: NEXT, releaseNotes: null })
    service.install()
    expect(updater.installs).toEqual([[false, true]])
  })

  it('checks shortly after start and then on the interval', async () => {
    const service = build()
    service.start()
    expect(armed()?.ms).toBe(UPDATE_CHECK_DELAY_MS)
    await tick()
    expect(updater.checks).toBe(1)
    expect(armed()?.ms).toBe(UPDATE_CHECK_INTERVAL_MS)
    await tick()
    expect(updater.checks).toBe(2)
    service.dispose()
    expect(armed()).toBeUndefined()
  })

  it('arms nothing while the automatic check is off, and the manual one still works', async () => {
    seed({ autoCheck: false })
    const service = build()
    service.start()
    expect(timers).toEqual([])
    await service.check()
    expect(updater.checks).toBe(1)

    // Turning it on from the tab starts the cycle; turning it off drops the pending timer.
    expect(service.setAutoCheck(true).autoCheck).toBe(true)
    expect(stored().autoCheck).toBe(true)
    expect(armed()?.ms).toBe(UPDATE_CHECK_DELAY_MS)
    service.setAutoCheck(false)
    expect(armed()).toBeUndefined()
    expect(stored().autoCheck).toBe(false)
    // Setting it to what it already is changes nothing and pushes nothing.
    const before = changes.length
    service.setAutoCheck(false)
    expect(changes).toHaveLength(before)
  })
})
