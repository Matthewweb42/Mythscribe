import { Editor } from '@tiptap/core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentEdit } from '@shared/agent'
import type {
  AiChatResult,
  Channel,
  EventName,
  EventPayload,
  Input,
  Output
} from '@shared/ipc/contract'
import { AI_ORIGIN_MARK } from '@shared/provenance'
import {
  resetActiveEditorStore,
  useActiveEditorStore
} from '@renderer/features/editor/activeEditorStore'
import { buildExtensions } from '@renderer/features/editor/extensions'
import { ghostOf } from '@renderer/features/editor/ghostText'
import { buildIndex, useTreeStore } from '@renderer/features/manuscript/treeStore'
import { treeFixture } from '@renderer/features/manuscript/treeFixture'
import { setIpcClient, type IpcClient } from '@renderer/lib/ipc'
import { resetAiActivityStore } from './aiActivityStore'
import {
  dismissLanding,
  landDraft,
  resetLandings,
  resolveInsertAnchor,
  type LandingOutcome
} from './draftLanding'
import { resetProposalStore } from './proposalStore'

/** The two scenes of the fixture the tests write in. */
const OPEN = treeFixture.find((n) => n.kind === 'document' && n.hierarchyLevel === 'scene')!
const OTHER = treeFixture.filter((n) => n.kind === 'document' && n.hierarchyLevel === 'scene')[1]!

const FIRST = 'The storm broke at dusk. Stunned silence.'
const SECOND = 'Rain followed.'

const editorWith = (...paragraphs: string[]): Editor =>
  new Editor({
    extensions: buildExtensions({ sceneBreak: '~~~', onSave: () => {}, inlineTagNodeId: 'x' }),
    content: {
      type: 'doc',
      content: paragraphs.map((text) => ({
        type: 'paragraph',
        content: text ? [{ type: 'text', text }] : []
      }))
    }
  })

interface PendingDraft {
  input: Input<'ai:agentDraft'>
  resolve: (result: AiChatResult) => void
}

let drafts: PendingDraft[]
let settles: Input<'proposal:settle'>[]
let deltaListener: ((payload: EventPayload<'ai:agentDraftDelta'>) => void) | null
let open: Editor
let other: Editor
let unsubscribeTree: () => void

function client(): IpcClient {
  return {
    async invoke<C extends Channel>(channel: C, input: Input<C>): Promise<Output<C>> {
      if (channel === 'ai:agentDraft') {
        return new Promise<Output<C>>((resolve) => {
          drafts.push({
            input: input as Input<'ai:agentDraft'>,
            resolve: (result) => resolve(result as Output<C>)
          })
        })
      }
      if (channel === 'proposal:settle') {
        settles.push(input as Input<'proposal:settle'>)
        return null as Output<C>
      }
      if (channel === 'ai:cancel') return { cancelled: true } as Output<C>
      throw new Error(`unexpected ${channel}`)
    },
    on<E extends EventName>(event: E, listener: (payload: EventPayload<E>) => void) {
      if (event === 'ai:agentDraftDelta') {
        deltaListener = listener as (payload: EventPayload<'ai:agentDraftDelta'>) => void
      }
      return () => {
        if (event === 'ai:agentDraftDelta') deltaListener = null
      }
    }
  }
}

const draftOk = (requestId: string, text: string, flagged = false): AiChatResult => ({
  ok: true,
  text,
  usage: { inputTokens: 400, outputTokens: 30 },
  costUsd: 0.0001,
  cached: false,
  model: 'gpt-fake',
  flagged,
  violation: flagged ? 'switches to present tense' : null,
  proposalId: `p-${requestId}`,
  requestId
})

const intent = (nodeId: string, after: string): Extract<AgentEdit, { kind: 'insert' }> => ({
  kind: 'insert',
  nodeId,
  title: 'Chapter 1 › Scene 2',
  after,
  text: '',
  brief: 'Tomas looks at the elm.',
  words: 60
})

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

beforeEach(() => {
  drafts = []
  settles = []
  deltaListener = null
  resetLandings()
  resetActiveEditorStore()
  resetAiActivityStore()
  resetProposalStore()
  useTreeStore.setState(buildIndex(treeFixture))
  open = editorWith('She waited.')
  other = editorWith(FIRST, SECOND)
  useActiveEditorStore.getState().set(OPEN.id, open)
  // What the editor pane does: the selected document mounts its editor and registers it.
  unsubscribeTree = useTreeStore.subscribe((state) => {
    if (state.selectedId === OTHER.id) useActiveEditorStore.getState().set(OTHER.id, other)
  })
  setIpcClient(client())
})

afterEach(() => {
  unsubscribeTree()
  resetLandings()
  resetActiveEditorStore()
  resetAiActivityStore()
  useTreeStore.getState().clear()
  open.destroy()
  other.destroy()
})

