import { Editor } from '@tiptap/core'
import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type {
  AiRewriteResult,
  Channel,
  EventName,
  EventPayload,
  Input,
  Output
} from '@shared/ipc/contract'
import { resetAiActivityStore } from '@renderer/features/ai/aiActivityStore'
import { resetProposalStore } from '@renderer/features/ai/proposalStore'
import { useDialogStore } from '@renderer/features/shell/dialogs/dialogStore'
import { resetTagStore } from '@renderer/features/tags/tagStore'
import { setIpcClient, type IpcClient } from '@renderer/lib/ipc'
import { buildExtensions } from './extensions'
import { PASSAGE_CHANGED_MESSAGE, RewritePanel } from './RewritePanel'
import { rewriteTargetOf } from './rewriteTarget'
import { resetRewriteStore, useRewriteStore } from './rewriteStore'

interface PendingRewrite {
  input: Input<'ai:rewrite'>
  resolve: (result: AiRewriteResult) => void
}

const FIRST = 'The storm broke at dusk. Rain followed.'
const ANSWER = 'The storm came down at dusk. Rain followed.'

let editor: Editor
let requests: PendingRewrite[]
let settles: Input<'proposal:settle'>[]
let cancels: string[]
let deltaListener: ((payload: EventPayload<'ai:rewriteDelta'>) => void) | null

const ok = (requestId: string, over: Partial<Extract<AiRewriteResult, { ok: true }>> = {}) =>
  ({
    ok: true,
    text: ANSWER,
    usage: { inputTokens: 300, outputTokens: 20 },
    costUsd: 0.0002,
    cached: false,
    model: 'gpt-5.4-mini',
    flagged: false,
    violation: null,
    proposalId: 'p1',
    requestId,
    ...over
  }) satisfies AiRewriteResult

const panel = (): HTMLElement => screen.getByRole('region', { name: 'Rewrite' })
const flush = (): Promise<void> => act(() => new Promise<void>((resolve) => setTimeout(resolve, 0)))

/** Starts a rewrite of the first paragraph and hands back the request. */
async function start(): Promise<PendingRewrite> {
  editor.commands.setTextSelection({ from: 1, to: FIRST.length + 1 })
  act(() => useRewriteStore.getState().start('sc-1', editor))
  await flush()
  const request = requests.at(-1)
  if (!request) throw new Error('no request left')
  return request
}

async function ready(over: Partial<Extract<AiRewriteResult, { ok: true }>> = {}): Promise<void> {
  const request = await start()
  act(() => request.resolve(ok(request.input.requestId, over)))
  await flush()
  await waitFor(() => expect(screen.getByTestId('rewrite-diff')).toBeInTheDocument())
}

beforeEach(() => {
  resetTagStore()
  resetRewriteStore()
  resetAiActivityStore()
  resetProposalStore()
  useDialogStore.setState({ modals: [], toasts: [] })
  requests = []
  settles = []
  cancels = []
  deltaListener = null
  const client: IpcClient = {
    async invoke<C extends Channel>(channel: C, input: Input<C>): Promise<Output<C>> {
      if (channel === 'ai:rewrite') {
        return new Promise<Output<C>>((resolve) => {
          requests.push({
            input: input as Input<'ai:rewrite'>,
            resolve: (result) => resolve(result as Output<C>)
          })
        })
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
    on<E extends EventName>(event: E, listener: (payload: EventPayload<E>) => void) {
      if (event === 'ai:rewriteDelta') {
        deltaListener = listener as (payload: EventPayload<'ai:rewriteDelta'>) => void
      }
      return () => {
        deltaListener = null
      }
    }
  }
  setIpcClient(client)
  editor = new Editor({
    extensions: buildExtensions({ sceneBreak: '~~~', onSave: () => {}, inlineTagNodeId: 'sc-1' }),
    content: {
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: FIRST }] }]
    }
  })
})
afterEach(() => {
  resetRewriteStore()
  resetAiActivityStore()
  resetProposalStore()
  editor.destroy()
  setIpcClient(null)
})

