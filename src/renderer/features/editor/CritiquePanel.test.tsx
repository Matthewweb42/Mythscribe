import { Editor } from '@tiptap/core'
import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AiSettings, defaultAiSettings } from '@shared/aiSettings'
import type { CritiqueNote } from '@shared/critique'
import type { AiCritiqueResult, Channel, Input, Output } from '@shared/ipc/contract'
import { resetAiActivityStore } from '@renderer/features/ai/aiActivityStore'
import { resetAiSettingsStore, useAiSettingsStore } from '@renderer/features/ai/aiSettingsStore'
import { resetProposalStore } from '@renderer/features/ai/proposalStore'
import { resetPendingSaves } from '@renderer/features/project/pendingSaves'
import { useDialogStore } from '@renderer/features/shell/dialogs/dialogStore'
import { resetTagStore } from '@renderer/features/tags/tagStore'
import { setIpcClient, type IpcClient } from '@renderer/lib/ipc'
import { CritiquePanel, PASSAGE_GONE_MESSAGE, REWRITE_BUSY_MESSAGE } from './CritiquePanel'
import { resetCritiqueStore, useCritiqueStore } from './critiqueStore'
import { resetDocumentStore } from './documentStore'
import { buildExtensions } from './extensions'
import { resetRewriteStore, useRewriteStore } from './rewriteStore'

interface PendingCritique {
  input: Input<'ai:critique'>
  resolve: (result: AiCritiqueResult) => void
}

const FIRST = 'The storm broke at dusk. Rain followed.'
const SECOND = 'Nobody answered him, and the quiet held on after.'
const FIX = 'Rain came down after it.'

let editor: Editor
let requests: PendingCritique[]
let settles: Input<'proposal:settle'>[]
let cancels: string[]
let stored: AiSettings

const note = (over: Partial<CritiqueNote> = {}): CritiqueNote => ({
  kind: 'issue',
  category: 'pacing',
  quote: 'Rain followed.',
  why: 'The beat lands flat.',
  fix: FIX,
  flagged: false,
  violation: null,
  ...over
})

const PRAISE = note({
  kind: 'praise',
  category: 'clarity',
  quote: 'Nobody answered him',
  why: 'The silence does the work.',
  fix: null
})

const ok = (requestId: string, over: Partial<Extract<AiCritiqueResult, { ok: true }>> = {}) =>
  ({
    ok: true,
    notes: [note(), PRAISE],
    truncated: false,
    dropped: 0,
    usage: { inputTokens: 900, outputTokens: 120 },
    costUsd: 0.02,
    cached: false,
    model: 'gpt-5.4',
    proposalId: 'p1',
    requestId,
    ...over
  }) satisfies AiCritiqueResult

const panel = (): HTMLElement => screen.getByRole('region', { name: "Editor's notes" })
const notes = (): HTMLElement[] => screen.getAllByTestId('critique-note')
const flush = (): Promise<void> => act(() => new Promise<void>((resolve) => setTimeout(resolve, 0)))

/** Starts a critique for the rendered document and hands back the request. */
async function start(): Promise<PendingCritique> {
  act(() => useCritiqueStore.getState().start('sc-1'))
  await flush()
  const request = requests.at(-1)
  if (!request) throw new Error('no request left')
  return request
}

async function ready(
  over: Partial<Extract<AiCritiqueResult, { ok: true }>> = {}
): Promise<PendingCritique> {
  const request = await start()
  act(() => request.resolve(ok(request.input.requestId, over)))
  await flush()
  return request
}

beforeEach(() => {
  resetTagStore()
  resetCritiqueStore()
  resetRewriteStore()
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
      if (channel === 'ai:critique') {
        return new Promise<Output<C>>((resolve) => {
          requests.push({
            input: input as Input<'ai:critique'>,
            resolve: (result) => resolve(result as Output<C>)
          })
        })
      }
      if (channel === 'ai:rewrite') return new Promise<Output<C>>(() => {})
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
  resetCritiqueStore()
  resetRewriteStore()
  resetDocumentStore()
  resetAiActivityStore()
  resetAiSettingsStore()
  resetProposalStore()
  resetPendingSaves()
  if (!editor.isDestroyed) editor.destroy()
  setIpcClient(null)
})

