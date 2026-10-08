import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Channel, Input, Output, Tag } from '@shared/ipc/contract'
import { EMPTY_SCENE_META, type SceneMeta } from '@shared/sceneMeta'
import { UNAVAILABLE_SUMMARY, type SceneSummaryState } from '@shared/summary'
import { resetSceneMetaStore } from '@renderer/features/editor/sceneMetaStore'
import { resetSummaryStore } from '@renderer/features/editor/summaryStore'
import { resetEntityStore } from '@renderer/features/entities/entityStore'
import { resetDocumentTagStore } from '@renderer/features/tags/documentTagStore'
import { resetTagStore, useTagStore } from '@renderer/features/tags/tagStore'
import { treeFixture } from '@renderer/features/manuscript/treeFixture'
import { buildIndex, useTreeStore } from '@renderer/features/manuscript/treeStore'
import { resetPendingSaves } from '@renderer/features/project/pendingSaves'
import { useDialogStore } from '@renderer/features/shell/dialogs/dialogStore'
import { setIpcClient, type IpcClient } from '@renderer/lib/ipc'
import { OutlineTab } from './OutlineTab'
import { resetOutlineViewStore } from './outlineViewStore'
import { resetPlanLinksStore } from './planLinksStore'
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

/** Plot threads (F-11.1c): main-plot in Scenes 1 and 4 (a gap at 2 and 3), romance in Scene 2, subplot nowhere. */
const tag = (id: string, name: string, category: Tag['category'], color: string): Tag => ({
  id,
  name,
  category,
  color,
  parentId: null,
  usageCount: 0,
  trackMentions: true,
  aliases: [],
  created: '2026-10-05T10:00:00.000Z',
  modified: '2026-10-05T10:00:00.000Z'
})
const bank: Tag[] = [
  tag('t-main', 'main-plot', 'plotThread', '#9333ea'),
  tag('t-rom', 'romance', 'plotThread', '#db2777'),
  tag('t-sub', 'subplot', 'plotThread', '#0891b2'),
  tag('t-dark', 'dark', 'tone', '#111111')
]
let links: Output<'documentTag:listAll'> = []
const LINKS: Output<'documentTag:listAll'> = [
  { nodeId: 'sc-1', tagId: 't-main' },
  { nodeId: 'sc-1', tagId: 't-dark' },
  { nodeId: 'sc-2', tagId: 't-rom' },
  { nodeId: 'sc-4', tagId: 't-main' },
  { nodeId: 'title-page', tagId: 't-sub' }
]

let calls: [Channel, unknown][] = []
let planView: Output<'planLinks:get'> = { suggestions: [], aiApplied: [] }

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
      if (channel === 'documentTag:listAll') return links as Output<C>
      // F-11.1d: the plan links the outline loads, and its writes.
      if (channel === 'planLinks:get') return planView as Output<C>
      if (channel === 'planLinks:confirm' || channel === 'planLinks:unlink') {
        return { changedNodeIds: [] } as Output<C>
      }
      if (channel === 'planLinks:dismiss') return null as Output<C>
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
  resetTagStore()
  resetDocumentTagStore()
  links = LINKS
  planView = { suggestions: [], aiApplied: [] }
  resetPlanLinksStore()
  useTreeStore.setState({ ...buildIndex(treeFixture), selectedId: null, loaded: true })
  useDialogStore.setState({ modals: [], toasts: [] })
  install()
})

afterEach(() => {
  resetSceneMetaStore()
  resetSummaryStore()
  resetPendingSaves()
  resetPlanLinksStore()
  setIpcClient(null)
})

