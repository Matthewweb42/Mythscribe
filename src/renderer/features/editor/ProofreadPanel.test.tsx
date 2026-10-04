import { Editor } from '@tiptap/core'
import { act, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AiProofreadResult, Channel, Input, Output } from '@shared/ipc/contract'
import type { ProofreadFix } from '@shared/proofread'
import { resetAiActivityStore } from '@renderer/features/ai/aiActivityStore'
import { resetProposalStore } from '@renderer/features/ai/proposalStore'
import { resetPendingSaves } from '@renderer/features/project/pendingSaves'
import { useDialogStore } from '@renderer/features/shell/dialogs/dialogStore'
import { resetTagStore } from '@renderer/features/tags/tagStore'
import { setIpcClient, type IpcClient } from '@renderer/lib/ipc'
import { resetDocumentStore } from './documentStore'
import { buildExtensions } from './extensions'
import { PROOFREAD_GONE_MESSAGE, ProofreadPanel } from './ProofreadPanel'
import { resetProofreadStore, useProofreadStore } from './proofreadStore'
import { resetRewriteStore, useRewriteStore } from './rewriteStore'

interface PendingProofread {
  input: Input<'ai:proofread'>
  resolve: (result: AiProofreadResult) => void
}

const FIRST = 'The strom broke at dusk. Rain folowed.'
const SECOND = 'Nobody answered him, and the the quiet held.'

let editor: Editor
let requests: PendingProofread[]
let settles: Input<'proposal:settle'>[]
let cancels: string[]

const fix = (over: Partial<ProofreadFix> = {}): ProofreadFix => ({
  kind: 'spelling',
  quote: 'The strom broke',
  fix: 'The storm broke',
  flagged: false,
  violation: null,
  ...over
})
const DOUBLED = fix({ kind: 'doubledWord', quote: 'and the the quiet', fix: 'and the quiet' })

const ok = (requestId: string, over: Partial<Extract<AiProofreadResult, { ok: true }>> = {}) =>
  ({
    ok: true,
    fixes: [fix(), DOUBLED],
    scope: 'scene',
    truncated: false,
    dropped: 0,
    usage: { inputTokens: 700, outputTokens: 90 },
    costUsd: 0.001,
    cached: false,
    model: 'gpt-5.4-mini',
    proposalId: 'p1',
    requestId,
    ...over
  }) satisfies AiProofreadResult

const panel = (): HTMLElement => screen.getByRole('region', { name: 'Proofread' })
const cards = (): HTMLElement[] => screen.getAllByTestId('proofread-fix')
const flush = (): Promise<void> => act(() => new Promise<void>((resolve) => setTimeout(resolve, 0)))
const paragraphs = (): string[] => {
  const out: string[] = []
  editor.state.doc.forEach((p) => out.push(p.textContent))
  return out
}

async function start(): Promise<PendingProofread> {
  act(() => useProofreadStore.getState().start('sc-1', editor))
  await flush()
  const request = requests.at(-1)
  if (!request) throw new Error('no request left')
  return request
}

async function ready(
  over: Partial<Extract<AiProofreadResult, { ok: true }>> = {}
): Promise<PendingProofread> {
  const request = await start()
  act(() => request.resolve(ok(request.input.requestId, over)))
  await flush()
  return request
}

