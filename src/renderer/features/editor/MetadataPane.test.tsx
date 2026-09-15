import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { defaultAiSettings } from '@shared/aiSettings'
import { TAG_BAR_BRIEF_HEIGHT } from '@shared/layout'
import type {
  AiDraftBriefResult,
  AiSummarizeResult,
  Channel,
  Input,
  Output
} from '@shared/ipc/contract'
import {
  BRIEF_TEXT_MIN,
  EMPTY_SCENE_BRIEF,
  EMPTY_SCENE_META,
  type SceneBrief,
  type SceneMeta
} from '@shared/sceneMeta'
import {
  SUMMARY_TEXT_MIN,
  UNAVAILABLE_SUMMARY,
  type SceneSummaryState,
  type StoredSceneSummary
} from '@shared/summary'
import { resetAiActivityStore } from '@renderer/features/ai/aiActivityStore'
import { resetAiSettingsStore, useAiSettingsStore } from '@renderer/features/ai/aiSettingsStore'
import { resetProposalStore } from '@renderer/features/ai/proposalStore'
import { treeFixture } from '@renderer/features/manuscript/treeFixture'
import { buildIndex, useTreeStore } from '@renderer/features/manuscript/treeStore'
import { resetPendingSaves } from '@renderer/features/project/pendingSaves'
import { useDialogStore } from '@renderer/features/shell/dialogs/dialogStore'
import { resetLayoutStore, useLayoutStore } from '@renderer/features/shell/layoutStore'
import { tagFixture } from '@renderer/features/tags/tagFixture'
import { orderedIds, resetTagStore, useTagStore } from '@renderer/features/tags/tagStore'
import { setIpcClient, type IpcClient } from '@renderer/lib/ipc'
import { resetDocumentStore, useDocumentStore } from './documentStore'
import { MetadataPane } from './MetadataPane'
import { resetSceneMetaStore, useSceneMetaStore } from './sceneMetaStore'
import { resetSummaryStore } from './summaryStore'

/** The brief `sc-4` is stored with, so the fields are checked against something they did not type. */
const STORED_BRIEF: SceneBrief = {
  goal: 'Reach the far bank.',
  conflict: 'The ferryman is gone.',
  turn: 'She swims instead.',
  beat: 'Fear turning to nerve.',
  after: 'The river can be crossed.'
}

const stored: Record<string, SceneMeta> = {
  'sc-1': { location: 'dark-forest', pov: 'mara', timeline: 'Day 1', brief: EMPTY_SCENE_BRIEF },
  'sc-4': { location: '', pov: '', timeline: '', brief: STORED_BRIEF }
}

type Handler = (input: unknown) => unknown

/** What the fake main drafts (F-14.3) unless a test overrides `ai:draftBrief`. */
const DRAFTED: SceneBrief = {
  goal: 'Mara wants to cross the river tonight.',
  conflict: 'Tomas will not row in this water.',
  turn: 'She decides to wait for morning.',
  beat: 'Dread giving way to resolve.',
  after: ''
}
const drafted = (
  over: Partial<Extract<AiDraftBriefResult, { ok: true }>> = {}
): AiDraftBriefResult => ({
  ok: true,
  brief: DRAFTED,
  truncated: false,
  usage: { inputTokens: 400, outputTokens: 60 },
  costUsd: 0.0012,
  cached: false,
  model: 'gpt-5.4-mini',
  proposalId: 'prop-1',
  requestId: 'req-1',
  ...over
})

/** The summary `sc-1` is stored with (F-5.6), unless a test overrides `summary:get`. */
const ROW: StoredSceneSummary = {
  nodeId: 'sc-1',
  summary: 'Mara crosses the river alone and reaches the far bank before dawn.',
  keyPoints: ['The ferryman is gone.', 'She swims instead.'],
  characters: ['Mara', 'Tomas'],
  contentHash: 'h1',
  promptVersion: 'summary.v1',
  model: 'gpt-5.4-mini',
  truncated: false,
  createdAt: '2026-09-15T10:00:00.000Z'
}

const summaryState = (over: Partial<SceneSummaryState> = {}): SceneSummaryState => ({
  available: true,
  summary: ROW,
  stale: false,
  status: 'idle',
  error: null,
  ...over
})