describe('resolveInsertAnchor (2026-10-07)', () => {
  it('places after the paragraph holding the anchor, as a new paragraph', () => {
    const doc = editorWith(FIRST, SECOND).state.doc
    const anchor = resolveInsertAnchor(doc, 'Stunned silence.', null)
    expect(anchor.notice).toBeNull()
    expect(anchor.prefix).toBe('\n\n')
    expect(doc.textBetween(0, anchor.pos, '\n')).toBe(FIRST)
  })

  it('falls back to the caret with a notice when the anchor is missing or repeated, and to the end without a caret', () => {
    const editor = editorWith(FIRST, SECOND)
    const doc = editor.state.doc
    // Right after "The": mid-paragraph, so the prose runs on after a space.
    const caret = 4
    const missing = resolveInsertAnchor(doc, 'Nowhere in the scene.', caret)
    expect(missing).toEqual({
      pos: caret,
      prefix: ' ',
      notice: '“Nowhere in the scene.” is not in the scene; placed at the caret instead.'
    })
    const twice = resolveInsertAnchor(editorWith('Rain.', 'Rain.').state.doc, 'Rain.', null)
    expect(twice.notice).toBe('“Rain.” occurs more than once; placed at the end instead.')
    const end = resolveInsertAnchor(doc, '', null)
    expect(doc.textBetween(0, end.pos, '\n')).toBe(`${FIRST}\n${SECOND}`)
    expect(end.prefix).toBe('\n\n')
    editor.destroy()
  })
})

describe('landDraft (2026-10-07)', () => {
  async function start(
    autoAccept: boolean,
    after = 'Stunned silence.'
  ): Promise<{ outcome: Promise<LandingOutcome>; progress: string[] }> {
    const progress: string[] = []
    const outcome = landDraft(
      'e-1',
      intent(OTHER.id, after),
      { requestId: 'd-1', autoAccept },
      { progress: (status) => progress.push(status) }
    )
    await vi.waitFor(() => expect(drafts).toHaveLength(1))
    return { outcome, progress }
  }

  it('opens a scene that was not open, streams the draft in as ghost text at the anchor, and Tab puts it in the document', async () => {
    const { outcome, progress } = await start(false)
    expect(useTreeStore.getState().selectedId).toBe(OTHER.id)
    expect(drafts[0]?.input).toMatchObject({
      nodeId: OTHER.id,
      brief: 'Tomas looks at the elm.',
      words: 60,
      before: FIRST,
      passage: null
    })
    deltaListener?.({ requestId: 'd-1', delta: 'Tomas looked' })
    const ghost = ghostOf(other.state)
    expect(ghost?.text).toBe('\n\nTomas looked')
    expect(ghost?.pin).not.toBeNull()
    expect(other.state.doc.textBetween(0, ghost?.from ?? 0, '\n')).toBe(FIRST)
    // The author moving the caret elsewhere keeps it.
    other.commands.setTextSelection(1)
    expect(ghostOf(other.state)).not.toBeNull()

    drafts[0]?.resolve(draftOk('d-1', 'Tomas looked at the elm.'))
    await vi.waitFor(() => expect(progress).toContain('shown'))
    expect(ghostOf(other.state)?.text).toBe('\n\nTomas looked at the elm.')
    expect(ghostOf(other.state)?.proposalId).toBe('p-d-1')
    other.commands.acceptGhost()
    await expect(outcome).resolves.toEqual({
      status: 'accepted',
      text: 'Tomas looked at the elm.',
      proposalId: 'p-d-1',
      notice: null
    })
    expect(other.state.doc.textBetween(0, other.state.doc.content.size, '\n')).toBe(
      `${FIRST}\nTomas looked at the elm.\n${SECOND}`
    )
    let marked = ''
    other.state.doc.descendants((node) => {
      if (node.marks.some((m) => m.type.name === AI_ORIGIN_MARK)) marked += node.text ?? ''
    })
    expect(marked).toBe('Tomas looked at the elm.')
    expect(settles).toEqual([{ id: 'p-d-1', status: 'accepted', note: null }])
    expect(progress[0]).toBe('writing')
  })

  it('in Auto accepts once the draft is in, and a missing anchor lands at the end with a notice', async () => {
    const { outcome } = await start(true, 'A sentence the scene lacks.')
    drafts[0]?.resolve(draftOk('d-1', 'The elm creaked.'))
    const result = await outcome
    expect(result).toMatchObject({
      status: 'accepted',
      notice: '“A sentence the scene lacks.” is not in the scene; placed at the end instead.'
    })
    expect(other.state.doc.textBetween(0, other.state.doc.content.size, '\n')).toBe(
      `${FIRST}\n${SECOND}\nThe elm creaked.`
    )
  })

  it('leaves a flagged draft for the author even in Auto, and Dismiss settles it rejected', async () => {
    const { outcome } = await start(true)
    drafts[0]?.resolve(draftOk('d-1', 'Tomas looks at the elm.', true))
    await vi.waitFor(() => expect(ghostOf(other.state)?.flagged).toBe(true))
    await tick()
    expect(dismissLanding('e-1')).toBe(true)
    await expect(outcome).resolves.toMatchObject({ status: 'rejected', text: '' })
    expect(other.state.doc.textBetween(0, other.state.doc.content.size, '\n')).toBe(
      `${FIRST}\n${SECOND}`
    )
    expect(settles).toEqual([{ id: 'p-d-1', status: 'rejected', note: null }])
  })

  it('shows nothing and says why when the draft fails', async () => {
    const { outcome } = await start(false)
    drafts[0]?.resolve({
      ok: false,
      code: 'PROVIDER',
      message: 'The model used its whole output allowance (60 tokens) before writing anything.',
      nextStep: 'Try again.',
      requestId: 'd-1'
    })
    await expect(outcome).resolves.toEqual({
      status: 'failed',
      error:
        'The model used its whole output allowance (60 tokens) before writing anything. Try again.'
    })
    expect(ghostOf(other.state)).toBeNull()
  })
})