describe('OutlineTab, planned and written (F-11.1d)', () => {
  it('marks each row Planned, Drafted, or Revised from its words and status, folders rolled up, and counts them', async () => {
    render(<OutlineTab />)
    await waitFor(() => expect(row('Scene 4')).toHaveAttribute('data-progress', 'revised'))
    expect(row('Scene 1')).toHaveAttribute('data-progress', 'drafted')
    expect(row('Scene 3')).toHaveAttribute('data-progress', 'planned')
    expect(within(row('Scene 3')).getByTestId('outline-progress-badge')).toHaveTextContent(
      'Planned'
    )
    expect(row('Chapter 3')).toHaveAttribute('data-progress', 'planned')
    expect(row('Chapter 4')).toHaveAttribute('data-progress', 'revised')
    expect(row('Arc 1')).toHaveAttribute('data-progress', 'drafted')
    expect(screen.getByTestId('outline-progress')).toHaveTextContent(
      '2 planned · 3 drafted · 1 revised'
    )
  })

  it('mirrors the binder: a new, renamed, moved, or deleted scene shows at once', () => {
    render(<OutlineTab />)
    const titles = (): (string | null | undefined)[] =>
      rows().map((r) => within(r).getAllByRole('button')[0]?.textContent)
    const added = {
      ...treeFixture.find((n) => n.id === 'sc-1')!,
      id: 'sc-new',
      title: 'The siege',
      position: 1,
      wordCount: 0
    }
    act(() => useTreeStore.setState(buildIndex([...treeFixture, added])))
    expect(titles().slice(0, 4)).toEqual(['Arc 1', 'Chapter 1', 'Scene 1', 'The siege'])
    expect(row('The siege')).toHaveAttribute('data-progress', 'planned')
    const renamed = treeFixture.map((n) => (n.id === 'sc-1' ? { ...n, title: 'Landing' } : n))
    act(() => useTreeStore.setState(buildIndex(renamed)))
    expect(titles()).toContain('Landing')
    const moved = treeFixture.map((n) =>
      n.id === 'sc-1' ? { ...n, parentId: 'ch-2', position: 1 } : n
    )
    act(() => useTreeStore.setState(buildIndex(moved)))
    expect(titles().slice(0, 5)).toEqual(['Arc 1', 'Chapter 1', 'Chapter 2', 'Scene 2', 'Scene 1'])
    act(() => useTreeStore.setState(buildIndex(treeFixture.filter((n) => n.id !== 'sc-1'))))
    expect(titles()).not.toContain('Scene 1')
  })

  it('shows a confirmed link both ways, with Unlink, and the AI mark on one the AI applied', async () => {
    stored['sc-3'] = meta({ fulfilledBy: 'sc-2' })
    planView = { suggestions: [], aiApplied: ['scene:sc-3>sc-2'] }
    try {
      render(<OutlineTab />)
      const fulfilled = await within(row('Scene 3')).findByTestId('outline-fulfilled')
      expect(fulfilled).toHaveTextContent('Fulfilled by Scene 2')
      expect(within(fulfilled).getByText('AI')).toHaveAttribute('title', 'Linked by the AI')
      expect(within(row('Scene 2')).getByTestId('outline-fulfils')).toHaveTextContent(
        'Fulfils plan Scene 3'
      )
      await userEvent.click(within(fulfilled).getByRole('button', { name: 'Unlink' }))
      await waitFor(() =>
        expect(calls).toContainEqual([
          'planLinks:unlink',
          { plan: { kind: 'scene', nodeId: 'sc-3' } }
        ])
      )
    } finally {
      delete stored['sc-3']
    }
  })

  it('lists the AI’s suggestions on their rows with Confirm and Dismiss', async () => {
    planView = {
      suggestions: [
        { plan: { kind: 'scene', nodeId: 'sc-5' }, sceneId: 'sc-6', reason: 'Same beat.' },
        {
          plan: { kind: 'beat', template: 'saveTheCat', beatId: 'finale' },
          sceneId: 'sc-1',
          reason: ''
        }
      ],
      aiApplied: []
    }
    render(<OutlineTab />)
    const planned = await within(row('Scene 5')).findByRole('group', { name: 'Suggested link' })
    expect(planned).toHaveTextContent('Fulfilled by Scene 6?')
    expect(planned).toHaveTextContent('Same beat.')
    const beat = within(row('Scene 1')).getByRole('group', { name: 'Suggested link' })
    expect(beat).toHaveTextContent('On the beat Finale?')
    await userEvent.click(within(planned).getByRole('button', { name: 'Confirm' }))
    await waitFor(() =>
      expect(calls).toContainEqual(['planLinks:confirm', { key: 'scene:sc-5>sc-6' }])
    )
    await userEvent.click(within(beat).getByRole('button', { name: 'Dismiss' }))
    await waitFor(() =>
      expect(calls).toContainEqual(['planLinks:dismiss', { key: 'beat:saveTheCat:finale>sc-1' }])
    )
  })
})

