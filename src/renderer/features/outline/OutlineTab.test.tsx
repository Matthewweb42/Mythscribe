import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Channel, Input, Output } from '@shared/ipc/contract'
import { EMPTY_SCENE_META, type SceneMeta } from '@shared/sceneMeta'
import { UNAVAILABLE_SUMMARY, type SceneSummaryState } from '@shared/summary'
import { resetSceneMetaStore } from '@renderer/features/editor/sceneMetaStore'
import { resetSummaryStore } from '@renderer/features/editor/summaryStore'
import { resetEntityStore } from '@renderer/features/entities/entityStore'
import { treeFixture } from '@renderer/features/manuscript/treeFixture'
import { buildIndex, useTreeStore } from '@renderer/features/manuscript/treeStore'
import { resetPendingSaves } from '@renderer/features/project/pendingSaves'
import { useDialogStore } from '@renderer/features/shell/dialogs/dialogStore'
import { setIpcClient, type IpcClient } from '@renderer/lib/ipc'
import { OutlineTab } from './OutlineTab'
import { resetOutlineViewStore } from './outlineViewStore'
import { resetStructureStore, useStructureStore } from './structureStore'

const meta = (over: Partial<SceneMeta>): SceneMeta => ({ ...EMPTY_SCENE_META, ...over })

const stored: Record<string, SceneMeta> = {
  'ch-1': meta({ status: 'idea', synopsis: 'Mara leaves home.' }),
  'sc-1': meta({ status: 'draft', synopsis: 'She reaches the river.' }),
  'sc-2': meta({ status: 'draft' }),
  'sc-4': meta({ status: 'final', beats: { saveTheCat: 'catalyst', threeAct: 'climax' } }),
  'sc-5': meta({ beats: { saveTheCat: 'catalyst' } }),
  'sc-6': meta({ beats: { saveTheCat: 'not-a-beat' } }),
  'ch-4': meta({ beats: { saveTheCat: 'opening-image' } })
}

/** `sc-2` has an AI summary and no synopsis; every other document has none. */
const summaries: Record<string, SceneSummaryState> = {
  'sc-2': {
    available: true,
    summary: {
      nodeId: 'sc-2',
      summary: 'Tomas refuses to row.',
      keyPoints: [],
      characters: [],
      contentHash: 'h2',
      promptVersion: 'summary.v2',
      model: 'gpt-5.4-mini',
      truncated: false,
      createdAt: '2026-10-05T10:00:00.000Z'
    },
    stale: false,
    status: 'idle',
    error: null
  }
}

let calls: [Channel, unknown][] = []

function install(): void {
  calls = []
  const client: IpcClient = {
    async invoke<C extends Channel>(channel: C, input: Input<C>): Promise<Output<C>> {
      calls.push([channel, input])
      if (channel === 'sceneMeta:get') {
        const { id } = input as Input<'sceneMeta:get'>
        return { id, meta: stored[id] ?? { ...EMPTY_SCENE_META } } as Output<C>
      }
      if (channel === 'summary:get') {
        const { id } = input as Input<'summary:get'>
        return (summaries[id] ?? UNAVAILABLE_SUMMARY) as Output<C>
      }
      if (channel === 'structure:set') return input as Output<C>
      throw new Error(`unexpected ${channel}`)
    },
    on: () => () => {}
  }
  setIpcClient(client)
}

const rows = (): HTMLElement[] => screen.getAllByTestId('outline-row')
const row = (title: string): HTMLElement => {
  const found = rows().find((r) => within(r).queryByRole('button', { name: title }) !== null)
  if (!found) throw new Error(`no row ${title}`)
  return found
}

beforeEach(() => {
  resetPendingSaves()
  resetSceneMetaStore()
  resetSummaryStore()
  resetEntityStore()
  resetStructureStore()
  resetOutlineViewStore()
  useTreeStore.setState({ ...buildIndex(treeFixture), selectedId: null, loaded: true })
  useDialogStore.setState({ modals: [], toasts: [] })
  install()
})

