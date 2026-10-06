import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { defaultAiModels, defaultLocalAiSettings } from '@shared/ai'
import { defaultAiSettings } from '@shared/aiSettings'
import type { ImportDetectProgress, ImportDetectResult } from '@shared/importStructure'
import type { Channel, EventName, EventPayload, Input, Output } from '@shared/ipc/contract'
import { resetAiActivityStore } from '@renderer/features/ai/aiActivityStore'
import { resetAiSettingsStore, useAiSettingsStore } from '@renderer/features/ai/aiSettingsStore'
import { resetAiStore, useAiStore } from '@renderer/features/ai/aiStore'
import { resetProposalStore } from '@renderer/features/ai/proposalStore'
import { treeFixture } from '@renderer/features/manuscript/treeFixture'
import { useTreeStore } from '@renderer/features/manuscript/treeStore'
import { useDialogStore } from '@renderer/features/shell/dialogs/dialogStore'
import { setIpcClient, type IpcClient } from '@renderer/lib/ipc'
import { ImportDialog } from './ImportDialog'
import { draftFixture } from './draftFixture'
import { resetImportStore, useImportStore } from './importStore'

let invoke: ReturnType<typeof vi.fn<(channel: string, input: unknown) => Promise<unknown>>>
/** The listener `import:detectProgress` was subscribed with, so a test can push a chunk. */
let progress: ((payload: ImportDetectProgress) => void) | null = null

function install(overrides: Partial<Record<string, unknown>> = {}): void {
  invoke = vi.fn(async (channel: string, _input: unknown) => {
    if (channel in overrides) {
      const value = overrides[channel]
      if (value instanceof Error) throw value
      return value
    }
    if (channel === 'tree:list') return treeFixture
    if (channel === 'import:open') return draftFixture()
    if (channel === 'import:commit') return { nodes: [], words: 0 }
    if (channel === 'proposal:settle') return null
    if (channel === 'ai:cancel') return { cancelled: true }
    throw new Error(`unexpected ${channel}`)
  })
  const client: IpcClient = {
    invoke: <C extends Channel>(channel: C, input: Input<C>) =>
      invoke(channel, input) as Promise<Output<C>>,
    on<E extends EventName>(event: E, listener: (payload: EventPayload<E>) => void) {
      if (event === 'import:detectProgress') {
        progress = listener as (payload: ImportDetectProgress) => void
      }
      return () => {
        progress = null
      }
    }
  }
  setIpcClient(client)
}

/** Turns the AI pass on (F-12.3): the dial at Suggest, with a priced fast model for the estimate. */
function allowDetect(): void {
  useAiSettingsStore.setState({ settings: { ...defaultAiSettings(), dial: 2 } })
  useAiStore.setState({
    status: {
      provider: 'openai',
      hasKey: true,
      hint: 'sk-…1234',
      encryption: 'os',
      models: defaultAiModels(),
      local: defaultLocalAiSettings()
    }
  })
}

/** What main answers a finished pass with: one break inside the fixture's first scene, one title. */
const detectOk = (over: Partial<Extract<ImportDetectResult, { ok: true }>> = {}) =>
  ({
    ok: true,
    suggestions: {
      breaks: [{ before: 1, kind: 'scene', reason: 'A day passes here.' }],
      scenes: [{ start: 1, title: 'Nobody Moves', tags: ['mara'] }]
    },
    chunks: 1,
    usage: { inputTokens: 900, outputTokens: 40 },
    costUsd: 0.11,
    model: 'gpt-5.4-mini',
    promptVersion: 'importStructure.v1',
    proposalIds: ['pr-1'],
    ...over
  }) satisfies ImportDetectResult

/** Renders the dialog over a draft main has already answered with. */
async function open(): Promise<void> {
  await useImportStore.getState().open()
  render(<ImportDialog />)
}

/** The row for a node, by the id the draft gave it. */
const row = (id: string): HTMLElement => {
  const found = screen
    .getAllByTestId('import-node')
    .find((element) => element.dataset.importId === id)
  if (!found) throw new Error(`no row for ${id}`)
  return found
}

