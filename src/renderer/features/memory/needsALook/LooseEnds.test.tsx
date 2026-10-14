import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { defaultAiSettings, type AiSettings } from '@shared/aiSettings'
import { defaultConversations } from '@shared/chat'
import type { Input } from '@shared/ipc/contract'
import type { Dismissed } from '@shared/memory/dismissed'
import { resetAiActivityStore } from '@renderer/features/ai/aiActivityStore'
import { resetAiSettingsStore, useAiSettingsStore } from '@renderer/features/ai/aiSettingsStore'
import { resetAssistantStore, useAssistantStore } from '@renderer/features/ai/assistantStore'
import { resetDocumentStore } from '@renderer/features/editor/documentStore'
import { resetPendingSaves } from '@renderer/features/project/pendingSaves'
import { useProjectStore } from '@renderer/features/project/projectStore'
import { useDialogStore } from '@renderer/features/shell/dialogs/dialogStore'
import { resetLayoutStore } from '@renderer/features/shell/layoutStore'
import { resetDismissedStore, useDismissedStore } from '@renderer/features/thisScene/dismissedStore'
import { setIpcClient } from '@renderer/lib/ipc'
import { installFakeMain, looseEndFixture, looseEndsFixture, type FakeMain } from '../memoryFixture'
import { resetMemoryStore, useMemoryStore } from '../memoryStore'
import { LooseEnds } from './LooseEnds'

/**
 * F-16.29 (plan P4 §4, design §2.7): Needs a look's Loose ends: the scoped line composed here
 * only, *Ask Ms Scribe* sending the loose end's own question through the chat (in v2 Ms Scribe's
 * navigator), disabled with its reason while Ms Scribe is off, and *Not a problem*.
 */

const PLANNED = looseEndFixture()
const ORRIN = looseEndFixture({
  kind: 'character',
  id: 'r-orrin',
  name: 'Orrin',
  lastRef: '6.2',
  lastNodeId: 'sc-6',
  horizonRef: '18.2',
  ask: 'Orrin is last named in 6.2. Where is Orrin after that?'
})
const tombstone: Dismissed = {
  id: 'd-loose',
  kind: 'notProblem',
  key: 'loose|planned|sc-plan|',
  recordId: null,
  nodeId: 'sc-plan',
  label: 'Loose end: planned scene “The duel at dawn”: not a problem',
  quote: null,
  created: '2026-10-14T10:00:00.000Z'
}

let main: FakeMain

function settings(over: Partial<AiSettings> = {}): AiSettings {
  return { ...defaultAiSettings(), dial: 1, ...over }
}

beforeEach(async () => {
  resetMemoryStore()
  resetDismissedStore()
  resetAssistantStore()
  resetAiSettingsStore()
  resetAiActivityStore()
  resetDocumentStore()
  resetLayoutStore()
  resetPendingSaves()
  useDialogStore.setState({ modals: [], toasts: [] })
  useProjectStore.setState({
    current: {
      id: 'p-1',
      name: 'Memory',
      format: 'novel',
      path: '/books/Memory.mythscribe',
      created: 'c',
      modified: 'm',
      lastOpened: 'l',
      schemaVersion: 39,
      storyMemory: 'v2'
    }
  })
  main = installFakeMain({
    'memory:looseEnds': () => looseEndsFixture({ items: [PLANNED, ORRIN], more: 2 }),
    'memory:looseEndAction': () => tombstone,
    'conversations:get': () => defaultConversations(),
    'conversations:set': (input) => input,
    'layout:set': (input) => input,
    // Stopped at once: the test needs only what was sent.
    'ai:navigate': () => ({ ok: false, code: 'CANCELLED', message: 'Stopped', nextStep: '' })
  })
  useAiSettingsStore.setState({ settings: settings() })
  await act(async () => {
    await useAssistantStore.getState().load()
    await useMemoryStore.getState().loadLooseEnds()
  })
})
afterEach(() => {
  resetMemoryStore()
  resetDismissedStore()
  resetAssistantStore()
  resetAiSettingsStore()
  resetDocumentStore()
  useProjectStore.setState({ current: null })
  setIpcClient(null)
})

function show(): void {
  const view = useMemoryStore.getState().looseEnds
  render(<LooseEnds items={view?.items ?? []} more={view?.more ?? 0} />)
}

describe('LooseEnds (F-16.29)', () => {
  it('words each loose end in scoped terms, with + n more', () => {
    show()
    const rows = screen.getAllByTestId('loose-end')
    expect(rows.map((row) => row.querySelector('p')?.textContent)).toEqual([
      'Planned “The duel at dawn” sits before 1.2 and is not drafted',
      'Orrin: last named in 6.2'
    ])
    expect(screen.getByText('+ 2 more')).toBeInTheDocument()
  })

  it('Ask Ms Scribe sends the loose end’s own question to Ms Scribe’s navigator', async () => {
    show()
    const [planned] = screen.getAllByTestId('loose-end')
    fireEvent.click(within(planned!).getByRole('button', { name: 'Ask Ms Scribe' }))
    await waitFor(() => expect(main.sent('ai:navigate')).toHaveLength(1))
    expect((main.sent('ai:navigate')[0] as Input<'ai:navigate'>).message).toBe(
      "Which drafted scene covers the plan 'The duel at dawn'?"
    )
  })

  it('Ask Ms Scribe leaves a passage staged in the composer where it is', async () => {
    useAssistantStore.setState({ attachment: 'Mara climbed the stair.' })
    show()
    const [planned] = screen.getAllByTestId('loose-end')
    fireEvent.click(within(planned!).getByRole('button', { name: 'Ask Ms Scribe' }))
    await waitFor(() => expect(main.sent('ai:navigate')).toHaveLength(1))
    expect((main.sent('ai:navigate')[0] as Input<'ai:navigate'>).message).toBe(
      "Which drafted scene covers the plan 'The duel at dawn'?"
    )
    expect(useAssistantStore.getState().attachment).toBe('Mara climbed the stair.')
  })

  it('disables Ask Ms Scribe with its reason while Ms Scribe is off', () => {
    useAiSettingsStore.setState({
      settings: settings({
        features: { ...defaultAiSettings().features, agent: false, navigator: false, cite: false }
      })
    })
    show()
    const [ask] = screen.getAllByRole('button', { name: 'Ask Ms Scribe' })
    expect(ask).toBeDisabled()
    expect(ask).toHaveAttribute(
      'title',
      'Ask Ms Scribe needs Use AI turned on, with Ms Scribe on (Settings, AI tab)'
    )
  })

  it('Not a problem sends the loose end’s key and takes it away', async () => {
    show()
    fireEvent.click(
      screen.getByRole('button', {
        name: 'Not a problem: Planned “The duel at dawn” sits before 1.2 and is not drafted'
      })
    )
    await waitFor(() =>
      expect(main.sent('memory:looseEndAction')).toEqual([
        { kind: 'planned', id: 'sc-plan', lastNodeId: null }
      ])
    )
    expect(useMemoryStore.getState().looseEnds?.items.map((each) => each.id)).toEqual(['r-orrin'])
    expect(useDismissedStore.getState().items.map((each) => each.id)).toEqual(['d-loose'])
  })
})
