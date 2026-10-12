import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { defaultAiSettings, type AiSettings } from '@shared/aiSettings'
import type { CloudCapState } from '@shared/memory/cloudCap'
import type { MemoryHealthReport } from '@shared/memory/views'
import { resetAiSettingsStore, useAiSettingsStore } from '@renderer/features/ai/aiSettingsStore'
import { setIpcClient } from '@renderer/lib/ipc'
import { installFakeMain, type FakeMain } from './memoryFixture'
import { MemorySettings } from './MemorySettings'
import { agreementLine, capFromText } from './memoryView'

/**
 * F-16.16, F-16.17, F-16.19 (plan P2a §4): Settings › AI › Story memory in v2: the idle minutes
 * (2–5), on Cloud the monthly cap in quarter-dollar steps and this month's spend, proof agreement,
 * the cut-off rate, and health per model.
 */

const HEALTH: MemoryHealthReport = {
  models: [
    {
      model: 'deepseek-v4-flash',
      judged: true,
      readings: 20,
      items: 140,
      quotes: 0.97,
      verified: 0.92,
      paused: false,
      keepReading: false
    },
    {
      model: 'tiny-local',
      judged: false,
      readings: 3,
      items: 9,
      quotes: 1,
      verified: 1,
      paused: false,
      keepReading: false
    }
  ],
  spot: { fast: { checked: 30, agreed: 29 }, strong: { checked: 20, agreed: 19 } },
  cutRate: 0.02
}
const CAP: CloudCapState = {
  month: '2026-10',
  capUsd: 1,
  extraUsd: 0,
  backgroundUsd: 0.12,
  askedUsd: 0.3,
  limitUsd: 1,
  reached: false
}

let main: FakeMain
let saved: AiSettings[]

function settle(settings: AiSettings): void {
  useAiSettingsStore.setState({ settings })
}

beforeEach(() => {
  resetAiSettingsStore()
  saved = []
  main = installFakeMain({
    'memory:health': () => HEALTH,
    'cloudCap:get': () => CAP,
    'cloudCap:set': (input) => ({ ...CAP, capUsd: (input as { capUsd: number }).capUsd }),
    'aiSettings:set': (input) => {
      saved.push(input as AiSettings)
      return input
    }
  })
})
afterEach(() => {
  resetAiSettingsStore()
  setIpcClient(null)
})

describe('MemorySettings (F-16.16, F-16.19)', () => {
  it('commits the idle minutes clamped to 2–5, and shows agreement, cut-offs and health', async () => {
    settle({ ...defaultAiSettings(), dial: 1 })
    render(<MemorySettings />)
    const field = screen.getByLabelText('Read after a pause of (minutes)')
    expect(field).toHaveValue(3)
    fireEvent.change(field, { target: { value: '9' } })
    fireEvent.blur(field)
    expect(useAiSettingsStore.getState().settings?.reading.idleMinutes).toBe(5)
    const health = await screen.findByTestId('memory-health')
    expect(health).toHaveTextContent('proof agreement: 48 of 50 checked')
    expect(health).toHaveTextContent('Readings cut off at their limit: 2 % of the last 100')
    expect(health).toHaveTextContent(
      'deepseek-v4-flash: 97 % of quotes found, 92 % of checks passed'
    )
    expect(health).toHaveTextContent('tiny-local: not judged yet (3 readings, 9 facts)')
    // Not on Cloud: no cap.
    expect(screen.queryByTestId('cloud-cap')).toBeNull()
    expect(main.sent('cloudCap:get')).toEqual([])
  })

  it('on Cloud, sets the monthly cap in quarter-dollar steps and shows this month', async () => {
    settle({ ...defaultAiSettings(), dial: 1, source: 'cloud' })
    render(<MemorySettings />)
    const cap = await screen.findByLabelText('Monthly Cloud cap for background reading (dollars)')
    expect(screen.getByTestId('cloud-cap')).toHaveTextContent(
      'This month: 12¢ of $1 in the background, 30¢ you asked for'
    )
    fireEvent.change(cap, { target: { value: '1.3' } })
    await act(async () => {
      fireEvent.blur(cap)
    })
    expect(main.sent('cloudCap:set')).toEqual([{ capUsd: 1.25 }])
  })

  it('reads a cap and words the agreement', () => {
    expect(capFromText('$2.10')).toBe(2)
    expect(capFromText('99')).toBe(20)
    expect(capFromText('-1')).toBe(0)
    expect(capFromText('lots')).toBeNull()
    expect(
      agreementLine({
        ...HEALTH,
        spot: { fast: { checked: 0, agreed: 0 }, strong: { checked: 0, agreed: 0 } }
      })
    ).toBeNull()
  })
})