afterEach(() => {
  resetSceneMetaStore()
  resetSummaryStore()
  resetPendingSaves()
  setIpcClient(null)
})

describe('OutlineTab (F-11.1)', () => {
  it('lists the manuscript section in tree order with its depth, leaving out the other sections', () => {
    render(<OutlineTab />)
    expect(rows().map((r) => r.textContent)).toEqual([
      'Arc 1',
      'Chapter 1',
      'Scene 1',
      'Chapter 2',
      'Scene 2',
      'Chapter 3',
      'Scene 3',
      'Arc 2',
      'Chapter 4',
      'Scene 4',
      'Chapter 5',
      'Scene 5',
      'Chapter 6',
      'Scene 6'
    ])
    expect(rows().map((r) => r.dataset.depth)).toEqual([
      '0',
      '1',
      '2',
      '1',
      '2',
      '1',
      '2',
      '0',
      '1',
      '2',
      '1',
      '2',
      '1',
      '2'
    ])
    expect(screen.queryByRole('button', { name: 'Title Page' })).not.toBeInTheDocument()
  })

  it('shows each status dot and the synopsis, or the AI summary greyed when there is none', async () => {
    render(<OutlineTab />)
    await waitFor(() =>
      expect(within(row('Scene 1')).getByTestId('outline-synopsis')).toHaveTextContent(
        'She reaches the river.'
      )
    )
    expect(within(row('Scene 1')).getByRole('img', { name: 'Status: Draft' })).toBeInTheDocument()
    expect(within(row('Chapter 1')).getByRole('img', { name: 'Status: Idea' })).toBeInTheDocument()
    expect(within(row('Chapter 1')).getByTestId('outline-synopsis')).toHaveTextContent(
      'Mara leaves home.'
    )

    const fallback = await within(row('Scene 2')).findByTestId('outline-ai-summary')
    expect(fallback).toHaveTextContent('Tomas refuses to row.')
    expect(fallback).toHaveClass('text-fg-subtle', 'line-clamp-2')
    expect(within(fallback).getByText('AI')).toHaveAttribute(
      'title',
      'AI summary, shown until you write a synopsis'
    )
    expect(within(row('Scene 2')).queryByTestId('outline-synopsis')).not.toBeInTheDocument()
    // No synopsis, no summary, no status: the row is the title alone.
    expect(within(row('Scene 3')).queryByRole('img')).not.toBeInTheDocument()
    expect(within(row('Scene 3')).queryByTestId('outline-ai-summary')).not.toBeInTheDocument()
  })

  it('asks for summaries for documents only', async () => {
    render(<OutlineTab />)
    await waitFor(() =>
      expect(calls.filter(([c]) => c === 'summary:get').map(([, i]) => i)).toHaveLength(6)
    )
    const ids = calls
      .filter(([c]) => c === 'summary:get')
      .map(([, i]) => (i as Input<'summary:get'>).id)
    expect(ids.sort()).toEqual(['sc-1', 'sc-2', 'sc-3', 'sc-4', 'sc-5', 'sc-6'])
  })

  it('opens a node on a title click and marks it current', async () => {
    render(<OutlineTab />)
    await userEvent.click(screen.getByRole('button', { name: 'Scene 4' }))
    expect(useTreeStore.getState().selectedId).toBe('sc-4')
    expect(screen.getByRole('button', { name: 'Scene 4' })).toHaveAttribute('aria-current', 'true')
    expect(screen.getByRole('button', { name: 'Scene 1' })).not.toHaveAttribute('aria-current')
  })

  it('counts the manuscript documents per status in the header', async () => {
    render(<OutlineTab />)
    await waitFor(() =>
      expect(screen.getByTestId('outline-counts')).toHaveTextContent('6 scenes · 2 draft · 1 final')
    )
  })

  it('says so when the manuscript is empty', () => {
    useTreeStore.setState({
      ...buildIndex(treeFixture.filter((n) => n.parentId === null || n.parentId === 'front'))
    })
    render(<OutlineTab />)
    expect(screen.getByText('The manuscript is empty.')).toBeInTheDocument()
    expect(screen.queryByTestId('outline-row')).not.toBeInTheDocument()
  })
})