describe('OutlineTab (F-11.1)', () => {
  it('lists the manuscript section in tree order with its depth, leaving out the other sections', () => {
    render(<OutlineTab />)
    expect(rows().map((r) => within(r).getAllByRole('button')[0]?.textContent)).toEqual([
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

  it('picks a template, writes it, and offers Beats only while one is chosen', async () => {
    useStructureStore.setState({ template: null, loaded: true })
    render(<OutlineTab />)
    expect(structureSelect().value).toBe('')
    expect(
      within(screen.getByRole('group', { name: 'Outline view' }))
        .getAllByRole('button')
        .map((b) => b.textContent)
    ).toEqual(['Outline', 'Threads'])

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

    await userEvent.click(within(group).getByRole('button', { name: 'Beats' }))
    await userEvent.selectOptions(structureSelect(), 'None')
    expect(useStructureStore.getState().template).toBeNull()
    expect(screen.queryByRole('button', { name: 'Beats' })).not.toBeInTheDocument()
    // The Beats choice reads as the outline once there is no template.
    expect(screen.getByRole('button', { name: 'Outline' })).toHaveAttribute('aria-pressed', 'true')
    expect(rows()).toHaveLength(14)
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

describe('OutlineTab plot threads (F-11.1c)', () => {
  const threadRow = (id: string): HTMLElement => {
    const found = screen.getAllByTestId('thread-row').find((r) => r.dataset.node === id)
    if (!found) throw new Error(`no thread row ${id}`)
    return found
  }
  const states = (id: string): (string | undefined)[] =>
    Array.from(threadRow(id).querySelectorAll('td')).map((td) => td.dataset.state)

  it('lays the manuscript against its plot threads in reading order and marks the gaps', async () => {
    for (const t of bank) useTagStore.getState().merge(t)
    render(<OutlineTab />)
    await userEvent.click(screen.getByRole('button', { name: 'Threads' }))
    expect(calls.filter(([c]) => c === 'documentTag:listAll')).toHaveLength(1)

    const table = await screen.findByRole('table', { name: 'Plot threads' })
    expect(
      within(table)
        .getAllByRole('columnheader')
        .map((h) => h.textContent)
    ).toEqual(['Scene', 'main-plot', 'romance'])
    await waitFor(() => expect(states('sc-1')).toEqual(['on', 'off']))
    expect(states('sc-2')).toEqual(['gap', 'on'])
    expect(states('sc-3')).toEqual(['gap', 'off'])
    expect(states('sc-4')).toEqual(['on', 'off'])
    expect(states('sc-5')).toEqual(['off', 'off'])
    // A folder is a heading row with no cells.
    expect(states('ch-1')).toEqual([undefined, undefined])
    expect(screen.getByTestId('thread-counts')).toHaveTextContent('2 threads · 2 gaps')
    expect(screen.getAllByTestId('thread-summary').map((li) => li.textContent)).toEqual([
      '#main-plot 2 scenes, 2 gaps',
      '#romance 1 scene, 0 gaps'
    ])
    // subplot is linked only outside the manuscript.
    expect(screen.getByTestId('thread-unused')).toHaveTextContent('Not in any scene: #subplot')

    await userEvent.click(within(threadRow('sc-4')).getByRole('button', { name: 'Scene 4' }))
    expect(useTreeStore.getState().selectedId).toBe('sc-4')
  })

  it('says how to start when the bank has no plot threads, and when no scene carries one', async () => {
    render(<OutlineTab />)
    await userEvent.click(screen.getByRole('button', { name: 'Threads' }))
    expect(screen.getByText(/No plot threads yet/)).toBeInTheDocument()

    for (const t of bank) useTagStore.getState().merge(t)
    links = []
    await userEvent.click(screen.getByRole('button', { name: 'Outline' }))
    await userEvent.click(screen.getByRole('button', { name: 'Threads' }))
    await waitFor(() =>
      expect(screen.getByTestId('thread-counts')).toHaveTextContent(
        'No scene carries a plot thread yet.'
      )
    )
    expect(screen.queryByRole('table')).not.toBeInTheDocument()
  })
})
