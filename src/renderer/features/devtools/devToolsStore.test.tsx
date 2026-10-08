import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DevAiRequest, DevLogEntry, DevToolsSnapshot } from '@shared/devtools'
import type { Channel, EventName, EventPayload, Input, Output } from '@shared/ipc/contract'
import { useDialogStore } from '@renderer/features/shell/dialogs/dialogStore'
import { setIpcClient, type IpcClient } from '@renderer/lib/ipc'
import { DevToolsPanel } from './DevToolsPanel'
import { resetDevToolsStore, useDevToolsStore } from './devToolsStore'
import { listenForDevLog, reportGhostSkip } from './rendererDevLog'

const ROW: DevAiRequest = {
  id: 7,
  requestId: 'g-1',
  feature: 'ghostText',
  provider: 'openrouter',
  model: 'deepseek/x',
  tier: 'fast',
  promptVersion: 'ghostText.v4',
  streamed: false,
  status: 'ok',
  startedAt: '2026-10-07T10:00:00.000Z',
  waitMs: 2,
  firstTokenMs: null,
  totalMs: 12_400,
  maxTokens: 40,
  inputTokens: 900,
  outputTokens: 40,
  cachedTokens: null,
  reasoningTokens: 40,
  reasoning: 'default',
  costUsd: 0.0001,
  finishReason: 'length',
  answerChars: 0,
  errorCode: null,
  errorMessage: null,
  note: 'No suggestion: empty after post-processing',
  hasText: true
}

const ENTRY: DevLogEntry = {
  id: 1,
  at: '2026-10-07T10:00:01.000Z',
  level: 'warn',
  source: 'ipc',
  message: 'tree:rename failed: NOT_FOUND: No node',
  details: null
}

interface Fake {
  client: IpcClient
  calls: { channel: Channel; input: unknown }[]
  listeners: Map<string, (payload: unknown) => void>
  enabled: boolean
  snapshot: DevToolsSnapshot
}

function fakeClient(): Fake {
  const fake: Fake = {
    calls: [],
    listeners: new Map(),
    enabled: false,
    snapshot: { enabled: true, log: [ENTRY], requests: [ROW] },
    client: {
      async invoke<C extends Channel>(channel: C, input: Input<C>): Promise<Output<C>> {
        fake.calls.push({ channel, input })
        switch (channel) {
          case 'devtools:getState':
            return { enabled: fake.enabled } as Output<C>
          case 'devtools:setEnabled':
            fake.enabled = (input as Input<'devtools:setEnabled'>).on
            return { enabled: fake.enabled } as Output<C>
          case 'devtools:snapshot':
            return (
              fake.enabled ? fake.snapshot : { enabled: false, log: [], requests: [] }
            ) as Output<C>
          case 'devtools:requestText':
            return {
              messages: [{ role: 'user', content: 'Mara counted the gaps.' }],
              response: ''
            } as Output<C>
          case 'devtools:report':
            return 'MythScribe diagnostics\n' as Output<C>
          case 'devtools:clear':
          case 'devtools:log':
          case 'devtools:ghostSkip':
          case 'devtools:openChromium':
            return null as Output<C>
          default:
            throw new Error(`unexpected ${channel}`)
        }
      },
      on<E extends EventName>(event: E, listener: (payload: EventPayload<E>) => void): () => void {
        fake.listeners.set(event, listener as (payload: unknown) => void)
        return () => fake.listeners.delete(event)
      }
    }
  }
  return fake
}

let fake: Fake
const store = (): ReturnType<typeof useDevToolsStore.getState> => useDevToolsStore.getState()
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

beforeEach(() => {
  resetDevToolsStore()
  useDialogStore.setState({ toasts: [], modals: [] })
  fake = fakeClient()
  setIpcClient(fake.client)
})
afterEach(() => {
  resetDevToolsStore()
  useDialogStore.setState({ toasts: [], modals: [] })
})