const rowTitles = (): string[] =>
  screen.getAllByTestId('import-node').map((element) => {
    const input = within(element).queryByTestId('import-rename')
    return input instanceof HTMLInputElement ? input.value : (element.textContent ?? '')
  })

beforeEach(() => {
  install()
  resetImportStore()
  resetAiSettingsStore()
  resetAiStore()
  resetAiActivityStore()
  resetProposalStore()
  progress = null
  useTreeStore.getState().clear()
  useDialogStore.setState({ modals: [], toasts: [] })
})

describe('ImportDialog (F-12.2)', () => {
  it('shows nothing until a draft is under review', () => {
    render(<ImportDialog />)
    expect(screen.queryByTestId('import-dialog')).not.toBeInTheDocument()
  })

  it('shows the draft: the question, the summary, and every part, chapter, and scene', async () => {
    await open()
    const dialog = screen.getByRole('dialog', { name: 'Import “novel.docx”' })
    expect(dialog).toHaveAttribute('aria-modal', 'true')
    expect(dialog).toHaveFocus()
    expect(screen.getByTestId('import-question')).toHaveTextContent('Does this look right?')
    expect(screen.getByTestId('import-summary')).toHaveTextContent(
      '2 parts · 2 chapters · 3 scenes · 22 words · 1 matter document'
    )
    expect(screen.getAllByTestId('import-node').map((element) => element.dataset.importId)).toEqual(
      ['p1', 'p1c1', 'p1c1s1', 'p1c1s2', 'p1c2', 'p1c2s1', 'p2', 'p2c1', 'p2c1s1']
    )
    // A scene shows its opening line and its words.
    expect(row('p1c1s1')).toHaveTextContent('The storm broke at dusk.')
    expect(row('p1c1s1')).toHaveTextContent('7')
  })

  it('renames a node inline on Enter, and leaves it alone on Escape', async () => {
    await open()
    await userEvent.click(within(row('p2c1')).getByRole('button', { name: 'Chapter Two' }))
    await userEvent.keyboard('The Return{Enter}')
    expect(useImportStore.getState().draft?.parts[1]?.chapters[0]?.title).toBe('The Return')
    expect(rowTitles()[7]).toContain('The Return')

    await userEvent.click(within(row('p1')).getByRole('button', { name: 'Part One' }))
    await userEvent.keyboard('Book One{Escape}')
    expect(useImportStore.getState().draft?.parts[0]?.title).toBe('Part One')
    expect(screen.queryByTestId('import-rename')).not.toBeInTheDocument()
  })

  it('excludes a chapter and the summary follows', async () => {
    await open()
    const exclude = within(row('p1c1')).getByTestId('import-exclude')
    expect(exclude).toHaveAccessibleName('Exclude chapter Chapter One')
    await userEvent.click(exclude)
    expect(useImportStore.getState().draft?.parts[0]?.chapters[0]?.excluded).toBe(true)
    expect(screen.getByTestId('import-summary')).toHaveTextContent('1 part · 1 chapter · 1 scene')
    expect(row('p1c1')).toHaveAttribute('data-excluded', 'true')
    // The scenes under it read as left out too.
    expect(row('p1c1s1')).toHaveAttribute('data-excluded', 'true')
  })

  it('sends a chapter to the front matter through its placement select', async () => {
    await open()
    const select = within(row('p1c2')).getByTestId('import-placement')
    expect(select).toHaveAccessibleName('Placement for Acknowledgements')
    expect(select).toHaveValue('end')
    await userEvent.selectOptions(select, 'Manuscript')
    expect(useImportStore.getState().draft?.parts[0]?.chapters[1]?.placement).toBe('manuscript')
    expect(screen.getByTestId('import-summary')).toHaveTextContent('3 chapters · 4 scenes')
  })

  it('reorders, nests, and merges through the row buttons', async () => {
    await open()
    await userEvent.click(within(row('p2')).getByRole('button', { name: 'Move Part Two up' }))
    expect(useImportStore.getState().draft?.parts.map((p) => p.id)).toEqual(['p2', 'p1'])
    await userEvent.click(
      within(row('p2c1')).getByRole('button', { name: 'Move Chapter Two to the next part' })
    )
    expect(useImportStore.getState().draft?.parts[1]?.chapters.map((c) => c.id)).toEqual([
      'p2c1',
      'p1c1',
      'p1c2'
    ])
    await userEvent.click(
      within(row('p1c1s2')).getByRole('button', { name: 'Merge Scene 2 with the scene before it' })
    )
    const chapter = useImportStore.getState().draft?.parts[1]?.chapters.find((c) => c.id === 'p1c1')
    expect(chapter?.scenes).toHaveLength(1)
    expect(chapter?.scenes[0]?.paragraphs).toHaveLength(3)
    // The first sibling cannot move up.
    expect(within(row('p2')).getByRole('button', { name: 'Move Part Two up' })).toBeDisabled()
  })

  it('splits a scene at a paragraph the author picks', async () => {
    await open()
    expect(screen.queryByTestId('import-split')).not.toBeInTheDocument()
    await userEvent.click(within(row('p2c1s1')).getByRole('button', { name: 'Split Scene 1' }))
    const splits = screen.getAllByTestId('import-split')
    expect(splits).toHaveLength(2)
    expect(splits[0]).toHaveAccessibleName('Split before paragraph 2')
    await userEvent.click(splits[1]!)
    const scenes = useImportStore.getState().draft?.parts[1]?.chapters[0]?.scenes ?? []
    expect(scenes.map((s) => s.title)).toEqual(['Scene 1', 'Scene 1 (split)'])
    expect(scenes.map((s) => s.paragraphs.length)).toEqual([2, 1])
    expect(screen.getByTestId('import-summary')).toHaveTextContent('4 scenes')
  })

  it('imports the edited draft and closes; a draft with nothing left disables Import', async () => {
    install({ 'import:commit': { nodes: [], words: 21 } })
    await open()
    await userEvent.click(within(row('p2c1')).getByRole('button', { name: 'Chapter Two' }))
    await userEvent.keyboard('The Return{Enter}')
    await userEvent.click(screen.getByTestId('import-commit'))
    await waitFor(() => expect(screen.queryByTestId('import-dialog')).not.toBeInTheDocument())
    const [channel, input] = invoke.mock.calls[1] ?? []
    expect(channel).toBe('import:commit')
    expect(input).toMatchObject({
      draft: { parts: [{ id: 'p1' }, { chapters: [{ title: 'The Return' }] }] }
    })
    expect(useDialogStore.getState().toasts.map((t) => t.message)).toEqual([
      'Imported 0 scenes (21 words)'
    ])
  })

  it('disables Import when every node is left out', async () => {
    await open()
    await userEvent.click(within(row('p1')).getByTestId('import-exclude'))
    await userEvent.click(within(row('p2')).getByTestId('import-exclude'))
    expect(screen.getByTestId('import-summary')).toHaveTextContent('0 scenes')
    expect(screen.getByTestId('import-commit')).toBeDisabled()
  })

  it('cancels on the button and on Escape, writing nothing', async () => {
    await open()
    await userEvent.keyboard('{Escape}')
    expect(useImportStore.getState().draft).toBeNull()
    expect(screen.queryByTestId('import-dialog')).not.toBeInTheDocument()

    cleanup()
    await open()
    await userEvent.click(screen.getByTestId('import-cancel'))
    expect(useImportStore.getState().draft).toBeNull()
    expect(invoke).not.toHaveBeenCalledWith('import:commit', expect.anything())
  })
})

