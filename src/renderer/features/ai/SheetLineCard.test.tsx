import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AgentChange } from '@shared/agent'
import { defaultAiSettings } from '@shared/aiSettings'
import type { Conversation } from '@shared/chat'
import type { Channel, Input, Output } from '@shared/ipc/contract'
import { resetChangesStore } from '@renderer/features/changes/changesStore'
import { resetPendingSaves } from '@renderer/features/project/pendingSaves'
import { resetPageStore } from '@renderer/features/research/pageStore'
import { setIpcClient } from '@renderer/lib/ipc'
import { AgentChanges } from './AgentTurn'
import { resetAiSettingsStore, useAiSettingsStore } from './aiSettingsStore'
import { PLAN_NO_EDITS_MESSAGE, resetAssistantStore, useAssistantStore } from './assistantStore'
import { resetProposalStore } from './proposalStore'
import { SHEET_LINE_QUESTION } from './SheetLineCard'

/**
 * F-16.26 (decision 3 as the author changed it): a sheet line Ms Scribe could not place asks "Is
 * this an idea or canon?"; *Idea* lands it in Ideas and *Canon* in Pinned, each the one click,
 * with the confirmation and its Undo after; *Skip* leaves the sheet; in Plan the choices are off.
 */

let added: Input<'record:addLine'>[]

const CHANGE: AgentChange = {
  id: 'e-1',
  edit: {
    kind: 'sheetLine',
    recordId: 'r-mara',
    name: 'Mara',
    place: null,
    text: 'Hates the sea',
    turn: 'r-turn'
  },
  status: 'pending',
  violation: null,
  error: null,
  proposalId: null,
  notice: null,
  trackedId: null
}

const turn = (
  id: string,
  role: 'user' | 'assistant',
  content: string
): Conversation['messages'][number] => ({
  id,
  role,
  content,
  created: '2026-10-13T10:00:00.000Z',
  proposalId: role === 'assistant' ? 'p-1' : null,
  model: null,
  costUsd: null,
  usage: null,
  mode: null,
  query: null,
  directions: null,
  action: null,
  agent: role === 'assistant' ? { access: 'write', steps: [], changes: [CHANGE] } : null,
  edit: null,
  card: null,
  scribe: null,
  costParts: null,
  contradictions: null,
  sources: null
})

const STORED: Conversation = {
  id: 'c-1',
  title: 'Mara',
  mode: 'plan',
  paragraphs: 1,
  messages: [
    turn('m-1', 'user', 'Save this for Mara: she hates the sea.'),
    turn('m-2', 'assistant', 'Done.')
  ],
  created: '2026-10-13T10:00:00.000Z',
  modified: '2026-10-13T10:00:00.000Z'
}

const NONE: AgentChange[] = []

/** The stored turn's edits as the store holds them now. */
function Turn(): React.JSX.Element {
  const changes = useAssistantStore(
    (s) => s.conversations?.items[0]?.messages[1]?.agent?.changes ?? NONE
  )
  return <AgentChanges messageId="m-2" changes={changes} />
}

async function show(chatMode: 'vibe' | 'write' | 'brainstorm'): Promise<void> {
  useAiSettingsStore.setState({ settings: { ...defaultAiSettings(), dial: 1, chatMode } })
  await act(() => useAssistantStore.getState().load())
  render(<Turn />)
}

beforeEach(() => {
  added = []
  resetAssistantStore()
  resetAiSettingsStore()
  resetChangesStore()
  resetPageStore()
  resetProposalStore()
  resetPendingSaves()
  setIpcClient({
    async invoke<C extends Channel>(channel: C, input: Input<C>): Promise<Output<C>> {
      switch (channel) {
        case 'conversations:get':
          return { active: 'c-1', items: [STORED] } as Output<C>
        case 'conversations:set': {
          const value = input as Input<'conversations:set'>
          return value as Output<C>
        }
        case 'proposal:settle':
          return null as Output<C>
        case 'record:addLine': {
          const line = input as Input<'record:addLine'>
          added.push(line)
          return {
            record: {
              id: 'r-mara',
              categoryId: 'character',
              kind: 'character',
              name: 'Mara',
              image: null,
              origin: 'author',
              aliases: [],
              created: '2026-10-13T09:00:00.000Z',
              modified: '2026-10-13T09:00:00.000Z',
              pinned: null,
              ideas: null
            },
            index: 0,
            text: line.text,
            conflict: null
          } as Output<C>
        }
        default:
          throw new Error(`unexpected ${channel}`)
      }
    },
    on: () => () => undefined
  })
})
afterEach(() => {
  resetAssistantStore()
  resetAiSettingsStore()
  resetChangesStore()
  resetPageStore()
})

describe('SheetLineCard (F-16.26)', () => {
  it('asks the question; Idea lands the line in Ideas with its confirmation and Undo', async () => {
    await show('write')
    expect(screen.getByText(SHEET_LINE_QUESTION)).toBeTruthy()
    expect(screen.getByTestId('sheet-line-text').textContent).toBe(
      'For Mara’s sheet: “Hates the sea”'
    )
    await userEvent.click(screen.getByRole('button', { name: 'Idea' }))
    expect(added).toEqual([{ id: 'r-mara', page: 'ideas', text: 'Hates the sea', turn: 'r-turn' }])
    expect(await screen.findByText('Added to Mara’s Ideas: “Hates the sea”')).toBeTruthy()
    expect(screen.getByTestId('agent-change-undo')).toBeTruthy()
  })

  it('Canon pins it, in Auto too', async () => {
    await show('vibe')
    await userEvent.click(screen.getByRole('button', { name: 'Canon' }))
    expect(added.map((line) => line.page)).toEqual(['pinned'])
    expect(await screen.findByText('Pinned on Mara’s sheet: “Hates the sea”')).toBeTruthy()
  })

  it('Skip leaves the sheet alone', async () => {
    await show('write')
    await userEvent.click(screen.getByRole('button', { name: 'Skip' }))
    expect(added).toEqual([])
    expect(await screen.findByText('Skipped: Mara’s sheet: an idea or canon?')).toBeTruthy()
  })

  it('in Plan the choices are off and say why', async () => {
    await show('brainstorm')
    expect(screen.getByRole('button', { name: 'Idea' })).toHaveProperty('disabled', true)
    expect(screen.getByRole('button', { name: 'Canon' })).toHaveProperty('disabled', true)
    expect(screen.getByTestId('sheet-line-plan').textContent).toBe(PLAN_NO_EDITS_MESSAGE)
  })
})
