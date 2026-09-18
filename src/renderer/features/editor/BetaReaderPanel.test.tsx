import { Editor } from '@tiptap/core'
import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AiSettings, defaultAiSettings } from '@shared/aiSettings'
import type { BetaReaderItem, BetaReaderScene } from '@shared/betaReader'
import type { AiBetaReaderResult, Channel, Input, Output } from '@shared/ipc/contract'
import { resetAiActivityStore } from '@renderer/features/ai/aiActivityStore'
import { resetAiSettingsStore, useAiSettingsStore } from '@renderer/features/ai/aiSettingsStore'
import { resetProposalStore } from '@renderer/features/ai/proposalStore'
import { resetPendingSaves } from '@renderer/features/project/pendingSaves'
import { useDialogStore } from '@renderer/features/shell/dialogs/dialogStore'
import { resetTagStore } from '@renderer/features/tags/tagStore'
import { setIpcClient, type IpcClient } from '@renderer/lib/ipc'
import { BETA_READER_PASSAGE_GONE_MESSAGE, BetaReaderPanel } from './BetaReaderPanel'
import { resetBetaReaderStore, useBetaReaderStore } from './betaReaderStore'
import { resetDocumentStore } from './documentStore'
import { buildExtensions } from './extensions'

interface PendingRead {
  input: Input<'ai:betaReader'>
  resolve: (result: AiBetaReaderResult) => void
}

const FIRST = 'The storm broke at dusk. Rain followed.'
const SECOND = 'Nobody answered him, and the quiet held on after.'

let editor: Editor
let requests: PendingRead[]
let settles: Input<'proposal:settle'>[]
let cancels: string[]
let stored: AiSettings

const SCENES: BetaReaderScene[] = [
  { nodeId: 'sc-0', title: 'Chapter 1 › Opening', current: false },
  { nodeId: 'sc-1', title: 'Chapter 1 › The Ferry', current: true }
]

const item = (over: Partial<BetaReaderItem> = {}): BetaReaderItem => ({
  category: 'expects',
  scene: 2,
  quote: 'Rain followed.',
  note: 'The reader expects the weather to matter.',
  ...over
})

const EARLIER = item({
  category: 'knows',
  scene: 1,
  quote: 'He missed the last ferry',
  note: 'The reader knows he is stranded.'
})

const ok = (requestId: string, over: Partial<Extract<AiBetaReaderResult, { ok: true }>> = {}) =>
  ({
    ok: true,
    items: [item(), EARLIER],
    scenes: SCENES,
    truncated: false,
    skipped: 0,
    missing: 0,
    dropped: 0,
    usage: { inputTokens: 1_400, outputTokens: 180 },
    costUsd: 0.03,
    cached: false,
    model: 'gpt-5.4',
    proposalId: 'p1',
    requestId,
    ...over
  }) satisfies AiBetaReaderResult

const panel = (): HTMLElement => screen.getByRole('region', { name: 'Beta reader' })
const items = (): HTMLElement[] => screen.getAllByTestId('beta-reader-item')
const groups = (): HTMLElement[] => screen.getAllByTestId('beta-reader-group')
const flush = (): Promise<void> => act(() => new Promise<void>((resolve) => setTimeout(resolve, 0)))

/** Starts a read for the rendered document and hands back the request. */
async function start(): Promise<PendingRead> {
  act(() => useBetaReaderStore.getState().start('sc-1'))
  await flush()
  const request = requests.at(-1)
  if (!request) throw new Error('no request left')
  return request
}

async function ready(
  over: Partial<Extract<AiBetaReaderResult, { ok: true }>> = {}
): Promise<PendingRead> {
  const request = await start()
  act(() => request.resolve(ok(request.input.requestId, over)))
  await flush()
  return request
}

