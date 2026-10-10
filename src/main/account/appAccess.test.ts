import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { TRIAL_ENDED_MESSAGE, trialEndsAt, type AppAccess } from '@shared/appAccess'
import { AppStateStore } from '../appState/appStateStore'
import { AppError } from '../ipc/errors'
import { ACCESS_RECHECK_MS, AppAccessService, DEV_LICENSE_ENV, devLicenseExempt } from './appAccess'

const DAY = 24 * 60 * 60_000

let tmp: string
let appState: AppStateStore
let now: number
let licensed: boolean
let changes: AppAccess[]
let timers: { run: () => void; ms: number }[]

function build(enforced = true): AppAccessService {
  return new AppAccessService({
    appState,
    enforced,
    licensed: () => licensed,
    onChange: (access) => changes.push(access),
    now: () => now,
    schedule: (run, ms) => {
      // Like a real timer, a fired one is gone from the list.
      const timer = {
        run: () => {
          timers = timers.filter((t) => t !== timer)
          run()
        },
        ms
      }
      timers.push(timer)
      return () => {
        timers = timers.filter((t) => t !== timer)
      }
    }
  })
}

function startedAt(): number {
  const trial = appState.get().trial
  if (trial === null) throw new Error('no trial stored')
  return trial.startedAt
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mythscribe-access-'))
  appState = new AppStateStore(path.join(tmp, 'app-state.json'))
  now = new Date(2026, 9, 7, 10).getTime()
  licensed = false
  changes = []
  timers = []
})
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('AppAccessService (AI-BILLING-SPEC M1)', () => {
  it('starts the trial on the first launch and keeps its start on the next', () => {
    const first = build()
    expect(first.status()).toMatchObject({ state: 'trial', daysLeft: 30 })
    expect(appState.get().trial).toEqual({ startedAt: now, lastSeenAt: now })
    first.dispose()
    const started = now
    now += 3 * DAY
    const again = build()
    expect(again.status()).toMatchObject({ state: 'trial', daysLeft: 27 })
    expect(new AppStateStore(path.join(tmp, 'app-state.json')).get().trial).toEqual({
      startedAt: started,
      lastSeenAt: now
    })
  })

  it('turns read-only when the timer reaches the end, and pushes the change once', () => {
    const service = build()
    expect(service.writable()).toBe(true)
    expect(() => service.assertWritable()).not.toThrow()
    // Hourly at most: the first timer is the recheck, not the whole trial.
    expect(timers.map((t) => t.ms)).toEqual([ACCESS_RECHECK_MS])
    now = trialEndsAt(startedAt())
    timers[0]?.run()
    expect(service.status()).toMatchObject({ state: 'expired', daysLeft: 0 })
    expect(changes.map((c) => c.state)).toEqual(['expired'])
    expect(service.writable()).toBe(false)
    let thrown: unknown
    try {
      service.assertWritable()
    } catch (err) {
      thrown = err
    }
    expect(thrown).toBeInstanceOf(AppError)
    expect(thrown).toMatchObject({ code: 'VALIDATION', message: TRIAL_ENDED_MESSAGE })
    // The timer re-armed itself.
    expect(timers).toHaveLength(1)
  })

  it('never turns read-only in a build that cannot verify a license', () => {
    const service = build(false)
    now = trialEndsAt(startedAt()) + 90 * 24 * 60 * 60_000
    service.refresh()
    expect(service.status().state).toBe('licensed')
    expect(service.writable()).toBe(true)
  })

  it('arms the last timer for the exact end of the trial', () => {
    appState.update((s) => ({ ...s, trial: { startedAt: now - 29 * DAY, lastSeenAt: now } }))
    build()
    const end = trialEndsAt(now - 29 * DAY)
    expect(timers.map((t) => t.ms)).toEqual([Math.min(end - now, ACCESS_RECHECK_MS)])
  })

  it('becomes writable again as soon as a license is verified', () => {
    appState.update((s) => ({ ...s, trial: { startedAt: now - 40 * DAY, lastSeenAt: now } }))
    const service = build()
    expect(service.status().state).toBe('expired')
    licensed = true
    expect(service.refresh().state).toBe('licensed')
    expect(changes.map((c) => c.state)).toEqual(['licensed'])
    // Nothing changed: nothing pushed.
    service.refresh()
    expect(changes).toHaveLength(1)
  })

  it('stops its timer on dispose', () => {
    const service = build()
    service.dispose()
    expect(timers).toHaveLength(0)
  })
})

describe('devLicenseExempt (changed by the author 2026-10-10)', () => {
  it('is on only for MYTHSCRIBE_DEV_LICENSE=1', () => {
    expect(devLicenseExempt({ [DEV_LICENSE_ENV]: '1' })).toBe(true)
    expect(devLicenseExempt({ [DEV_LICENSE_ENV]: ' 1\n' })).toBe(true)
    for (const value of [undefined, '', '0', 'true', 'yes', '11']) {
      expect(devLicenseExempt({ [DEV_LICENSE_ENV]: value })).toBe(false)
    }
    expect(devLicenseExempt({})).toBe(false)
  })

  it('keeps the author writable after the trial and without a license', () => {
    const service = build(!devLicenseExempt({ [DEV_LICENSE_ENV]: '1' }))
    now += 400 * DAY
    expect(service.refresh().state).toBe('licensed')
    expect(service.writable()).toBe(true)
    expect(() => service.assertWritable()).not.toThrow()
    service.dispose()
  })
})
