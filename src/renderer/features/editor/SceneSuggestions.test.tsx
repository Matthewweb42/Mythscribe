import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { defaultAiSettings } from '@shared/aiSettings'
import type {
  AiSuggestNotesResult,
  AiSuggestSynopsisResult,
  Channel,
  Input,
  Output
} from '@shared/ipc/contract'
import { EMPTY_SCENE_META, type SceneMeta } from '@shared/sceneMeta'
import type { TiptapNodeT } from '@shared/tiptap'
import { resetAiActivityStore } from '@renderer/features/ai/aiActivityStore'
import { resetAiSettingsStore, useAiSettingsStore } from '@renderer/features/ai/aiSettingsStore'
import { resetProposalStore } from '@renderer/features/ai/proposalStore'
import { treeFixture } from '@renderer/features/manuscript/treeFixture'
import { buildIndex, useTreeStore } from '@renderer/features/manuscript/treeStore'
import { resetPendingSaves } from '@renderer/features/project/pendingSaves'
import { useDialogStore } from '@renderer/features/shell/dialogs/dialogStore'
import { setIpcClient, type IpcClient } from '@renderer/lib/ipc'
import { resetDocumentStore, useDocumentStore } from './documentStore'
import { SynopsisBox } from './MetadataPane'
import { resetNotesStore, useNotesStore } from './notesStore'
import { resetSceneMetaStore, useSceneMetaStore } from './sceneMetaStore'
import { NotesSuggestion, SuggestButton } from './SceneSuggestions'
import { appendNotePoints, resetSceneSuggestStore, useSceneSuggestStore } from './sceneSuggestStore'

const SCENE = 'Mara climbed the ridge as the storm broke over the valley behind her. '.repeat(3)
const POINTS = ['Mara fears the ferryman.', 'The storm cuts the valley off.', 'Tomas is late.']

let calls: [Channel, unknown][]
let storedNotes: TiptapNodeT | null
let storedMeta: SceneMeta
let synopsisResult: AiSuggestSynopsisResult
let notesResult: AiSuggestNotesResult

const cost = { usage: { inputTokens: 800, outputTokens: 40 }, costUsd: 0.0002, cached: false }

function client(): IpcClient {
  return {
    async invoke<C extends Channel>(channel: C, input: Input<C>): Promise<Output<C>> {
      calls.push([channel, input])
      switch (channel) {
        case 'ai:suggestSynopsis':
          return {
            ...synopsisResult,
            requestId: (input as Input<C> & { requestId: string }).requestId
          } as Output<C>
        case 'ai:suggestNotes':
          return {
            ...notesResult,
            requestId: (input as Input<C> & { requestId: string }).requestId
          } as Output<C>
        case 'sceneMeta:get':
          return { id: (input as Input<'sceneMeta:get'>).id, meta: storedMeta } as Output<C>
        case 'sceneMeta:set':
          storedMeta = { ...EMPTY_SCENE_META, ...(input as Input<'sceneMeta:set'>).meta }
          return { modified: 'm' } as Output<C>
        case 'notes:get':
          return { id: (input as Input<'notes:get'>).id, notes: storedNotes } as Output<C>
        case 'notes:save':
          storedNotes = (input as Input<'notes:save'>).notes
          return { modified: 'm' } as Output<C>
        case 'proposal:settle':
        case 'recovery:clear':
        case 'recovery:stash':
          return null as Output<C>
        case 'ai:cancel':
          return { cancelled: true } as Output<C>
        default:
          throw new Error(`unexpected ${channel}`)
      }
    },
    on: () => () => {}
  }
}

const settlements = (): unknown[] =>
  calls.filter(([channel]) => channel === 'proposal:settle').map(([, input]) => input)