beforeEach(() => {
  resetTagStore()
  resetBetaReaderStore()
  resetDocumentStore()
  resetAiActivityStore()
  resetAiSettingsStore()
  resetProposalStore()
  resetPendingSaves()
  useDialogStore.setState({ modals: [], toasts: [] })
  requests = []
  settles = []
  cancels = []
  stored = defaultAiSettings()
  const client: IpcClient = {
    async invoke<C extends Channel>(channel: C, input: Input<C>): Promise<Output<C>> {
      if (channel === 'ai:betaReader') {
        return new Promise<Output<C>>((resolve) => {
          requests.push({
            input: input as Input<'ai:betaReader'>,
            resolve: (result) => resolve(result as Output<C>)
          })
        })
      }
      if (channel === 'aiSettings:get') return stored as Output<C>
      if (channel === 'aiSettings:set') {
        stored = AiSettings.parse(input)
        return stored as Output<C>
      }
      if (channel === 'proposal:settle') {
        settles.push(input as Input<'proposal:settle'>)
        return null as Output<C>
      }
      if (channel === 'ai:cancel') {
        cancels.push((input as Input<'ai:cancel'>).requestId)
        return { cancelled: true } as Output<C>
      }
      throw new Error(`unexpected ${channel}`)
    },
    on: () => () => {}
  }
  setIpcClient(client)
  editor = new Editor({
    extensions: buildExtensions({ sceneBreak: '~~~', onSave: () => {}, inlineTagNodeId: 'sc-1' }),
    content: {
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: FIRST }] },
        { type: 'paragraph', content: [{ type: 'text', text: SECOND }] }
      ]
    }
  })
})
afterEach(() => {
  resetBetaReaderStore()
  resetDocumentStore()
  resetAiActivityStore()
  resetAiSettingsStore()
  resetProposalStore()
  resetPendingSaves()
  if (!editor.isDestroyed) editor.destroy()
  setIpcClient(null)
})

