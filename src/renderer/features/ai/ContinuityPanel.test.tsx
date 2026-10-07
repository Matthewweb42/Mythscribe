import { Editor } from '@tiptap/core'
import { act, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { defaultAiSettings, type AiSettings } from '@shared/aiSettings'
import type { ContinuityFinding } from '@shared/continuity'
import type { AiContinuityResult, Channel, Input, Output } from '@shared/ipc/contract'
import {
  resetActiveEditorStore,
  useActiveEditorStore
} from '@renderer/features/editor/activeEditorStore'
import { REWRITE_BUSY_MESSAGE } from '@renderer/features/editor/applyFix'
import { resetDocumentStore } from '@renderer/features/editor/documentStore'
import { buildExtensions } from '@renderer/features/editor/extensions'
import { resetRewriteStore, useRewriteStore } from '@renderer/features/editor/rewriteStore'
import { entityFixture } from '@renderer/features/entities/entityFixture'
import {
  orderedIds,
  resetEntityStore,
  useEntityStore
} from '@renderer/features/entities/entityStore'
import { buildIndex, useTreeStore } from '@renderer/features/manuscript/treeStore'
import { useDialogStore } from '@renderer/features/shell/dialogs/dialogStore'
import { resetTagStore } from '@renderer/features/tags/tagStore'
import { setIpcClient, type IpcClient } from '@renderer/lib/ipc'
import { resetAiActivityStore } from './aiActivityStore'
import { resetAiSettingsStore, useAiSettingsStore } from './aiSettingsStore'
import {
  CONTINUITY_FIRST,
  CONTINUITY_FIX,
  CONTINUITY_SECOND,
  continuityOk,
  continuityTree,
  factRef,
  finding,
  hairFinding
} from './continuityFixture'
import {
  CONTINUITY_GONE_MESSAGE,
  CONTINUITY_NO_PROPOSAL,
  CONTINUITY_NO_REFERENCES,
  ContinuityLink,
  ContinuityView
} from './ContinuityPanel'
import { resetContinuityStore, useContinuityStore } from './continuityStore'
import { resetProposalStore } from './proposalStore'

interface PendingCheck {
  input: Input<'ai:continuity'>
  resolve: (result: AiContinuityResult) => void
}

/** Enough text after the two fixture paragraphs to pass the on-demand minimum. */
const PADDING = 'The road ran on past the last farm and into the hills. '.repeat(4).trim()

let editor: Editor
let requests: PendingCheck[]
let settles: Input<'continuity:settle'>[]
let proposals: Input<'proposal:settle'>[]
let cancels: string[]

function install(): void {
  const client: IpcClient = {
    async invoke<C extends Channel>(channel: C, input: Input<C>): Promise<Output<C>> {
      if (channel === 'ai:continuity') {
        return new Promise<Output<C>>((resolve) => {
          requests.push({
            input: input as Input<'ai:continuity'>,
            resolve: (result) => resolve(result as Output<C>)
          })
        })
      }
      if (channel === 'continuity:settle') {
        const asked = input as Input<'continuity:settle'>
        settles.push(asked)
        return finding({ id: asked.id, status: asked.status }) as Output<C>
      }
      if (channel === 'proposal:settle') {
        proposals.push(input as Input<'proposal:settle'>)
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
}

const settings = (over: Partial<AiSettings> = {}): AiSettings => ({
  ...defaultAiSettings(),
  dial: 1,
  ...over
})

const flush = (): Promise<void> => act(() => new Promise<void>((resolve) => setTimeout(resolve, 0)))
const cards = (): HTMLElement[] => screen.queryAllByTestId('continuity-finding')
const paragraphs = (): string[] => {
  const out: string[] = []
  editor.state.doc.forEach((p) => out.push(p.textContent))
  return out
}
const selected = (): string => {
  const { from, to } = editor.state.selection
  return editor.state.doc.textBetween(from, to, ' ')
}

/** Puts findings in the store as a loaded list would. */
function hold(findings: ContinuityFinding[]): void {
  const byId: Record<string, ContinuityFinding> = {}
  for (const f of findings) byId[f.id] = f
  act(() => useContinuityStore.setState({ byId, ids: findings.map((f) => f.id), loaded: true }))
}

/** Makes `sc-1` the open scene. */
function openScene(): void {
  act(() => useActiveEditorStore.getState().set('sc-1', editor))
}

beforeEach(() => {
  resetTagStore()
  resetContinuityStore()
  resetRewriteStore()
  resetDocumentStore()
  resetAiActivityStore()
  resetAiSettingsStore()
  resetProposalStore()
  resetEntityStore()
  resetActiveEditorStore()
  useTreeStore.getState().clear()
  useDialogStore.setState({ modals: [], toasts: [] })
  requests = []
  settles = []
  proposals = []
  cancels = []
  install()
  useAiSettingsStore.setState({ settings: settings() })
  useTreeStore.setState({ ...buildIndex(continuityTree), loaded: true })
  editor = new Editor({
    extensions: buildExtensions({ sceneBreak: '~~~', onSave: () => {}, inlineTagNodeId: 'sc-1' }),
    content: {
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: CONTINUITY_FIRST }] },
        { type: 'paragraph', content: [{ type: 'text', text: CONTINUITY_SECOND }] },
        { type: 'paragraph', content: [{ type: 'text', text: PADDING }] }
      ]
    }
  })
})
afterEach(() => {
  resetContinuityStore()
  resetRewriteStore()
  resetDocumentStore()
  resetAiActivityStore()
  resetAiSettingsStore()
  resetProposalStore()
  resetEntityStore()
  resetActiveEditorStore()
  useTreeStore.getState().clear()
  if (!editor.isDestroyed) editor.destroy()
  setIpcClient(null)
})