beforeEach(() => {
  calls = []
  storedNotes = null
  storedMeta = { ...EMPTY_SCENE_META }
  synopsisResult = {
    ok: true,
    synopsis: 'Mara crosses the ridge before the storm.',
    truncated: false,
    model: 'gpt-fast',
    proposalId: 'p-syn',
    requestId: 'r',
    ...cost
  }
  notesResult = {
    ok: true,
    points: POINTS,
    dropped: 0,
    truncated: false,
    model: 'gpt-fast',
    proposalId: 'p-notes',
    requestId: 'r',
    ...cost
  }
  resetSceneSuggestStore()
  resetSceneMetaStore()
  resetNotesStore()
  resetDocumentStore()
  resetAiSettingsStore()
  resetAiActivityStore()
  resetProposalStore()
  resetPendingSaves()
  useDialogStore.setState({ modals: [], toasts: [] })
  useTreeStore.setState({ ...buildIndex(treeFixture), loaded: true })
  useAiSettingsStore.setState({ settings: { ...defaultAiSettings(), dial: 1 } })
  useDocumentStore.setState({
    docs: {
      'sc-1': {
        content: {
          type: 'doc',
          content: [{ type: 'paragraph', content: [{ type: 'text', text: SCENE }] }]
        },
        dirty: false
      }
    }
  })
  setIpcClient(client())
})
afterEach(() => {
  resetSceneSuggestStore()
  resetSceneMetaStore()
  resetNotesStore()
  resetDocumentStore()
  resetAiSettingsStore()
  resetAiActivityStore()
  resetPendingSaves()
  useTreeStore.getState().clear()
  setIpcClient(null)
})

describe('appendNotePoints (F-5.20)', () => {
  it('appends one bullet list whose text carries the AI-origin mark of the proposal', () => {
    const notes: TiptapNodeT = {
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Mine.' }] }]
    }
    const next = appendNotePoints(notes, ['One.', 'Two!'], 'p-1')
    expect(next.content?.[0]).toEqual(notes.content?.[0])
    expect(next.content?.[1]).toEqual({
      type: 'bulletList',
      content: ['One.', 'Two!'].map((text) => ({
        type: 'listItem',
        content: [
          {
            type: 'paragraph',
            content: [
              {
                type: 'text',
                text,
                marks: [{ type: 'aiOrigin', attrs: { proposalId: 'p-1', accepted: 8 } }]
              }
            ]
          }
        ]
      }))
    })
  })

  it('replaces an empty document instead of leaving a blank line above the list', () => {
    const next = appendNotePoints(
      { type: 'doc', content: [{ type: 'paragraph' }] },
      ['One.'],
      'p-1'
    )
    expect(next.content).toHaveLength(1)
    expect(next.content?.[0]?.type).toBe('bulletList')
  })
})

describe('Suggest synopsis (F-5.20)', () => {
  it('Suggest shows the synopsis under the box; Accept fills the box and settles accepted', async () => {
    render(<SynopsisBox id="sc-1" />)
    const synopsis = await screen.findByRole('textbox', { name: 'Synopsis' })
    await waitFor(() => expect(synopsis).toBeEnabled())
    await userEvent.click(screen.getByRole('button', { name: 'Suggest synopsis' }))
    const card = await screen.findByRole('group', { name: 'Suggested synopsis' })
    expect(card).toHaveTextContent('Suggested by AI')
    expect(within(card).getByTestId('suggested-synopsis')).toHaveTextContent(
      'Mara crosses the ridge before the storm.'
    )
    expect(within(card).getByTestId('suggest-cost')).toHaveTextContent('gpt-fast')
    expect(synopsis).toHaveValue('')
    await userEvent.click(within(card).getByRole('button', { name: 'Accept' }))
    expect(screen.queryByRole('group', { name: 'Suggested synopsis' })).not.toBeInTheDocument()
    expect(synopsis).toHaveValue('Mara crosses the ridge before the storm.')
    expect(useSceneMetaStore.getState().docs['sc-1']?.dirty).toBe(true)
    await waitFor(() =>
      expect(settlements()).toEqual([{ id: 'p-syn', status: 'accepted', note: null }])
    )
  })

  it('Dismiss settles rejected and leaves the box alone', async () => {
    render(<SynopsisBox id="sc-1" />)
    await userEvent.click(await screen.findByRole('button', { name: 'Suggest synopsis' }))
    const card = await screen.findByRole('group', { name: 'Suggested synopsis' })
    await userEvent.click(within(card).getByRole('button', { name: 'Dismiss' }))
    expect(screen.queryByRole('group', { name: 'Suggested synopsis' })).not.toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: 'Synopsis' })).toHaveValue('')
    await waitFor(() =>
      expect(settlements()).toEqual([{ id: 'p-syn', status: 'rejected', note: null }])
    )
  })

  it('shows an expected failure with its next step', async () => {
    synopsisResult = {
      ok: false,
      code: 'RATE_LIMIT',
      message: 'OpenAI is rate limiting this key.',
      nextStep: 'Wait a minute.',
      requestId: 'r'
    }
    render(<SynopsisBox id="sc-1" />)
    await userEvent.click(await screen.findByRole('button', { name: 'Suggest synopsis' }))
    expect(await screen.findByTestId('suggest-synopsis-error')).toHaveTextContent(
      'OpenAI is rate limiting this key. Wait a minute.'
    )
  })

  it('writes a synopsis accepted while no view holds the metadata straight to main', async () => {
    act(() => useSceneSuggestStore.getState().suggestSynopsis('sc-1'))
    await waitFor(() =>
      expect(useSceneSuggestStore.getState().synopsis['sc-1']?.status).toBe('ready')
    )
    await act(() => useSceneSuggestStore.getState().acceptSynopsis('sc-1'))
    expect(storedMeta.synopsis).toBe('Mara crosses the ridge before the storm.')
    expect(useSceneMetaStore.getState().docs['sc-1']).toBeUndefined()
  })
})