const summarized = (
  over: Partial<Extract<AiSummarizeResult, { ok: true }>> = {}
): AiSummarizeResult => ({
  ok: true,
  state: summaryState(),
  usage: { inputTokens: 900, outputTokens: 80 },
  costUsd: 0.0003,
  cached: false,
  model: 'gpt-5.4-mini',
  requestId: 'req-1',
  ...over
})

/**
 * `sceneMeta:get` answers from `stored` (once released); `sceneMeta:set` records its input;
 * `ai:draftBrief` answers `drafted()` and `proposal:settle` records how it was settled. Every
 * call is recorded, so the brief tests can assert on the settlements.
 */
function install(overrides: Partial<Record<Channel, Handler>> = {}): {
  calls: [Channel, unknown][]
  sets: Input<'sceneMeta:set'>[]
  release: () => void
} {
  const calls: [Channel, unknown][] = []
  const sets: Input<'sceneMeta:set'>[] = []
  let release: () => void = () => {}
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const client: IpcClient = {
    async invoke<C extends Channel>(channel: C, input: Input<C>): Promise<Output<C>> {
      calls.push([channel, input])
      const override = overrides[channel]
      if (override) return (await override(input)) as Output<C>
      if (channel === 'sceneMeta:get') {
        const { id } = input as Input<'sceneMeta:get'>
        await gate
        return { id, meta: stored[id] ?? { ...EMPTY_SCENE_META } } as Output<C>
      }
      if (channel === 'sceneMeta:set') {
        sets.push(input as Input<'sceneMeta:set'>)
        return { modified: 'm' } as Output<C>
      }
      if (channel === 'ai:draftBrief') return drafted() as Output<C>
      // A node has no summary unless a test says otherwise, so the block stays out of the way.
      if (channel === 'summary:get') return UNAVAILABLE_SUMMARY as Output<C>
      if (channel === 'ai:summarize') return summarized() as Output<C>
      if (channel === 'proposal:settle') return null as Output<C>
      if (channel === 'ai:cancel') return { cancelled: true } as Output<C>
      if (channel === 'layout:set') return input as Output<C>
      throw new Error(`unexpected ${channel}`)
    },
    on: () => () => {}
  }
  setIpcClient(client)
  return { calls, sets, release }
}

const field = (name: string): HTMLElement => screen.getByRole('combobox', { name })
const timeline = (): HTMLElement => screen.getByRole('textbox', { name: 'Timeline' })
const briefToggle = (): HTMLElement => screen.getByRole('button', { name: 'Brief' })
const summaryToggle = (): HTMLElement => screen.getByRole('button', { name: 'Summary' })
const refreshButton = (): HTMLElement => screen.getByTestId('summary-refresh')
const draftButton = (): HTMLElement => screen.getByRole('button', { name: 'Draft with AI' })
const line = (name: string): HTMLInputElement => screen.getByRole('textbox', { name })
const briefLines = (): string[] => [
  line('Goal').value,
  line('Conflict').value,
  line('Turn').value,
  line('Emotional beat').value,
  line('Reader knows after').value
]
const toasts = (): string[] => useDialogStore.getState().toasts.map((t) => t.message)
const settlements = (calls: [Channel, unknown][]): unknown[] =>
  calls.filter(([channel]) => channel === 'proposal:settle').map(([, input]) => input)

/** The dial at Ask with every toggle on, a tree with `sc-1` a scene and `ch-1` a folder, and enough text to draft from. */
function ready(id = 'sc-1', chars = BRIEF_TEXT_MIN): void {
  useTreeStore.setState({ ...buildIndex(treeFixture), loaded: true })
  useAiSettingsStore.setState({ settings: { ...defaultAiSettings(), dial: 1 } })
  useDocumentStore.setState({
    docs: {
      [id]: {
        content: {
          type: 'doc',
          content: [{ type: 'paragraph', content: [{ type: 'text', text: 'x'.repeat(chars) }] }]
        },
        dirty: false
      }
    }
  })
}

beforeEach(() => {
  resetPendingSaves()
  resetTagStore()
  resetSceneMetaStore()
  resetSummaryStore()
  resetDocumentStore()
  resetAiActivityStore()
  resetAiSettingsStore()
  resetProposalStore()
  resetLayoutStore()
  useTreeStore.setState({ ...buildIndex([]), loaded: false })
  useDialogStore.setState({ modals: [], toasts: [] })
  const byId = Object.fromEntries(tagFixture.map((t) => [t.id, t]))
  useTagStore.setState({ byId, ids: orderedIds(byId), loaded: true })
})
afterEach(() => {
  resetSceneMetaStore()
  resetSummaryStore()
  resetDocumentStore()
  resetAiActivityStore()
  resetAiSettingsStore()
  resetProposalStore()
  resetLayoutStore()
  resetPendingSaves()
  setIpcClient(null)
})