describe('BetaReaderPanel (F-14.11)', () => {
  it('renders nothing without a read, or for another document', async () => {
    render(<BetaReaderPanel id="sc-2" editor={editor} />)
    expect(screen.queryByTestId('beta-reader-panel')).not.toBeInTheDocument()
    await start()
    expect(screen.queryByTestId('beta-reader-panel')).not.toBeInTheDocument()
  })

  it('shows the pending state with Stop, which cancels and closes the panel', async () => {
    render(<BetaReaderPanel id="sc-1" editor={editor} />)
    const request = await start()
    expect(panel()).toHaveAttribute('data-testid', 'beta-reader-panel')
    expect(screen.getByTestId('beta-reader-pending')).toHaveTextContent(
      'Your beta reader is reading up to here.'
    )
    expect(screen.getByTestId('beta-reader-honesty')).toBeInTheDocument()
    await userEvent.click(screen.getByTestId('beta-reader-stop'))
    expect(screen.queryByTestId('beta-reader-panel')).not.toBeInTheDocument()
    expect(cancels).toEqual([request.input.requestId])
  })

  it('groups the items by category in order, with the label as a heading and the cost line', async () => {
    render(<BetaReaderPanel id="sc-1" editor={editor} />)
    await ready({
      cached: true,
      dropped: 2,
      items: [item(), EARLIER, item({ category: 'confusion', note: 'Why the ferry?' })]
    })
    // `knows` comes before `expects`, whatever order the model answered in; `believes` is empty.
    expect(groups().map((group) => group.getAttribute('data-category'))).toEqual([
      'knows',
      'expects',
      'confusion'
    ])
    expect(groups()[0]).toHaveTextContent('Knows')
    expect(groups()[2]).toHaveTextContent('Confused')
    expect(items()).toHaveLength(3)
    expect(items()[0]).toHaveAttribute('data-category', 'knows')
    expect(items()[0]).toHaveTextContent('The reader knows he is stranded.')
    expect(screen.getByTestId('beta-reader-cost')).toHaveTextContent(
      'gpt-5.4 · $0.0300 · 1,400 in · 180 out · cached'
    )
    expect(screen.getByTestId('beta-reader-dropped')).toHaveTextContent('2 uncited items dropped')
    expect(screen.queryByTestId('beta-reader-truncated')).not.toBeInTheDocument()
  })

  it('shows an item from this scene as a Show button and an earlier one with its scene chip', async () => {
    render(<BetaReaderPanel id="sc-1" editor={editor} />)
    await ready()
    const quotes = screen.getAllByTestId('beta-reader-quote')
    // The earlier scene's item is grouped first (`knows`), and its quote is not clickable.
    expect(quotes[0]?.tagName).toBe('P')
    expect(screen.getByTestId('beta-reader-scene')).toHaveTextContent('Chapter 1 › Opening')
    expect(quotes[1]?.tagName).toBe('BUTTON')
    await userEvent.click(quotes[1]!)
    const { from, to } = editor.state.selection
    expect(editor.state.doc.textBetween(from, to)).toBe('Rain followed.')
  })

  it('marks an item stale when its passage is gone from the scene', async () => {
    render(<BetaReaderPanel id="sc-1" editor={editor} />)
    await ready({ items: [item({ quote: 'The lighthouse blinked twice.' })] })
    await userEvent.click(screen.getByTestId('beta-reader-quote'))
    expect(screen.getByTestId('beta-reader-stale')).toHaveTextContent(
      BETA_READER_PASSAGE_GONE_MESSAGE
    )
    expect(editor.state.doc.firstChild?.textContent).toBe(FIRST)
  })

  it('says what the reader could not read, and when it had nothing to report', async () => {
    render(<BetaReaderPanel id="sc-1" editor={editor} />)
    await ready({ items: [], truncated: true, skipped: 3, missing: 1 })
    expect(screen.getByTestId('beta-reader-truncated')).toHaveTextContent(
      'Only the first 20,000 characters of this scene were read.'
    )
    expect(screen.getByTestId('beta-reader-skipped')).toHaveTextContent(
      'The reader skipped the first 3 scenes to fit the budget'
    )
    expect(screen.getByTestId('beta-reader-missing')).toHaveTextContent(
      '1 earlier scene has no summary yet; turn on Scene summaries and open it so the reader can read it'
    )
    expect(screen.getByTestId('beta-reader-empty')).toHaveTextContent(
      'The reader had nothing to report.'
    )
    expect(screen.queryByTestId('beta-reader-item')).not.toBeInTheDocument()
  })

  it('the honesty select writes the setting', async () => {
    render(<BetaReaderPanel id="sc-1" editor={editor} />)
    await act(() => useAiSettingsStore.getState().load())
    await ready()
    const select = screen.getByTestId('beta-reader-honesty')
    expect(select).toHaveValue('direct')
    await userEvent.selectOptions(select, 'brutal')
    expect(useAiSettingsStore.getState().settings?.critique.honesty).toBe('brutal')
  })

  it('Read again… asks for a note, settles the shown proposal, and sends it again', async () => {
    render(<BetaReaderPanel id="sc-1" editor={editor} />)
    await ready()
    await userEvent.click(screen.getByTestId('beta-reader-regenerate'))
    const modal = useDialogStore.getState().modals[0]
    if (modal?.kind !== 'prompt') throw new Error('expected a prompt')
    expect(modal.options.title).toBe('What should the reader do differently?')
    expect(modal.options.validate?.('x'.repeat(301))).toBe('Keep the note under 300 characters.')
    act(() => useDialogStore.getState().resolvePrompt(modal.id, '  Skip the prologue.  '))
    await flush()
    expect(settles).toEqual([{ id: 'p1', status: 'regenerated', note: 'Skip the prologue.' }])
    expect(requests).toHaveLength(2)
    expect(requests[1]?.input).toMatchObject({
      note: 'Skip the prologue.',
      regeneratedFrom: 'p1'
    })
    expect(screen.getByTestId('beta-reader-pending')).toBeInTheDocument()
  })

  it('Close settles the proposal as declined and clears the panel', async () => {
    render(<BetaReaderPanel id="sc-1" editor={editor} />)
    await ready()
    await userEvent.click(screen.getByTestId('beta-reader-close'))
    expect(screen.queryByTestId('beta-reader-panel')).not.toBeInTheDocument()
    await flush()
    expect(settles).toEqual([{ id: 'p1', status: 'rejected', note: null }])
  })

  it('shows a failure with its next step and Close', async () => {
    render(<BetaReaderPanel id="sc-1" editor={editor} />)
    const request = await start()
    act(() =>
      request.resolve({
        ok: false,
        code: 'RATE_LIMIT',
        message: 'OpenAI is rate-limiting this key.',
        nextStep: 'Wait a minute and try again.',
        requestId: request.input.requestId
      })
    )
    await flush()
    expect(screen.getByRole('alert')).toHaveTextContent(
      'OpenAI is rate-limiting this key. Wait a minute and try again.'
    )
    expect(screen.getByTestId('beta-reader-error')).toBeInTheDocument()
    expect(useDialogStore.getState().toasts).toEqual([])
    await userEvent.click(screen.getByTestId('beta-reader-close'))
    expect(screen.queryByTestId('beta-reader-panel')).not.toBeInTheDocument()
    expect(settles).toEqual([])
  })
})