describe('CritiquePanel (F-14.8)', () => {
  it('renders nothing without a critique, or for another document', async () => {
    render(<CritiquePanel id="sc-2" editor={editor} />)
    expect(screen.queryByTestId('critique-panel')).not.toBeInTheDocument()
    await start()
    expect(screen.queryByTestId('critique-panel')).not.toBeInTheDocument()
  })

  it('shows the pending state with Stop, which cancels and closes the panel', async () => {
    render(<CritiquePanel id="sc-1" editor={editor} />)
    const request = await start()
    expect(panel()).toHaveAttribute('data-testid', 'critique-panel')
    expect(screen.getByTestId('critique-pending')).toBeInTheDocument()
    expect(screen.getByTestId('critique-honesty')).toBeInTheDocument()
    await userEvent.click(screen.getByTestId('critique-stop'))
    expect(screen.queryByTestId('critique-panel')).not.toBeInTheDocument()
    expect(cancels).toEqual([request.input.requestId])
  })

  it('shows one card per note with its category, quote, reason, fix diff, and the cost line', async () => {
    render(<CritiquePanel id="sc-1" editor={editor} />)
    await ready({ cached: true, dropped: 2 })
    expect(notes()).toHaveLength(2)
    const [issue, praise] = notes()
    expect(issue).toHaveTextContent('Pacing')
    expect(issue).toHaveTextContent('The beat lands flat.')
    expect(issue?.querySelector('[data-testid="critique-quote"]')).toHaveTextContent(
      'Rain followed.'
    )
    const diff = screen.getByTestId('critique-fix-diff')
    expect(Array.from(diff.querySelectorAll('del')).map((el) => el.textContent)).toEqual([
      'followed'
    ])
    expect(
      Array.from(diff.querySelectorAll('ins'))
        .map((el) => el.textContent)
        .join('')
    ).toContain('came')
    expect(praise).toHaveAttribute('data-kind', 'praise')
    expect(praise).toHaveTextContent('Clarity')
    // Praise cites a passage too, and has nothing to apply.
    expect(praise?.querySelector('[data-testid="critique-quote"]')).toHaveTextContent(
      'Nobody answered him'
    )
    expect(screen.getAllByTestId('critique-apply')).toHaveLength(1)
    expect(screen.getByTestId('critique-cost')).toHaveTextContent('gpt-5.4 · $0.0200 · cached')
    expect(screen.getByTestId('critique-dropped')).toHaveTextContent('2 uncited notes dropped')
    expect(screen.queryByTestId('critique-truncated')).not.toBeInTheDocument()
  })

  it('says when the scene was cut and when there is nothing to report', async () => {
    render(<CritiquePanel id="sc-1" editor={editor} />)
    await ready({ notes: [], truncated: true })
    expect(screen.getByTestId('critique-truncated')).toHaveTextContent(
      'Only the first 20,000 characters were read.'
    )
    expect(screen.getByTestId('critique-empty')).toHaveTextContent('No notes.')
    expect(screen.queryByTestId('critique-note')).not.toBeInTheDocument()
  })

  it('a click on the quote selects the cited passage', async () => {
    render(<CritiquePanel id="sc-1" editor={editor} />)
    await ready()
    await userEvent.click(screen.getAllByTestId('critique-quote')[1]!)
    const { from, to } = editor.state.selection
    expect(editor.state.doc.textBetween(from, to)).toBe('Nobody answered him')
  })

  it('Apply replaces the cited passage and the button says so afterwards', async () => {
    render(<CritiquePanel id="sc-1" editor={editor} />)
    await ready()
    const apply = (): HTMLElement => screen.getByTestId('critique-apply')
    expect(apply()).toBeEnabled()
    await userEvent.click(apply())
    expect(editor.state.doc.firstChild?.textContent).toBe(`The storm broke at dusk. ${FIX}`)
    expect(editor.view.dom.querySelector('.ai-origin[data-proposal-id="p1"]')?.textContent).toBe(
      FIX
    )
    await waitFor(() => expect(apply()).toBeDisabled())
    expect(apply()).toHaveTextContent('Applied')
  })

  it('marks a note stale when its passage is gone and says why Apply is off', async () => {
    render(<CritiquePanel id="sc-1" editor={editor} />)
    await ready({ notes: [note({ quote: 'The lighthouse blinked twice.' })] })
    await userEvent.click(screen.getByTestId('critique-apply'))
    await waitFor(() => expect(screen.getByTestId('critique-apply')).toBeDisabled())
    expect(screen.getByTestId('critique-apply')).toHaveAttribute('title', PASSAGE_GONE_MESSAGE)
    expect(screen.getByTestId('critique-stale')).toHaveTextContent(PASSAGE_GONE_MESSAGE)
    expect(editor.state.doc.firstChild?.textContent).toBe(FIRST)
  })

  it('refuses Apply while a rewrite holds the editor, and says why', async () => {
    render(<CritiquePanel id="sc-1" editor={editor} />)
    await ready()
    act(() => {
      editor.commands.setTextSelection({ from: 1, to: FIRST.length + 1 })
      useRewriteStore.getState().start('sc-1', editor)
    })
    await waitFor(() => expect(screen.getByTestId('critique-apply')).toBeDisabled())
    expect(screen.getByTestId('critique-apply')).toHaveAttribute('title', REWRITE_BUSY_MESSAGE)
  })

  it('shows the fidelity badge on a fix that is off-voice', async () => {
    render(<CritiquePanel id="sc-1" editor={editor} />)
    await ready({ notes: [note({ flagged: true, violation: 'switches to present tense' })] })
    expect(screen.getByTestId('critique-flag')).toHaveTextContent(
      'Off-voice fix: switches to present tense'
    )
    expect(screen.getByTestId('critique-apply')).toBeEnabled()
  })

  it('the honesty select writes the setting', async () => {
    render(<CritiquePanel id="sc-1" editor={editor} />)
    await act(() => useAiSettingsStore.getState().load())
    await ready()
    const select = screen.getByTestId('critique-honesty')
    expect(select).toHaveValue('direct')
    await userEvent.selectOptions(select, 'brutal')
    expect(useAiSettingsStore.getState().settings?.critique.honesty).toBe('brutal')
  })

  it('Ask again… asks for a note, settles the shown proposal, and sends it again', async () => {
    render(<CritiquePanel id="sc-1" editor={editor} />)
    await ready()
    await userEvent.click(screen.getByTestId('critique-regenerate'))
    const modal = useDialogStore.getState().modals[0]
    if (modal?.kind !== 'prompt') throw new Error('expected a prompt')
    expect(modal.options.validate?.('x'.repeat(301))).toBe('Keep the note under 300 characters.')
    act(() => useDialogStore.getState().resolvePrompt(modal.id, '  Harsher.  '))
    await flush()
    expect(settles).toEqual([{ id: 'p1', status: 'regenerated', note: 'Harsher.' }])
    expect(requests).toHaveLength(2)
    expect(requests[1]?.input).toMatchObject({ note: 'Harsher.', regeneratedFrom: 'p1' })
    expect(screen.getByTestId('critique-pending')).toBeInTheDocument()
  })

  it('Close settles the proposal and clears the panel', async () => {
    render(<CritiquePanel id="sc-1" editor={editor} />)
    await ready()
    await userEvent.click(screen.getByTestId('critique-apply'))
    await userEvent.click(screen.getByTestId('critique-close'))
    expect(screen.queryByTestId('critique-panel')).not.toBeInTheDocument()
    await flush()
    expect(settles).toEqual([{ id: 'p1', status: 'accepted', note: null }])
  })

  it('shows a failure with its next step and Close', async () => {
    render(<CritiquePanel id="sc-1" editor={editor} />)
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
    expect(screen.getByTestId('critique-error')).toBeInTheDocument()
    expect(useDialogStore.getState().toasts).toEqual([])
    await userEvent.click(screen.getByTestId('critique-close'))
    expect(screen.queryByTestId('critique-panel')).not.toBeInTheDocument()
    expect(settles).toEqual([])
  })
})