describe('ImportDialog, the AI structure pass (F-12.3)', () => {
  it('offers the pass with what it would cost, and offers nothing when the dial is down', async () => {
    await open()
    expect(screen.queryByTestId('import-detect')).not.toBeInTheDocument()

    cleanup()
    resetImportStore()
    allowDetect()
    await open()
    expect(screen.getByTestId('import-detect-estimate')).toHaveTextContent(
      '≈ <$0.01 (22 words, 1 chunk)'
    )
    expect(screen.getByTestId('import-detect')).toHaveTextContent('Detect structure')
  })

  it('keeps the heuristic draft when the author says so, and sends nothing', async () => {
    allowDetect()
    await open()
    await userEvent.click(screen.getByTestId('import-detect-skip'))
    expect(screen.queryByTestId('import-detect')).not.toBeInTheDocument()
    expect(screen.queryByTestId('import-detect-estimate')).not.toBeInTheDocument()
    expect(invoke).not.toHaveBeenCalledWith('import:detectStructure', expect.anything())
  })

  it('shows the chunks as they land and disables every edit while the pass runs', async () => {
    let release: (result: ImportDetectResult) => void = () => {}
    install({
      'import:detectStructure': new Promise<ImportDetectResult>((resolve) => (release = resolve))
    })
    allowDetect()
    await open()
    await userEvent.click(screen.getByTestId('import-detect'))

    expect(screen.getByTestId('import-detect-progress')).toHaveTextContent(
      'Checking chunk 1 of 1 · $0.00 so far'
    )
    act(() => progress?.({ done: 1, total: 3, costUsd: 0.02 }))
    expect(screen.getByTestId('import-detect-progress')).toHaveTextContent(
      'Checking chunk 2 of 3 · $0.02 so far'
    )
    // Nothing may move under the indices the suggestions are about.
    expect(within(row('p2')).getByRole('button', { name: 'Move Part Two down' })).toBeDisabled()
    expect(within(row('p1c1s2')).getByRole('button', { name: 'Split Scene 2' })).toBeDisabled()
    expect(within(row('p1c1')).getByTestId('import-exclude')).toBeDisabled()
    expect(within(row('p1c2')).getByTestId('import-placement')).toBeDisabled()
    expect(screen.getByTestId('import-commit')).toBeDisabled()

    await userEvent.click(screen.getByTestId('import-detect-cancel'))
    expect(invoke).toHaveBeenCalledWith('ai:cancel', {
      requestId: expect.any(String) as string
    })

    release({ ok: false, code: 'CANCELLED', message: 'Stopped.', nextStep: '' })
    await waitFor(() => expect(screen.getByTestId('import-detect')).toBeInTheDocument())
  })

  it('badges what the pass added, says what it cost, and rejects a suggestion on the row', async () => {
    install({ 'import:detectStructure': detectOk() })
    allowDetect()
    await open()
    await userEvent.click(screen.getByTestId('import-detect'))

    await waitFor(() => expect(screen.getByTestId('import-detect-cost')).toBeInTheDocument())
    expect(screen.getByTestId('import-detect-cost')).toHaveTextContent(
      'AI pass cost $0.11 (estimate <$0.01) · 1 break added, 1 scene titled'
    )
    expect(screen.getByTestId('import-summary')).toHaveTextContent('4 scenes')

    const added = row('p1c1s1-x1')
    expect(added).toHaveTextContent('Nobody Moves')
    expect(within(added).getByTestId('import-ai-badge')).toHaveAttribute(
      'title',
      'A day passes here.'
    )
    // The scene it was cut out of is the author's; only the new one is badged.
    expect(within(row('p1c1s1')).queryByTestId('import-ai-badge')).not.toBeInTheDocument()

    await userEvent.click(within(added).getByTestId('import-reject'))
    expect(screen.queryAllByTestId('import-ai-badge')).toHaveLength(0)
    expect(screen.getByTestId('import-summary')).toHaveTextContent('3 scenes')
    expect(useImportStore.getState().detect?.rejected).toBe(1)
  })

  it('shows a failure with the step the author can take, and offers the pass again', async () => {
    install({
      'import:detectStructure': {
        ok: false,
        code: 'NO_KEY',
        message: 'No OpenAI key is saved.',
        nextStep: 'Add a key in Settings.'
      }
    })
    allowDetect()
    await open()
    await userEvent.click(screen.getByTestId('import-detect'))
    await waitFor(() => expect(screen.getByTestId('import-detect-error')).toBeInTheDocument())
    expect(screen.getByTestId('import-detect-error')).toHaveTextContent(
      'No OpenAI key is saved. Add a key in Settings.'
    )
    expect(screen.getByTestId('import-detect')).toHaveTextContent('Try again')
    // The draft is the author's again while the pass is not running.
    expect(screen.getByTestId('import-commit')).toBeEnabled()
  })
})