describe('ContinuityLink (F-13.4)', () => {
  it('shows nothing while there are no findings, and a plain count once there are', () => {
    render(<ContinuityLink />)
    expect(screen.queryByTestId('continuity-button')).not.toBeInTheDocument()
    hold([finding(), hairFinding(), finding({ id: 'f-3', nodeId: 'sc-2' })])
    expect(screen.getByTestId('continuity-button')).toHaveTextContent(/^3continuity notes$/)
    expect(screen.getByTestId('continuity-count')).toHaveTextContent(/^3$/)
    // Quiet by construction: nothing toasts, nothing opens.
    expect(useDialogStore.getState().toasts).toEqual([])
    expect(useContinuityStore.getState().viewOpen).toBe(false)
  })

  it('opens the findings view, then leads back to the conversation', async () => {
    hold([finding()])
    render(<ContinuityLink />)
    const button = screen.getByTestId('continuity-button')
    expect(button).toHaveAttribute('aria-pressed', 'false')
    expect(button).toHaveTextContent(/^1continuity note$/)
    await userEvent.click(button)
    expect(useContinuityStore.getState().viewOpen).toBe(true)
    expect(button).toHaveAttribute('aria-pressed', 'true')
    expect(button).toHaveTextContent('Back to the conversation')
    await userEvent.click(button)
    expect(useContinuityStore.getState().viewOpen).toBe(false)
  })
})