describe('MetadataPane (F-4.5)', () => {
  it('disables the fields until the load resolves, then shows the stored values', async () => {
    const { release } = install()
    render(<MetadataPane id="sc-1" />)
    expect(screen.getByRole('group', { name: 'Scene metadata' })).toBeInTheDocument()
    expect(field('Location')).toBeDisabled()
    expect(field('POV')).toBeDisabled()
    expect(timeline()).toBeDisabled()
    release()
    await waitFor(() => expect(field('Location')).toBeEnabled())
    expect(field('Location')).toHaveValue('dark-forest')
    expect(field('POV')).toHaveValue('mara')
    expect(timeline()).toHaveValue('Day 1')
  })

  it('suggests only setting tags for Location and only character tags for POV', async () => {
    const { release } = install()
    release()
    render(<MetadataPane id="sc-2" />)
    await waitFor(() => expect(field('Location')).toBeEnabled())
    fireEvent.change(field('Location'), { target: { value: 'd' } })
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual(['dark-forest'])
    fireEvent.keyDown(field('Location'), { key: 'Escape' })
    fireEvent.change(field('POV'), { target: { value: 'm' } })
    // "moody" is a tone tag and "mara" a character: only the character is offered.
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual(['mara'])
  })

  it('every edit goes through the autosave store and flushes as one merged record', async () => {
    const { sets, release } = install()
    release()
    render(<MetadataPane id="sc-1" />)
    await waitFor(() => expect(field('Location')).toBeEnabled())
    fireEvent.change(field('Location'), { target: { value: 'docks' } })
    fireEvent.change(timeline(), { target: { value: 'Day 2, dawn' } })
    expect(field('Location')).toHaveValue('docks')
    expect(useSceneMetaStore.getState().docs['sc-1']?.dirty).toBe(true)
    expect(sets).toHaveLength(0)
    await act(() => useSceneMetaStore.getState().flush())
    expect(sets).toEqual([
      {
        id: 'sc-1',
        meta: {
          location: 'docks',
          pov: 'mara',
          timeline: 'Day 2, dawn',
          brief: EMPTY_SCENE_BRIEF
        }
      }
    ])
    expect(useSceneMetaStore.getState().docs['sc-1']?.dirty).toBe(false)
  })

  it('unloads the record when it unmounts and reloads for a new id', async () => {
    const { release } = install()
    release()
    const view = render(<MetadataPane id="sc-1" />)
    await waitFor(() => expect(field('Location')).toHaveValue('dark-forest'))
    view.rerender(<MetadataPane id="sc-2" />)
    await waitFor(() => expect(field('Location')).toBeEnabled())
    expect(field('Location')).toHaveValue('')
    expect(useSceneMetaStore.getState().docs['sc-1']).toBeUndefined()
    view.unmount()
    expect(useSceneMetaStore.getState().docs['sc-2']).toBeUndefined()
    expect(toasts()).toEqual([])
  })
})