describe('RewritePanel (F-14.10)', () => {
  it('renders nothing without a rewrite, or for another document', async () => {
    render(<RewritePanel id="sc-2" editor={editor} />)
    expect(screen.queryByRole('region', { name: 'Rewrite' })).not.toBeInTheDocument()
    await start()
    expect(screen.queryByRole('region', { name: 'Rewrite' })).not.toBeInTheDocument()
  })

  it('shows the streaming draft with Stop, which cancels and closes the panel', async () => {
    render(<RewritePanel id="sc-1" editor={editor} />)
    const request = await start()
    expect(panel()).toHaveAttribute('data-testid', 'rewrite-panel')
    expect(screen.getByTestId('rewrite-draft')).toHaveTextContent('Drafting…')
    act(() => deltaListener?.({ requestId: request.input.requestId, delta: 'The storm came' }))
    expect(screen.getByTestId('rewrite-draft')).toHaveTextContent('The storm came')
    expect(screen.getByTestId('rewrite-draft').className).toContain('whitespace-pre-wrap')
    expect(screen.queryByTestId('rewrite-accept')).not.toBeInTheDocument()
    await userEvent.click(screen.getByTestId('rewrite-stop'))
    expect(screen.queryByRole('region', { name: 'Rewrite' })).not.toBeInTheDocument()
    expect(cancels).toEqual([request.input.requestId])
  })

  it('shows the diff, the cost line, and Accept replaces the passage', async () => {
    render(<RewritePanel id="sc-1" editor={editor} />)
    await ready()
    const diff = screen.getByTestId('rewrite-diff')
    const parts = (tag: string): string[] =>
      Array.from(diff.querySelectorAll(tag)).map((el) => el.textContent ?? '')
    expect(parts('del')).toEqual(['broke'])
    // The word-level LCS keeps one original space, so the insertion arrives in two pieces.
    expect(parts('ins').join('').trim()).toBe('camedown')
    expect(diff).toHaveTextContent('The storm brokecame down at dusk. Rain followed.')
    expect(screen.getByTestId('rewrite-cost')).toHaveTextContent('gpt-5.4-mini · $0.0002')
    expect(screen.queryByTestId('rewrite-flag')).not.toBeInTheDocument()
    expect(screen.getByTestId('rewrite-accept')).toBeEnabled()
    await userEvent.click(screen.getByTestId('rewrite-accept'))
    expect(editor.getText()).toBe(ANSWER)
    expect(editor.view.dom.querySelector('.ai-origin[data-proposal-id="p1"]')).not.toBeNull()
    expect(screen.queryByRole('region', { name: 'Rewrite' })).not.toBeInTheDocument()
    await flush()
    expect(settles).toEqual([{ id: 'p1', status: 'accepted', note: null }])
  })

  it('shows the fidelity badge with the violation and the cached note', async () => {
    render(<RewritePanel id="sc-1" editor={editor} />)
    await ready({ flagged: true, violation: 'switches to present tense', cached: true })
    expect(screen.getByTestId('rewrite-flag')).toHaveTextContent(
      'Off-voice: switches to present tense'
    )
    expect(screen.getByTestId('rewrite-flag')).toHaveAttribute('title', 'switches to present tense')
    expect(screen.getByTestId('rewrite-cost')).toHaveTextContent('gpt-5.4-mini · $0.0002 · cached')
    expect(screen.getByTestId('rewrite-accept')).toBeEnabled()
  })

  it('Reject settles rejected and clears the highlight', async () => {
    render(<RewritePanel id="sc-1" editor={editor} />)
    await ready()
    expect(rewriteTargetOf(editor.state)).not.toBeNull()
    await userEvent.click(screen.getByTestId('rewrite-reject'))
    expect(screen.queryByRole('region', { name: 'Rewrite' })).not.toBeInTheDocument()
    expect(rewriteTargetOf(editor.state)).toBeNull()
    expect(editor.getText()).toBe(FIRST)
    await flush()
    expect(settles).toEqual([{ id: 'p1', status: 'rejected', note: null }])
  })

  it('Regenerate… asks for a note, refuses one over the limit, and sends again with it', async () => {
    render(<RewritePanel id="sc-1" editor={editor} />)
    await ready()
    await userEvent.click(screen.getByTestId('rewrite-regenerate'))
    const modal = useDialogStore.getState().modals[0]
    if (modal?.kind !== 'prompt') throw new Error('expected a prompt')
    expect(modal.options.title).toBe("What's off about this rewrite?")
    expect(modal.options.validate?.('x'.repeat(301))).toBe('Keep the note under 300 characters.')
    expect(modal.options.validate?.('Shorter.')).toBeNull()
    act(() => useDialogStore.getState().resolvePrompt(modal.id, '  Shorter.  '))
    await flush()
    expect(settles).toEqual([{ id: 'p1', status: 'regenerated', note: 'Shorter.' }])
    expect(requests).toHaveLength(2)
    expect(requests[1]?.input).toMatchObject({ note: 'Shorter.', regeneratedFrom: 'p1' })
    expect(screen.getByTestId('rewrite-draft')).toBeInTheDocument()
  })

  it('a cancelled note dialog sends nothing', async () => {
    render(<RewritePanel id="sc-1" editor={editor} />)
    await ready()
    await userEvent.click(screen.getByTestId('rewrite-regenerate'))
    const modal = useDialogStore.getState().modals[0]
    if (modal?.kind !== 'prompt') throw new Error('expected a prompt')
    act(() => useDialogStore.getState().resolvePrompt(modal.id, null))
    await flush()
    expect(settles).toEqual([])
    expect(requests).toHaveLength(1)
    expect(screen.getByTestId('rewrite-diff')).toBeInTheDocument()
  })

  it('keeps the diff but disables Accept with the reason once the passage changed', async () => {
    render(<RewritePanel id="sc-1" editor={editor} />)
    await ready()
    act(() => {
      editor.commands.insertContentAt(5, 'X')
    })
    await waitFor(() => expect(screen.getByTestId('rewrite-accept')).toBeDisabled())
    expect(screen.getByTestId('rewrite-accept')).toHaveAttribute('title', PASSAGE_CHANGED_MESSAGE)
    expect(screen.getByTestId('rewrite-invalid')).toHaveTextContent(PASSAGE_CHANGED_MESSAGE)
    expect(screen.getByTestId('rewrite-diff')).toBeInTheDocument()
    expect(screen.queryByTestId('rewrite-regenerate')).not.toBeInTheDocument()
    await userEvent.click(within(panel()).getByTestId('rewrite-reject'))
    expect(screen.queryByRole('region', { name: 'Rewrite' })).not.toBeInTheDocument()
  })

  it('shows a failure with its next step and Close', async () => {
    render(<RewritePanel id="sc-1" editor={editor} />)
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
    expect(useDialogStore.getState().toasts).toEqual([])
    await userEvent.click(screen.getByTestId('rewrite-close'))
    expect(screen.queryByRole('region', { name: 'Rewrite' })).not.toBeInTheDocument()
    expect(settles).toEqual([])
  })
})