beforeEach(() => {
  resetTagStore()
  resetProofreadStore()
  resetRewriteStore()
  resetDocumentStore()
  resetAiActivityStore()
  resetProposalStore()
  resetPendingSaves()
  useDialogStore.setState({ modals: [], toasts: [] })
  requests = []
  settles = []
  cancels = []
  const client: IpcClient = {
    async invoke<C extends Channel>(channel: C, input: Input<C>): Promise<Output<C>> {
      if (channel === 'ai:proofread') {
        return new Promise<Output<C>>((resolve) => {
          requests.push({
            input: input as Input<'ai:proofread'>,
            resolve: (result) => resolve(result as Output<C>)
          })
        })
      }
      if (channel === 'ai:rewrite') return new Promise<Output<C>>(() => {})
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
  resetProofreadStore()
  resetRewriteStore()
  resetDocumentStore()
  resetAiActivityStore()
  resetProposalStore()
  resetPendingSaves()
  useDialogStore.setState({ modals: [], toasts: [] })
  if (!editor.isDestroyed) editor.destroy()
  setIpcClient(null)
})

describe('ProofreadPanel (F-14.12)', () => {
  it('renders nothing without a pass, or for another document', async () => {
    render(<ProofreadPanel id="sc-2" editor={editor} />)
    expect(screen.queryByTestId('proofread-panel')).not.toBeInTheDocument()
    await start()
    expect(screen.queryByTestId('proofread-panel')).not.toBeInTheDocument()
  })

  it('shows the pending state with Stop, which cancels and closes the panel', async () => {
    render(<ProofreadPanel id="sc-1" editor={editor} />)
    const request = await start()
    expect(panel()).toHaveAttribute('data-testid', 'proofread-panel')
    expect(screen.getByTestId('proofread-pending')).toBeInTheDocument()
    expect(screen.getByTestId('proofread-scope')).toHaveTextContent('Scene')
    await userEvent.click(screen.getByTestId('proofread-stop'))
    expect(screen.queryByTestId('proofread-panel')).not.toBeInTheDocument()
    expect(cancels).toEqual([request.input.requestId])
  })

  it('shows one card per fix with its kind, quote, diff, flag, and the cost line', async () => {
    render(<ProofreadPanel id="sc-1" editor={editor} />)
    await ready({
      fixes: [fix({ flagged: true, violation: 'uses a banned phrase' }), DOUBLED],
      cached: true
    })
    expect(cards()).toHaveLength(2)
    const [spelling, doubled] = cards()
    expect(spelling).toHaveAttribute('data-kind', 'spelling')
    expect(spelling).toHaveAttribute('data-state', 'open')
    expect(spelling).toHaveTextContent('Spelling')
    expect(within(spelling!).getByTestId('proofread-quote')).toHaveTextContent('The strom broke')
    const diff = within(spelling!).getByTestId('proofread-fix-diff')
    expect(Array.from(diff.querySelectorAll('del')).map((el) => el.textContent)).toEqual(['strom'])
    expect(Array.from(diff.querySelectorAll('ins')).map((el) => el.textContent)).toEqual(['storm'])
    expect(within(spelling!).getByTestId('proofread-flag')).toHaveTextContent(
      'uses a banned phrase'
    )
    expect(doubled).toHaveTextContent('Doubled word')
    expect(within(doubled!).queryByTestId('proofread-flag')).not.toBeInTheDocument()
    expect(screen.getByTestId('proofread-cost')).toHaveTextContent('gpt-5.4-mini')
    expect(screen.getByTestId('proofread-cost')).toHaveTextContent('cached')
    expect(screen.getByTestId('proofread-scope')).toHaveTextContent('Scene')
    expect(screen.queryByTestId('proofread-truncated')).not.toBeInTheDocument()
  })

  it('says when the text was cut, the scope, and when there is nothing to fix', async () => {
    render(<ProofreadPanel id="sc-1" editor={editor} />)
    await ready({ fixes: [], truncated: true, scope: 'selection' })
    expect(screen.getByTestId('proofread-truncated')).toHaveTextContent(
      'Proofread the first 20,000 characters; select the rest to proofread it.'
    )
    expect(screen.getByTestId('proofread-empty')).toHaveTextContent('No errors found.')
    expect(screen.getByTestId('proofread-scope')).toHaveTextContent('Selection')
    expect(screen.queryByTestId('proofread-accept-all')).not.toBeInTheDocument()
  })

  it('a click on the quote selects the passage', async () => {
    render(<ProofreadPanel id="sc-1" editor={editor} />)
    await ready()
    await userEvent.click(screen.getAllByTestId('proofread-quote')[1]!)
    const { from, to } = editor.state.selection
    expect(editor.state.doc.textBetween(from, to)).toBe('and the the quiet')
  })

  it('Accept and Reject resolve one fix each, and the proposal settles once none is open', async () => {
    render(<ProofreadPanel id="sc-1" editor={editor} />)
    await ready()
    const [first, second] = cards()
    await userEvent.click(within(first!).getByTestId('proofread-accept'))
    expect(paragraphs()[0]).toBe('The storm broke at dusk. Rain folowed.')
    expect(cards()[0]).toHaveAttribute('data-state', 'applied')
    expect(within(cards()[0]!).getByTestId('proofread-accept')).toBeDisabled()
    expect(within(cards()[0]!).getByTestId('proofread-accept')).toHaveTextContent('Accepted')
    expect(screen.getByTestId('proofread-accept-all')).toBeEnabled()
    await userEvent.click(within(second!).getByTestId('proofread-reject'))
    expect(cards()[1]).toHaveAttribute('data-state', 'rejected')
    expect(paragraphs()[1]).toBe(SECOND)
    expect(screen.getByTestId('proofread-accept-all')).toBeDisabled()
    await flush()
    expect(settles).toEqual([{ id: 'p1', status: 'acceptedPart', note: null }])
    // The panel stays until closed, and Close does not settle again.
    await userEvent.click(screen.getByTestId('proofread-close'))
    expect(screen.queryByTestId('proofread-panel')).not.toBeInTheDocument()
    await flush()
    expect(settles).toHaveLength(1)
  })

  it('Accept all applies every open fix', async () => {
    render(<ProofreadPanel id="sc-1" editor={editor} />)
    await ready()
    await userEvent.click(screen.getByTestId('proofread-accept-all'))
    expect(paragraphs()).toEqual([
      'The storm broke at dusk. Rain folowed.',
      'Nobody answered him, and the quiet held.'
    ])
    expect(cards().map((card) => card.getAttribute('data-state'))).toEqual(['applied', 'applied'])
    await flush()
    expect(settles).toEqual([{ id: 'p1', status: 'accepted', note: null }])
  })

  it('marks a fix stale when its passage is gone', async () => {
    render(<ProofreadPanel id="sc-1" editor={editor} />)
    await ready({ fixes: [fix({ quote: 'The lighthouse blinked.' }), DOUBLED] })
    await userEvent.click(within(cards()[0]!).getByTestId('proofread-accept'))
    expect(cards()[0]).toHaveAttribute('data-state', 'stale')
    expect(within(cards()[0]!).getByTestId('proofread-stale')).toHaveTextContent(
      PROOFREAD_GONE_MESSAGE
    )
    expect(within(cards()[0]!).getByTestId('proofread-accept')).toBeDisabled()
    expect(paragraphs()).toEqual([FIRST, SECOND])
  })

  it('disables Accept while a rewrite holds the editor', async () => {
    render(<ProofreadPanel id="sc-1" editor={editor} />)
    await ready()
    act(() => {
      editor.commands.setTextSelection({ from: 1, to: FIRST.length + 1 })
      useRewriteStore.getState().start('sc-1', editor)
    })
    await flush()
    for (const button of screen.getAllByTestId('proofread-accept')) expect(button).toBeDisabled()
    expect(screen.getByTestId('proofread-accept-all')).toBeDisabled()
  })

  it('shows a failure as an alert with Close', async () => {
    render(<ProofreadPanel id="sc-1" editor={editor} />)
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
    await userEvent.click(screen.getByTestId('proofread-close'))
    expect(screen.queryByTestId('proofread-panel')).not.toBeInTheDocument()
  })
})