describe('devToolsStore (2026-10-07)', () => {
  it('loads off, and the panel cannot open while off', async () => {
    const off = store().subscribe()
    await flush()
    expect(store().enabled).toBe(false)
    store().openPanel()
    expect(store().open).toBe(false)
    off()
    expect(fake.listeners.size).toBe(0)
  })

  it('turning on loads the snapshot; pushes append and update rows; turning off empties and closes', async () => {
    store().subscribe()
    await store().setEnabled(true)
    await flush()
    expect(store().requests).toEqual([ROW])
    expect(store().log).toEqual([ENTRY])

    fake.listeners.get('devtools:requestChanged')!({ ...ROW, status: 'failed' })
    fake.listeners.get('devtools:requestChanged')!({ ...ROW, id: 8 })
    fake.listeners.get('devtools:logAdded')!({ ...ENTRY, id: 2 })
    expect(store().requests.map((r) => [r.id, r.status])).toEqual([
      [7, 'failed'],
      [8, 'ok']
    ])
    expect(store().log).toHaveLength(2)

    store().openPanel()
    expect(store().open).toBe(true)
    fake.listeners.get('devtools:changed')!({ enabled: false })
    expect(store()).toMatchObject({ enabled: false, open: false, log: [], requests: [] })
  })

  it('reports ghost skips and console warnings only while on, and never loops', async () => {
    const warn = vi.fn()
    const target = { error: vi.fn(), warn }
    const unlisten = listenForDevLog(target)
    target.warn('ignored while off')
    reportGhostSkip('newChars')
    expect(fake.calls.map((c) => c.channel)).toEqual([])

    await store().setEnabled(true)
    target.warn('slow', new Error('late'))
    reportGhostSkip('visible')
    const sent = fake.calls.filter(
      (c) => c.channel === 'devtools:log' || c.channel === 'devtools:ghostSkip'
    )
    expect(sent[0]!.input).toMatchObject({ level: 'warn', message: 'slow Error: late' })
    expect(sent[1]!.input).toEqual({ reason: 'visible' })
    expect(warn).toHaveBeenCalledTimes(2)
    unlisten()
    expect(target.warn).toBe(warn)
  })
})

describe('DevToolsPanel (2026-10-07)', () => {
  async function opened(): Promise<void> {
    await store().setEnabled(true)
    await flush()
    store().openPanel()
    render(<DevToolsPanel />)
    await flush()
  }

  it('lists the AI requests with the note, reveals the text on request, and copies the report', async () => {
    const writeText = vi.fn(() => Promise.resolve())
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    await opened()
    const panel = screen.getByRole('region', { name: 'Developer tools' })
    const row = within(panel).getByTestId('devtools-request')
    expect(row).toHaveTextContent('ghostText')
    expect(row).toHaveTextContent('No suggestion: empty after post-processing')

    await userEvent.click(within(row).getByRole('button', { expanded: false }))
    expect(row).toHaveTextContent('900 in (0 cached) · 40 out (40 reasoning) · cap 40')
    expect(row).toHaveTextContent('finish length')
    await userEvent.click(within(row).getByRole('button', { name: 'Show text' }))
    expect(await within(row).findByText(/Mara counted the gaps/)).toBeInTheDocument()

    await userEvent.click(within(panel).getByRole('button', { name: 'Copy diagnostics' }))
    expect(writeText).toHaveBeenCalledWith('MythScribe diagnostics\n')
  })

  it('minimizes to its bar and back, and resizes from its top edge with the keyboard (2026-10-08)', async () => {
    window.localStorage.removeItem('mythscribe.devtools.height')
    await opened()
    const panel = screen.getByRole('region', { name: 'Developer tools' })
    const handle = within(panel).getByRole('separator', { name: 'Resize developer tools' })
    const before = parseInt(panel.style.height, 10)
    handle.focus()
    await userEvent.keyboard('{ArrowUp}')
    expect(parseInt(panel.style.height, 10)).toBeGreaterThan(before)

    await userEvent.click(within(panel).getByRole('button', { name: 'Minimize developer tools' }))
    expect(within(panel).queryByTestId('devtools-request')).toBeNull()
    expect(within(panel).queryByRole('separator')).toBeNull()
    expect(panel.style.height).toBe('')
    await userEvent.click(within(panel).getByRole('button', { name: 'Expand developer tools' }))
    expect(within(panel).getByTestId('devtools-request')).toBeInTheDocument()
  })

  it('shows the live log, filters by level, and closes', async () => {
    await opened()
    await userEvent.click(screen.getByRole('tab', { name: /Log/ }))
    expect(screen.getByTestId('devtools-log')).toHaveTextContent('tree:rename failed')
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Level' }), 'error')
    expect(screen.getByText('No errors or warnings recorded.')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Close developer tools' }))
    expect(store().open).toBe(false)
  })
})