describe('MetadataPane brief (F-14.3)', () => {
  it('grows a short tag bar to fit the brief when it opens and never shrinks a taller one', async () => {
    const { release } = install()
    release()
    ready('sc-4')
    render(<MetadataPane id="sc-4" />)
    await waitFor(() => expect(field('Location')).toBeEnabled())
    await userEvent.click(briefToggle())
    expect(useLayoutStore.getState().layout.tagBar.height).toBe(TAG_BAR_BRIEF_HEIGHT)
    await userEvent.click(briefToggle())
    act(() => useLayoutStore.getState().setTagBarHeight(TAG_BAR_BRIEF_HEIGHT + 40))
    await userEvent.click(briefToggle())
    expect(useLayoutStore.getState().layout.tagBar.height).toBe(TAG_BAR_BRIEF_HEIGHT + 40)
  })

  it('keeps the brief collapsed until its toggle is clicked, then shows the stored lines', async () => {
    const { release } = install()
    release()
    ready('sc-4')
    render(<MetadataPane id="sc-4" />)
    await waitFor(() => expect(field('Location')).toBeEnabled())
    expect(briefToggle()).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByRole('textbox', { name: 'Goal' })).not.toBeInTheDocument()
    await userEvent.click(briefToggle())
    expect(briefToggle()).toHaveAttribute('aria-expanded', 'true')
    expect(briefLines()).toEqual([
      STORED_BRIEF.goal,
      STORED_BRIEF.conflict,
      STORED_BRIEF.turn,
      STORED_BRIEF.beat,
      STORED_BRIEF.after
    ])
  })

  it('saves an edited line through the autosave store with the rest of the metadata', async () => {
    const { sets, release } = install()
    release()
    ready()
    render(<MetadataPane id="sc-1" />)
    await waitFor(() => expect(field('Location')).toBeEnabled())
    await userEvent.click(briefToggle())
    fireEvent.change(line('Goal'), { target: { value: 'Cross before dawn.' } })
    fireEvent.change(line('Reader knows after'), { target: { value: 'The bridge is out.' } })
    expect(useSceneMetaStore.getState().docs['sc-1']?.dirty).toBe(true)
    await act(() => useSceneMetaStore.getState().flush())
    expect(sets).toEqual([
      {
        id: 'sc-1',
        meta: {
          location: 'dark-forest',
          pov: 'mara',
          timeline: 'Day 1',
          brief: {
            ...EMPTY_SCENE_BRIEF,
            goal: 'Cross before dawn.',
            after: 'The bridge is out.'
          }
        }
      }
    ])
  })

  it('drafts a brief, fills the fields on Use draft, and settles the proposal accepted', async () => {
    let resolveDraft: (result: AiDraftBriefResult) => void = () => {}
    const pending = new Promise<AiDraftBriefResult>((resolve) => {
      resolveDraft = resolve
    })
    const { calls, sets, release } = install({ 'ai:draftBrief': () => pending })
    release()
    ready()
    render(<MetadataPane id="sc-1" />)
    await waitFor(() => expect(field('Location')).toBeEnabled())
    await userEvent.click(draftButton())
    expect(screen.getByRole('status')).toHaveTextContent('Drafting the brief…')
    expect(screen.getByTestId('brief-draft-cancel')).toBeInTheDocument()
    await act(async () => {
      resolveDraft(drafted())
      await pending
    })
    const group = await screen.findByRole('group', { name: 'Brief draft' })
    expect(group).toHaveTextContent('Goal: Mara wants to cross the river tonight.')
    // The empty line reads as a dash rather than nothing at all.
    expect(group).toHaveTextContent('Reader knows after: —')
    expect(screen.getByTestId('brief-draft-cost')).toHaveTextContent('gpt-5.4-mini · $0.0012')
    // The draft opens the disclosure, so the fields it would fill are in view.
    expect(briefToggle()).toHaveAttribute('aria-expanded', 'true')
    expect(briefLines()).toEqual(['', '', '', '', ''])
    const request = calls.find(([channel]) => channel === 'ai:draftBrief')?.[1] as
      Input<'ai:draftBrief'> | undefined
    expect(request?.nodeId).toBe('sc-1')
    expect(request?.requestId).toEqual(expect.any(String))

    await userEvent.click(screen.getByRole('button', { name: 'Use draft' }))
    expect(briefLines()).toEqual([DRAFTED.goal, DRAFTED.conflict, DRAFTED.turn, DRAFTED.beat, ''])
    expect(screen.queryByRole('group', { name: 'Brief draft' })).not.toBeInTheDocument()
    await act(() => useSceneMetaStore.getState().flush())
    expect(sets).toEqual([
      {
        id: 'sc-1',
        meta: { location: 'dark-forest', pov: 'mara', timeline: 'Day 1', brief: DRAFTED }
      }
    ])
    await waitFor(() =>
      expect(settlements(calls)).toEqual([{ id: 'prop-1', status: 'accepted', note: null }])
    )
    expect(toasts()).toEqual([])
  })

  it('shows the truncation note when the draft came from a head-cut scene', async () => {
    const { release } = install({ 'ai:draftBrief': () => drafted({ truncated: true }) })
    release()
    ready()
    render(<MetadataPane id="sc-1" />)
    await waitFor(() => expect(field('Location')).toBeEnabled())
    await userEvent.click(draftButton())
    const group = await screen.findByRole('group', { name: 'Brief draft' })
    expect(group).toHaveTextContent('Drafted from the first 20,000 characters.')
  })

  it('settles the proposal rejected on Discard and leaves the fields empty', async () => {
    const { calls, release } = install()
    release()
    ready()
    render(<MetadataPane id="sc-1" />)
    await waitFor(() => expect(field('Location')).toBeEnabled())
    await userEvent.click(draftButton())
    await screen.findByRole('group', { name: 'Brief draft' })
    await userEvent.click(screen.getByRole('button', { name: 'Discard' }))
    expect(screen.queryByRole('group', { name: 'Brief draft' })).not.toBeInTheDocument()
    expect(briefLines()).toEqual(['', '', '', '', ''])
    expect(useSceneMetaStore.getState().docs['sc-1']?.dirty).toBe(false)
    await waitFor(() =>
      expect(settlements(calls)).toEqual([{ id: 'prop-1', status: 'rejected', note: null }])
    )
  })

  it('shows an expected failure with its next step, and a cancellation silently', async () => {
    const results: AiDraftBriefResult[] = [
      {
        ok: false,
        code: 'RATE_LIMIT',
        message: 'OpenAI is rate limiting this key.',
        nextStep: 'Wait a minute and try again.',
        requestId: 'req-1'
      },
      { ok: false, code: 'CANCELLED', message: 'Cancelled.', nextStep: '', requestId: 'req-2' }
    ]
    const { release } = install({
      'ai:draftBrief': () => results.shift() ?? drafted()
    })
    release()
    ready()
    render(<MetadataPane id="sc-1" />)
    await waitFor(() => expect(field('Location')).toBeEnabled())
    await userEvent.click(draftButton())
    const error = await screen.findByTestId('brief-draft-error')
    expect(error).toHaveTextContent(
      'OpenAI is rate limiting this key. Wait a minute and try again.'
    )
    await userEvent.click(draftButton())
    await waitFor(() => expect(screen.queryByTestId('brief-draft-error')).not.toBeInTheDocument())
    expect(screen.queryByRole('group', { name: 'Brief draft' })).not.toBeInTheDocument()
    expect(toasts()).toEqual([])
  })

  it('offers no Draft with AI for a folder and names what a short scene is missing', async () => {
    const { release } = install()
    release()
    ready('sc-1', BRIEF_TEXT_MIN - 1)
    const view = render(<MetadataPane id="sc-1" />)
    await waitFor(() => expect(field('Location')).toBeEnabled())
    expect(draftButton()).toBeDisabled()
    expect(draftButton()).toHaveAttribute('title', 'Write 200 characters before asking for a brief')
    view.rerender(<MetadataPane id="ch-1" />)
    await waitFor(() => expect(field('Location')).toBeEnabled())
    expect(screen.queryByRole('button', { name: 'Draft with AI' })).not.toBeInTheDocument()
    expect(briefToggle()).toBeInTheDocument()
  })

  it('keeps Draft with AI disabled while the dial is Off', async () => {
    const { release } = install()
    release()
    ready()
    useAiSettingsStore.setState({ settings: defaultAiSettings() })
    render(<MetadataPane id="sc-1" />)
    await waitFor(() => expect(field('Location')).toBeEnabled())
    expect(draftButton()).toBeDisabled()
    expect(draftButton().getAttribute('title')).toContain('needs the AI dial at Ask or higher')
  })
})

