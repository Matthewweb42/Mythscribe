import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { defaultAiSettings, type AiSettings } from '@shared/aiSettings'
import type { CloudCapState } from '@shared/memory/cloudCap'
import type { SwitchoverRecord } from '@shared/memory/switchover'
import type { MemoryHealthReport } from '@shared/memory/views'
import { resetAiSettingsStore, useAiSettingsStore } from '@renderer/features/ai/aiSettingsStore'
import {
  resetShellDialogStore,
  useShellDialogStore
} from '@renderer/features/shell/shellDialogStore'
import { goBackLine } from '@renderer/features/switchover/switchoverText'
import { setIpcClient } from '@renderer/lib/ipc'
import { installFakeMain, type FakeMain } from './memoryFixture'
import { resetMemoryStore, useMemoryStore } from './memoryStore'
import { MemorySettings } from './MemorySettings'
import { agreementLine, capFromText, contradictionStatsLine } from './memoryView'

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
  cutRate: 0.02,
  contradictions: { pairs: 40, agreed: 37, underlines: { counted: 20, right: 14 } }
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

const BACKUP = '/backups/Book before story memory 2026-10-14 120000.zip'
const DATED = '/My Drive/Book (before story memory 2026-10-14 1200).mythscribe'
/** The switch-over record of the project itself, waiting for its first rebuild. */
const SWITCHED: SwitchoverRecord = {
  switchedAt: '2026-10-14T12:00:00.000Z',
  trial: false,
  source: null,
  backup: BACKUP,
  datedCopy: DATED,
  rebuild: 'waiting',
  rebuildStartedAt: null
}

let main: FakeMain
let saved: AiSettings[]
/** What `switchover:record` answers: none for a project made v2 another way. */
let record: SwitchoverRecord | null

function settle(settings: AiSettings): void {
  useAiSettingsStore.setState({ settings })
}

beforeEach(() => {
  resetAiSettingsStore()
  resetMemoryStore()
  saved = []
  record = null
  main = installFakeMain({
    'switchover:record': () => record,
    'memory:health': () => HEALTH,
    'scribe:searchMisses': () => ({ count: 0, recent: [] }),
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
  resetMemoryStore()
  resetShellDialogStore()
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
    // F-16.25: Details holds Ms Scribe's search misses.
    expect(await screen.findByTestId('search-misses-count')).toHaveTextContent('Search misses: 0')
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

  it('switches contradictions between underlined and the panel only, and shows judge agreement and underline precision (F-16.28)', async () => {
    settle({ ...defaultAiSettings(), dial: 1 })
    render(<MemorySettings />)
    const underlined = screen.getByRole('radio', { name: 'underlined in the text' })
    const panel = screen.getByRole('radio', { name: 'in the panel only' })
    expect(underlined).toBeChecked()
    fireEvent.click(panel)
    expect(useAiSettingsStore.getState().settings?.reading).toEqual({
      idleMinutes: 3,
      underlines: 'panel'
    })
    expect(panel).toBeChecked()
    expect(await screen.findByTestId('contradiction-stats')).toHaveTextContent(
      'Contradiction check: 40 pairs judged both ways; the two orders agreed on 37 · underlines: 14 of the last 20 were right'
    )
  })

  it('words the contradiction details before anything was judged or underlined', () => {
    expect(
      contradictionStatsLine({
        ...HEALTH,
        contradictions: { pairs: 0, agreed: 0, underlines: { counted: 0, right: 0 } }
      })
    ).toBe(
      'Contradiction check: no pairs judged both ways yet · underlines: no underlined contradiction closed yet'
    )
    expect(
      contradictionStatsLine({
        ...HEALTH,
        contradictions: { pairs: 1, agreed: 1, underlines: { counted: 1, right: 0 } }
      })
    ).toBe(
      'Contradiction check: 1 pair judged both ways; the two orders agreed on 1 · underlines: 0 of the last 1 were right'
    )
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

  it('shows no switch-over record for a project made v2 another way', async () => {
    settle({ ...defaultAiSettings(), dial: 1 })
    render(<MemorySettings />)
    await screen.findByTestId('memory-health')
    expect(main.sent('switchover:record')).toEqual([undefined])
    expect(screen.queryByTestId('switchover-record')).toBeNull()
  })
})

describe('MemorySettings: the switch-over record (F-16.31 part A, decision SW-D7)', () => {
  it('names the switch date, the backup, the dated copy and how to go back, and offers the waiting rebuild', async () => {
    record = SWITCHED
    settle({ ...defaultAiSettings(), dial: 1 })
    useShellDialogStore.getState().show('settings', 'ai')
    render(<MemorySettings />)
    const block = await screen.findByTestId('switchover-record')
    expect(block).toHaveTextContent('Switched to the new story memory on 14 October 2026.')
    expect(block).toHaveTextContent(`Backup: ${BACKUP}`)
    expect(block).toHaveTextContent(`Dated copy: ${DATED}`)
    expect(block).toHaveTextContent(goBackLine(BACKUP))
    expect(block).toHaveTextContent('Rebuild memory has not run since the switch.')
    // Rebuild memory… closes Settings and opens the rebuild dialog at its price; nothing is sent.
    fireEvent.click(screen.getByRole('button', { name: 'Rebuild memory…' }))
    expect(useShellDialogStore.getState().open).toBeNull()
    expect(useMemoryStore.getState().rebuildOpen).toBe('start')
    expect(main.sent('memory:rebuild')).toEqual([])
  })

  it('says when the first rebuild ran once it has, with no button', async () => {
    record = { ...SWITCHED, rebuild: 'started', rebuildStartedAt: '2026-10-15T12:00:00.000Z' }
    settle({ ...defaultAiSettings(), dial: 1 })
    render(<MemorySettings />)
    const block = await screen.findByTestId('switchover-record')
    expect(block).toHaveTextContent('Rebuild memory first ran after the switch on 15 October 2026.')
    expect(screen.queryByRole('button', { name: 'Rebuild memory…' })).toBeNull()
    expect(screen.queryByTestId('switchover-waiting')).toBeNull()
  })

  it('on a test copy, names the project it was made from, with no way back to offer', async () => {
    record = {
      ...SWITCHED,
      trial: true,
      source: '/My Drive/Book.mythscribe',
      backup: null,
      datedCopy: null
    }
    settle({ ...defaultAiSettings(), dial: 1 })
    render(<MemorySettings />)
    const block = await screen.findByTestId('switchover-record')
    expect(block).toHaveTextContent(
      'This is a test copy of /My Drive/Book.mythscribe, switched to the new story memory on 14 October 2026. The project it was made from still uses the old one.'
    )
    expect(block).not.toHaveTextContent('Backup:')
    expect(block).not.toHaveTextContent('To go back')
    expect(block).toHaveTextContent('Rebuild memory has not run since the switch.')
  })
})