describe('ContinuityView (F-13.4)', () => {
  it('says so when nothing is open', () => {
    render(<ContinuityView />)
    expect(screen.getByRole('region', { name: 'Continuity' })).toBeInTheDocument()
    expect(screen.getByTestId('continuity-empty')).toBeInTheDocument()
  })

  it('groups the findings by scene in the order received, each with both citations', () => {
    openScene()
    hold([
      finding({ flagged: true, violation: 'uses a banned phrase' }),
      finding({ id: 'f-3', nodeId: 'sc-2', quote: 'She was nineteen.', fix: null }),
      hairFinding()
    ])
    render(<ContinuityView />)
    const groups = screen.getAllByTestId('continuity-group')
    expect(groups.map((g) => within(g).getByRole('heading').textContent)).toEqual([
      'The Ridge',
      'The Harbor'
    ])
    const ridge = within(groups[0]!).getAllByTestId('continuity-finding')
    expect(ridge).toHaveLength(2)
    const [age, hair] = ridge as [HTMLElement, HTMLElement]
    expect(age).toHaveAttribute('data-ref-kind', 'sheet')
    expect(within(age).getByTestId('continuity-quote')).toHaveTextContent(
      'Mara was twenty-nine that spring.'
    )
    expect(within(age).getByTestId('continuity-ref')).toHaveTextContent('Mara · Age: 34')
    expect(within(age).getByTestId('continuity-why')).toHaveTextContent(
      'Her sheet gives her age as 34.'
    )
    expect(within(age).getByTestId('continuity-flag')).toHaveTextContent('uses a banned phrase')
    const diff = within(age).getByTestId('continuity-fix-diff')
    const texts = (tag: string): string =>
      Array.from(diff.querySelectorAll(tag))
        .map((el) => el.textContent)
        .join('|')
    expect(texts('del')).toContain('twenty')
    expect(texts('ins')).toContain('thirty')
    expect(diff).toHaveTextContent('that spring.')
    expect(hair).toHaveAttribute('data-ref-kind', 'fact')
    expect(within(hair).getByTestId('continuity-ref')).toHaveTextContent(
      'Story bible (The Harbor): Mara · Appearance: black hair'
    )
    expect(within(hair).getByTestId('continuity-ref-quote')).toHaveTextContent(
      'Her black hair caught the light.'
    )
    // A finding without a fix has neither a diff nor Apply, and can still be dismissed.
    const harbor = within(groups[1]!).getByTestId('continuity-finding')
    expect(within(harbor).queryByTestId('continuity-fix-diff')).not.toBeInTheDocument()
    expect(within(harbor).queryByTestId('continuity-apply')).not.toBeInTheDocument()
    expect(within(harbor).getByTestId('continuity-dismiss')).toHaveTextContent(
      'Changed in the story'
    )
  })

  it('jumps to the scene passage, the other scene’s passage, and the entity', async () => {
    openScene()
    useEntityStore.setState({
      byId: Object.fromEntries(entityFixture.map((e) => [e.id, e])),
      ids: orderedIds(Object.fromEntries(entityFixture.map((e) => [e.id, e]))),
      loaded: true
    })
    hold([finding(), hairFinding()])
    render(<ContinuityView />)
    const [age, hair] = cards() as [HTMLElement, HTMLElement]
    await userEvent.click(within(age).getByTestId('continuity-quote'))
    await flush()
    expect(useTreeStore.getState().selectedId).toBe('sc-1')
    expect(selected()).toBe('Mara was twenty-nine that spring.')
    await userEvent.click(within(age).getByTestId('continuity-ref-entity'))
    expect(useEntityStore.getState().selectedId).toBe('e-mara')
    // The fact's own passage lives in another scene: the jump opens that scene.
    await userEvent.click(within(hair).getByTestId('continuity-ref-quote'))
    expect(useTreeStore.getState().selectedId).toBe('sc-2')
  })

  it('shows a reference whose scene or entity is gone as plain text', () => {
    hold([
      finding(),
      hairFinding({ ref: factRef({ nodeId: null }) }),
      finding({
        id: 'f-4',
        ref: {
          kind: 'timeline',
          entityId: null,
          entityName: null,
          entityKind: null,
          attribute: null,
          label: 'Timeline',
          value: 'Day 3, evening',
          nodeId: 'sc-2',
          quote: null
        }
      })
    ])
    render(<ContinuityView />)
    const [age, hair, timeline] = cards() as [HTMLElement, HTMLElement, HTMLElement]
    // No entity store row for the sheet's entity: no link.
    expect(within(age).queryByTestId('continuity-ref-entity')).not.toBeInTheDocument()
    expect(within(hair).getByTestId('continuity-ref-quote').tagName).toBe('P')
    expect(within(timeline).getByTestId('continuity-ref')).toHaveTextContent(
      'Story bible (previous scene): Timeline: Day 3, evening'
    )
    expect(within(timeline).getByTestId('continuity-ref-scene')).toHaveTextContent(
      'Open The Harbor'
    )
  })

  it('applies a fix in the open scene and settles the finding applied', async () => {
    openScene()
    hold([finding(), hairFinding()])
    render(<ContinuityView />)
    await userEvent.click(within(cards()[0]!).getByTestId('continuity-apply'))
    await flush()
    expect(paragraphs()[0]).toBe(`${CONTINUITY_FIX} The rain held off.`)
    expect(editor.view.dom.querySelector('.ai-origin[data-proposal-id="p1"]')?.textContent).toBe(
      CONTINUITY_FIX
    )
    expect(settles).toEqual([{ id: 'f-1', status: 'applied' }])
    expect(proposals).toEqual([])
    expect(cards()).toHaveLength(1)
  })

  it('offers to open the scene instead of Apply when the finding’s scene is not the open one', async () => {
    hold([finding()])
    render(<ContinuityView />)
    expect(screen.queryByTestId('continuity-apply')).not.toBeInTheDocument()
    await userEvent.click(screen.getByTestId('continuity-open-scene'))
    expect(useTreeStore.getState().selectedId).toBe('sc-1')
    expect(paragraphs()[0]).toBe(CONTINUITY_FIRST)
    // The scene mounts its editor: Apply takes the offer's place.
    openScene()
    await flush()
    expect(screen.getByTestId('continuity-apply')).toBeEnabled()
    expect(screen.queryByTestId('continuity-open-scene')).not.toBeInTheDocument()
  })

  it('greys Apply when the quote is gone, without a proposal, and during a rewrite', async () => {
    openScene()
    hold([finding({ quote: 'Mara was forty that spring.' }), hairFinding({ proposalId: null })])
    render(<ContinuityView />)
    const [age, hair] = cards() as [HTMLElement, HTMLElement]
    await userEvent.click(within(age).getByTestId('continuity-apply'))
    expect(within(age).getByTestId('continuity-apply')).toBeDisabled()
    expect(within(age).getByTestId('continuity-stale')).toHaveTextContent(CONTINUITY_GONE_MESSAGE)
    expect(within(hair).getByTestId('continuity-apply')).toBeDisabled()
    expect(within(hair).getByTestId('continuity-no-proposal')).toHaveTextContent(
      CONTINUITY_NO_PROPOSAL
    )
    expect(settles).toEqual([])
    hold([finding({ id: 'f-5' })])
    act(() =>
      useRewriteStore.setState({
        session: {
          nodeId: 'sc-1',
          requestId: 'rw-1',
          status: 'streaming',
          original: 'Mara',
          draft: '',
          result: null,
          error: null,
          from: 1,
          to: 5
        }
      })
    )
    expect(screen.getByTestId('continuity-apply')).toBeDisabled()
    expect(screen.getByTestId('continuity-apply')).toHaveAttribute('title', REWRITE_BUSY_MESSAGE)
  })

  it('dismisses a finding as changed in the story', async () => {
    hold([finding(), hairFinding()])
    render(<ContinuityView />)
    await userEvent.click(within(cards()[1]!).getByTestId('continuity-dismiss'))
    await flush()
    expect(settles).toEqual([{ id: 'f-2', status: 'dismissed' }])
    expect(cards()).toHaveLength(1)
    expect(paragraphs()[1]).toBe(CONTINUITY_SECOND)
  })

  describe('the check (F-5.17: started by the Check consistency quick action)', () => {
    /** What the quick action does: asks the store to check the open scene. */
    const check = (): void => act(() => useContinuityStore.getState().check('sc-1'))

    it('runs the check with Stop, then lists what it found with the cost', async () => {
      openScene()
      render(<ContinuityView />)
      expect(screen.queryByText('Check this scene')).not.toBeInTheDocument()
      check()
      await flush()
      expect(requests).toHaveLength(1)
      expect(requests[0]?.input.nodeId).toBe('sc-1')
      expect(screen.getByTestId('continuity-pending')).toBeInTheDocument()
      expect(screen.getByTestId('continuity-stop')).toBeInTheDocument()
      const request = requests[0]!
      act(() =>
        request.resolve(
          continuityOk(request.input.requestId, { dropped: 1, truncated: true, cached: true })
        )
      )
      await flush()
      expect(cards()).toHaveLength(2)
      expect(screen.getByTestId('continuity-result')).toHaveTextContent(
        '2 contradictions found in The Ridge.'
      )
      expect(screen.getByTestId('continuity-cost')).toHaveTextContent(
        'gpt-5.4 · $0.0100 · 700 in · 90 out · cached'
      )
      expect(screen.getByTestId('continuity-dropped')).toHaveTextContent('1 uncited or dismissed')
      expect(screen.getByTestId('continuity-truncated')).toBeInTheDocument()
      expect(screen.queryByTestId('continuity-stop')).not.toBeInTheDocument()
    })

    it('Stop cancels the request', async () => {
      openScene()
      render(<ContinuityView />)
      check()
      await flush()
      await userEvent.click(screen.getByTestId('continuity-stop'))
      expect(cancels).toEqual([requests[0]?.input.requestId])
      expect(screen.queryByTestId('continuity-pending')).not.toBeInTheDocument()
      expect(useContinuityStore.getState().running).toBeNull()
    })

    it('says there is nothing to check against when no reference was found', async () => {
      openScene()
      render(<ContinuityView />)
      check()
      await flush()
      const request = requests[0]!
      act(() =>
        request.resolve(
          continuityOk(request.input.requestId, { findings: [], references: 0, proposalId: null })
        )
      )
      await flush()
      expect(screen.getByTestId('continuity-no-references')).toHaveTextContent(
        CONTINUITY_NO_REFERENCES
      )
      expect(screen.queryByTestId('continuity-cost')).not.toBeInTheDocument()
    })

    it('shows an AI failure with the cause and the next step', async () => {
      openScene()
      render(<ContinuityView />)
      check()
      await flush()
      const request = requests[0]!
      act(() =>
        request.resolve({
          ok: false,
          code: 'NO_KEY',
          message: 'No API key is set.',
          nextStep: 'Add one in Settings, AI tab.',
          requestId: request.input.requestId
        })
      )
      await flush()
      expect(screen.getByRole('alert')).toHaveTextContent(
        'No API key is set. Add one in Settings, AI tab.'
      )
      expect(useContinuityStore.getState().running).toBeNull()
    })
  })
})