describe('OutlineTab structure (F-11.1b)', () => {
  const structureSelect = (): HTMLSelectElement =>
    screen.getByRole('combobox', { name: 'Structure' })
  const beat = (id: string): HTMLElement => {
    const found = screen.getAllByTestId('beat').find((b) => b.dataset.beat === id)
    if (!found) throw new Error(`no beat ${id}`)
    return found
  }

  it('picks a template, writes it, and offers the Outline/Beats switch only while one is chosen', async () => {
    useStructureStore.setState({ template: null, loaded: true })
    render(<OutlineTab />)
    expect(structureSelect().value).toBe('')
    expect(screen.queryByRole('group', { name: 'Outline view' })).not.toBeInTheDocument()

    await userEvent.selectOptions(structureSelect(), 'Save the Cat')
    expect(calls.filter(([c]) => c === 'structure:set').map(([, i]) => i)).toEqual([
      { template: 'saveTheCat' }
    ])
    expect(useStructureStore.getState().template).toBe('saveTheCat')
    const group = screen.getByRole('group', { name: 'Outline view' })
    expect(within(group).getByRole('button', { name: 'Outline' })).toHaveAttribute(
      'aria-pressed',
      'true'
    )

    await userEvent.selectOptions(structureSelect(), 'None')
    expect(useStructureStore.getState().template).toBeNull()
    expect(screen.queryByRole('group', { name: 'Outline view' })).not.toBeInTheDocument()
  })

  it('keeps the picker disabled until the template has loaded', () => {
    render(<OutlineTab />)
    expect(structureSelect()).toBeDisabled()
  })

  it('shows the nodes under their beats in reading order, marks empty beats, and counts the rest', async () => {
    useStructureStore.setState({ template: 'saveTheCat', loaded: true })
    render(<OutlineTab />)
    await userEvent.click(screen.getByRole('button', { name: 'Beats' }))
    expect(screen.queryByTestId('outline-row')).not.toBeInTheDocument()

    await waitFor(() =>
      expect(screen.getByTestId('beat-counts')).toHaveTextContent('2 of 15 beats filled')
    )
    expect(
      within(beat('catalyst'))
        .getAllByRole('button')
        .map((b) => b.textContent)
    ).toEqual(['Scene 4', 'Scene 5'])
    expect(beat('catalyst')).toHaveAttribute('data-empty', 'false')
    expect(within(beat('opening-image')).getByRole('button', { name: 'Chapter 4' })).toBeVisible()
    expect(beat('debate')).toHaveAttribute('data-empty', 'true')
    expect(within(beat('debate')).getByText('Empty beat')).toBeInTheDocument()
    expect(within(beat('debate')).getByText('Debate')).toHaveAttribute('title')
    expect(screen.getByRole('list', { name: 'Act 1' })).toBeInTheDocument()
    // Scenes 1, 2, 3 and 6 (an id the template does not have) sit on no beat.
    expect(screen.getByTestId('beat-unplaced')).toHaveTextContent('Not on a beat: 4')

    await userEvent.click(within(beat('catalyst')).getByRole('button', { name: 'Scene 5' }))
    expect(useTreeStore.getState().selectedId).toBe('sc-5')

    await userEvent.click(screen.getByRole('button', { name: 'Outline' }))
    expect(screen.queryByTestId('beat')).not.toBeInTheDocument()
    expect(rows()).toHaveLength(14)
  })

  it('reads the other template’s assignments after a switch', async () => {
    useStructureStore.setState({ template: 'threeAct', loaded: true })
    render(<OutlineTab />)
    await userEvent.click(screen.getByRole('button', { name: 'Beats' }))
    await waitFor(() =>
      expect(screen.getByTestId('beat-counts')).toHaveTextContent('1 of 8 beats filled')
    )
    expect(within(beat('climax')).getByRole('button', { name: 'Scene 4' })).toBeInTheDocument()
  })
})