describe('Suggest notes (F-5.20)', () => {
  it('Add to notes appends the ticked points and settles acceptedPart for some', async () => {
    storedNotes = {
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Mine.' }] }]
    }
    render(
      <>
        <SuggestButton id="sc-1" kind="notes" />
        <NotesSuggestion id="sc-1" />
      </>
    )
    await userEvent.click(screen.getByRole('button', { name: 'Suggest notes' }))
    const card = await screen.findByRole('group', { name: 'Suggested notes' })
    const boxes = within(card).getAllByTestId('suggested-note')
    expect(boxes).toHaveLength(3)
    for (const box of boxes) expect(box).toBeChecked()
    await userEvent.click(boxes[1]!)
    await userEvent.click(within(card).getByRole('button', { name: 'Add to notes' }))
    await waitFor(() =>
      expect(settlements()).toEqual([{ id: 'p-notes', status: 'acceptedPart', note: null }])
    )
    const list = storedNotes?.content?.[1]
    expect(list?.type).toBe('bulletList')
    expect(list?.content?.map((item) => item.content?.[0]?.content?.[0]?.text)).toEqual([
      POINTS[0],
      POINTS[2]
    ])
    expect(screen.queryByRole('group', { name: 'Suggested notes' })).not.toBeInTheDocument()
  })

  it('rebuilds the open notes on the stored ones after adding every point', async () => {
    await act(() => useNotesStore.getState().load('sc-1'))
    act(() => useSceneSuggestStore.getState().suggestNotes('sc-1', 'Tomas'))
    await waitFor(() => expect(useSceneSuggestStore.getState().notes['sc-1']?.status).toBe('ready'))
    expect(calls.find(([c]) => c === 'ai:suggestNotes')?.[1]).toMatchObject({
      nodeId: 'sc-1',
      instruction: 'Tomas'
    })
    await act(() => useSceneSuggestStore.getState().addNotes('sc-1', [0, 1, 2]))
    expect(useNotesStore.getState().docs['sc-1']?.content?.content?.[0]?.type).toBe('bulletList')
    await waitFor(() =>
      expect(settlements()).toEqual([{ id: 'p-notes', status: 'accepted', note: null }])
    )
  })
})

describe('SuggestButton (F-5.20)', () => {
  it('is not shown while the dial is Off or for a folder, and waits for enough text', async () => {
    useAiSettingsStore.setState({ settings: defaultAiSettings() })
    const view = render(<SuggestButton id="sc-1" kind="synopsis" />)
    expect(screen.queryByRole('button', { name: 'Suggest synopsis' })).not.toBeInTheDocument()
    act(() => useAiSettingsStore.setState({ settings: { ...defaultAiSettings(), dial: 1 } }))
    expect(screen.getByRole('button', { name: 'Suggest synopsis' })).toBeEnabled()
    view.rerender(<SuggestButton id="ch-1" kind="synopsis" />)
    expect(screen.queryByRole('button', { name: 'Suggest synopsis' })).not.toBeInTheDocument()
    act(() =>
      useDocumentStore.setState({
        docs: {
          'sc-1': {
            content: {
              type: 'doc',
              content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Short.' }] }]
            },
            dirty: false
          }
        }
      })
    )
    view.rerender(<SuggestButton id="sc-1" kind="synopsis" />)
    expect(screen.getByRole('button', { name: 'Suggest synopsis' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Suggest synopsis' })).toHaveAttribute(
      'title',
      'Write 100 characters first'
    )
  })
})
