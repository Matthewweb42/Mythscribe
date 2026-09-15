import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it } from 'vitest'
import type { Channel, Input, Output, ProvenanceReport, TreeNode } from '@shared/ipc/contract'
import { buildIndex, useTreeStore } from '@renderer/features/manuscript/treeStore'
import { useDialogStore } from '@renderer/features/shell/dialogs/dialogStore'
import { IpcRequestError, setIpcClient, type IpcClient } from '@renderer/lib/ipc'
import { ProvenanceSection } from './ProvenanceSection'
import { resetProvenanceStore, useProvenanceStore } from './provenanceStore'

const EMPTY: ProvenanceReport = {
  projectPercent: 0,
  aiChars: 0,
  totalChars: 1_200,
  documents: [
    { id: 'scene-1', title: 'Scene 1', aiChars: 0, totalChars: 1_200, percent: 0, proposals: 0 }
  ]
}

const SOME: ProvenanceReport = {
  projectPercent: 12,
  aiChars: 1_234,
  totalChars: 10_000,
  documents: [
    { id: 'scene-1', title: 'Scene 1', aiChars: 0, totalChars: 4_000, percent: 0, proposals: 0 },
    {
      id: 'scene-2',
      title: 'Scene 2',
      aiChars: 1_233,
      totalChars: 5_000,
      percent: 25,
      proposals: 2
    },
    { id: 'scene-3', title: 'Scene 3', aiChars: 1, totalChars: 1_000, percent: 0, proposals: 1 }
  ]
}

const node = (id: string, title: string): TreeNode => ({
  id,
  parentId: 'ms',
  sectionType: null,
  kind: 'document',
  hierarchyLevel: 'scene',
  title,
  position: 0,
  wordCount: 0,
  matterType: null,
  preset: null,
  created: '2026-09-15T08:00:00.000Z',
  modified: '2026-09-15T08:00:00.000Z'
})

interface Fake {
  client: IpcClient
  calls: { channel: Channel; input: unknown }[]
  report: ProvenanceReport
  exportAnswer: () => Promise<{ path: string } | null>
}

function fakeClient(report: ProvenanceReport): Fake {
  const calls: Fake['calls'] = []
  const fake: Fake = {
    calls,
    report,
    exportAnswer: () => Promise.resolve({ path: '/home/mara/Book-ai-disclosure.md' }),
    client: {
      async invoke<C extends Channel>(channel: C, input: Input<C>): Promise<Output<C>> {
        calls.push({ channel, input })
        switch (channel) {
          case 'provenance:report':
            return fake.report as Output<C>
          case 'provenance:export':
            return (await fake.exportAnswer()) as Output<C>
          default:
            throw new Error(`unexpected ${channel}`)
        }
      },
      on: () => () => {}
    }
  }
  return fake
}

let fake: Fake
const toasts = (): string[] => useDialogStore.getState().toasts.map((t) => t.message)
const exportButton = (): HTMLElement =>
  screen.getByRole('button', { name: 'Export disclosure report' })

async function open(report: ProvenanceReport): Promise<void> {
  fake = fakeClient(report)
  setIpcClient(fake.client)
  render(<ProvenanceSection />)
  await waitFor(() => expect(useProvenanceStore.getState().report).not.toBeNull())
}

beforeEach(() => {
  resetProvenanceStore()
  useDialogStore.setState({ modals: [], toasts: [] })
  useTreeStore.setState({
    ...buildIndex([
      node('scene-1', 'Scene 1'),
      node('scene-2', 'Scene 2'),
      node('scene-3', 'Scene 3')
    ]),
    selectedId: null
  })
})

describe('ProvenanceSection (F-14.6)', () => {
  it('loads the report on mount and says so when nothing was accepted', async () => {
    await open(EMPTY)
    expect(fake.calls).toEqual([{ channel: 'provenance:report', input: undefined }])
    const section = screen.getByTestId('provenance-section')
    expect(within(section).getByRole('heading', { name: 'Provenance' })).toBeInTheDocument()
    expect(screen.getByTestId('provenance-empty')).toHaveTextContent(
      'Nothing accepted from the AI yet.'
    )
    expect(screen.queryByTestId('provenance-percent')).not.toBeInTheDocument()
    expect(screen.queryByRole('list', { name: 'AI origin by scene' })).not.toBeInTheDocument()
    expect(exportButton()).toBeEnabled()
  })

  it('shows the project share and lists only the scenes that carry AI text, in tree order', async () => {
    await open(SOME)
    expect(screen.getByTestId('provenance-percent')).toHaveTextContent(
      '12% of the manuscript is AI-origin (1,234 characters of 10,000 characters).'
    )
    const rows = within(screen.getByRole('list', { name: 'AI origin by scene' })).getAllByRole(
      'listitem'
    )
    expect(rows.map((row) => row.getAttribute('data-id'))).toEqual(['scene-2', 'scene-3'])
    expect(rows[0]).toHaveTextContent('Scene 2')
    expect(rows[0]).toHaveTextContent('25% AI · 1,233 characters · 2 proposals')
    expect(rows[1]).toHaveTextContent('0% AI · 1 character · 1 proposal')
    expect(screen.queryByTestId('provenance-empty')).not.toBeInTheDocument()
  })

  it('a scene title selects that scene in the tree', async () => {
    await open(SOME)
    await userEvent.click(screen.getByRole('button', { name: 'Scene 3' }))
    expect(useTreeStore.getState().selectedId).toBe('scene-3')
  })

  it('exports through the dialog and toasts where the file went', async () => {
    await open(SOME)
    await userEvent.click(exportButton())
    await waitFor(() => expect(toasts()).toEqual(['Saved to /home/mara/Book-ai-disclosure.md']))
    expect(fake.calls.at(-1)).toEqual({ channel: 'provenance:export', input: undefined })
    expect(exportButton()).toBeEnabled()
  })

  it('says nothing when the dialog is cancelled and toasts a failed write', async () => {
    await open(SOME)
    fake.exportAnswer = () => Promise.resolve(null)
    await userEvent.click(exportButton())
    await waitFor(() => expect(exportButton()).toBeEnabled())
    expect(toasts()).toEqual([])
    fake.exportAnswer = () =>
      Promise.reject(new IpcRequestError({ code: 'IO', message: 'EACCES: permission denied' }))
    await userEvent.click(exportButton())
    await waitFor(() => expect(toasts()).toEqual(['EACCES: permission denied']))
  })

  it('toasts when the report cannot be loaded and renders nothing', async () => {
    fake = fakeClient(EMPTY)
    fake.client.invoke = () =>
      Promise.reject(new IpcRequestError({ code: 'NO_PROJECT', message: 'No project is open' }))
    setIpcClient(fake.client)
    render(<ProvenanceSection />)
    await waitFor(() => expect(toasts()).toEqual(['No project is open']))
    expect(screen.queryByTestId('provenance-section')).not.toBeInTheDocument()
  })
})