describe('MetadataPane summary (F-5.6)', () => {
  it('shows no summary block for a node that cannot have one', async () => {
    const { release } = install()
    release()
    ready()
    render(<MetadataPane id="sc-1" />)
    await waitFor(() => expect(field('Location')).toBeEnabled())
    expect(screen.queryByRole('button', { name: 'Summary' })).not.toBeInTheDocument()
    expect(screen.queryByTestId('summary-refresh')).not.toBeInTheDocument()
    expect(toasts()).toEqual([])
  })

  it('keeps the summary collapsed until its toggle is clicked, then shows the stored row', async () => {
    const { release } = install({ 'summary:get': () => summaryState() })
    release()
    ready()
    render(<MetadataPane id="sc-1" />)
    await screen.findByRole('button', { name: 'Summary' })
    expect(summaryToggle()).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByTestId('summary-section')).not.toBeInTheDocument()
    await userEvent.click(summaryToggle())
    expect(summaryToggle()).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByTestId('summary-text')).toHaveTextContent(ROW.summary)
    expect(
      within(screen.getByTestId('summary-key-points'))
        .getAllByRole('listitem')
        .map((li) => li.textContent)
    ).toEqual(ROW.keyPoints)
    expect(
      within(screen.getByTestId('summary-characters'))
        .getAllByRole('listitem')
        .map((li) => li.textContent)
    ).toEqual(ROW.characters)
    expect(screen.getByTestId('summary-section')).toHaveTextContent('gpt-5.4-mini')
    // Opening it grows a short tag bar, the way the brief does.
    expect(useLayoutStore.getState().layout.tagBar.height).toBe(TAG_BAR_BRIEF_HEIGHT)
  })

  it('says a scene with no row yet is summarised after a pause', async () => {
    const { release } = install({ 'summary:get': () => summaryState({ summary: null }) })
    release()
    ready()
    render(<MetadataPane id="sc-1" />)
    await screen.findByRole('button', { name: 'Summary' })
    await userEvent.click(summaryToggle())
    expect(screen.getByTestId('summary-empty')).toHaveTextContent(
      'No summary yet. It is written after you pause typing.'
    )
    expect(screen.queryByTestId('summary-text')).not.toBeInTheDocument()
  })

  it('hints at a run in flight and at a summary the scene has outgrown', async () => {
    const states = [
      summaryState({ status: 'pending', stale: true }),
      summaryState({ stale: true }),
      summaryState()
    ]
    const { release } = install({ 'summary:get': () => states.shift() ?? summaryState() })
    release()
    ready()
    const view = render(<MetadataPane id="sc-1" />)
    await screen.findByRole('button', { name: 'Summary' })
    // A run in flight wins over the staleness it is about to fix.
    expect(screen.getByTestId('summary-status')).toHaveTextContent('Updating…')
    expect(refreshButton()).toBeDisabled()
    expect(refreshButton()).toHaveAttribute('title', 'A summary is already on the way')
    view.rerender(<MetadataPane id="sc-2" />)
    await waitFor(() =>
      expect(screen.getByTestId('summary-status')).toHaveTextContent('Out of date')
    )
    view.rerender(<MetadataPane id="sc-3" />)
    await waitFor(() => expect(screen.getByTestId('summary-status')).toBeEmptyDOMElement())
  })

  it('summarises now and shows what came back', async () => {
    const { calls, release } = install({
      'summary:get': () => summaryState({ summary: null, stale: true })
    })
    release()
    ready()
    render(<MetadataPane id="sc-1" />)
    await screen.findByRole('button', { name: 'Summary' })
    await userEvent.click(summaryToggle())
    expect(screen.getByTestId('summary-empty')).toBeInTheDocument()
    await userEvent.click(refreshButton())
    await waitFor(() => expect(screen.getByTestId('summary-text')).toHaveTextContent(ROW.summary))
    const request = calls.find(([channel]) => channel === 'ai:summarize')?.[1] as
      Input<'ai:summarize'> | undefined
    expect(request?.nodeId).toBe('sc-1')
    expect(request?.requestId).toEqual(expect.any(String))
    expect(screen.getByTestId('summary-status')).toBeEmptyDOMElement()
    expect(toasts()).toEqual([])
  })

  it('shows a failed run with its next step', async () => {
    const { release } = install({
      'summary:get': () => summaryState({ summary: null }),
      'ai:summarize': () => ({
        ok: false,
        code: 'RATE_LIMIT',
        message: 'OpenAI is rate limiting this key.',
        nextStep: 'Wait a minute and try again.',
        requestId: 'req-1'
      })
    })
    release()
    ready()
    render(<MetadataPane id="sc-1" />)
    await screen.findByRole('button', { name: 'Summary' })
    await userEvent.click(summaryToggle())
    await userEvent.click(refreshButton())
    const alert = await screen.findByTestId('summary-error')
    expect(alert).toHaveTextContent(
      'OpenAI is rate limiting this key. Wait a minute and try again.'
    )
    expect(alert).toHaveAttribute('role', 'alert')
    expect(toasts()).toEqual([])
  })

  it('names what a short scene and a closed dial are missing', async () => {
    const { release } = install({ 'summary:get': () => summaryState() })
    release()
    ready('sc-1', SUMMARY_TEXT_MIN - 1)
    render(<MetadataPane id="sc-1" />)
    await screen.findByRole('button', { name: 'Summary' })
    expect(refreshButton()).toBeDisabled()
    expect(refreshButton()).toHaveAttribute(
      'title',
      'Write 200 characters before asking for a summary'
    )
    act(() => useAiSettingsStore.setState({ settings: defaultAiSettings() }))
    expect(refreshButton().getAttribute('title')).toContain('needs the AI dial at Ask or higher')
  })
})
