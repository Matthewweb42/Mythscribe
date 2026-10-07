import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { defaultAiSettings, type AiSettings } from '@shared/aiSettings'
import type { Editor } from '@tiptap/core'
import { resetCritiqueStore, useCritiqueStore } from '@renderer/features/editor/critiqueStore'
import { resetRewriteStore, useRewriteStore } from '@renderer/features/editor/rewriteStore'
import { resetFocusStore, useFocusStore } from '@renderer/features/focus/focusStore'
import { resetLayoutStore, useLayoutStore } from '@renderer/features/shell/layoutStore'
import type { Channel, Input, Output } from '@shared/ipc/contract'
import { setIpcClient, type IpcClient } from '@renderer/lib/ipc'
import {
  AI_ACTION_IDS,
  CONVERSATION_BUSY_MESSAGE,
  CRITIQUE_BUSY_MESSAGE,
  aiActionReason,
  openAssistant,
  rewriteReason,
  type OpenScene
} from './aiActions'

const settings = (over: Partial<AiSettings> = {}): AiSettings => ({
  ...defaultAiSettings(),
  dial: 1,
  ...over
})

/** An open manuscript scene of `length` characters; the reasons never touch the editor itself. */
const scene = (length: number): OpenScene => ({
  editor: {} as Editor,
  nodeId: 'sc-1',
  scene: true,
  length
})

beforeEach(() => {
  resetCritiqueStore()
  resetRewriteStore()
  resetLayoutStore()
  resetFocusStore()
  const client: IpcClient = {
    async invoke<C extends Channel>(channel: C, input: Input<C>): Promise<Output<C>> {
      if (channel === 'layout:set') return input as Output<C>
      throw new Error(`unexpected ${channel}`)
    },
    on: () => () => {}
  }
  setIpcClient(client)
})
afterEach(() => {
  resetCritiqueStore()
  resetRewriteStore()
  resetLayoutStore()
  resetFocusStore()
  setIpcClient(null)
})

describe('aiActionReason (2026-10-06)', () => {
  it('names the dial first, then the toggle, the scene, and the length', () => {
    expect(aiActionReason('critique', settings({ dial: 0 }), scene(500), false)).toBe(
      "Editor's notes needs Use AI turned on (Settings, AI tab)"
    )
    expect(
      aiActionReason(
        'brief',
        settings({ features: { ...defaultAiSettings().features, brief: false } }),
        scene(500),
        false
      )
    ).toContain('is turned off for this project')
    expect(aiActionReason('synopsis', settings(), { ...scene(500), scene: false }, false)).toBe(
      'Open a manuscript scene first'
    )
    expect(aiActionReason('brief', settings(), scene(199), false)).toBe(
      'Write 200 characters first'
    )
    for (const id of AI_ACTION_IDS)
      expect(aiActionReason(id, settings(), scene(500), false)).toBeNull()
  })

  it('waits while the same feature is busy; the turn-writing two wait for the conversation', () => {
    useCritiqueStore.setState({
      session: {
        nodeId: 'sc-1',
        requestId: 'r',
        status: 'pending',
        notes: [],
        applied: [],
        stale: [],
        result: null,
        error: null
      }
    })
    expect(aiActionReason('critique', settings(), scene(500), false)).toBe(CRITIQUE_BUSY_MESSAGE)
    expect(aiActionReason('betaReader', settings(), scene(500), false)).toBeNull()
    expect(aiActionReason('whatNext', settings(), scene(500), true)).toBe(CONVERSATION_BUSY_MESSAGE)
    expect(aiActionReason('proofread', settings(), scene(500), true)).toBeNull()
  })
})

describe('rewriteReason (F-14.10)', () => {
  it('follows the dial, the toggle, a rewrite in progress, and the selection bounds', () => {
    expect(rewriteReason(settings({ dial: 0 }), 50)).toContain('needs Use AI turned on')
    expect(rewriteReason(settings(), 10)).toBe(
      'Select 20–4,000 characters to rewrite them in your voice'
    )
    expect(rewriteReason(settings(), 5000)).toBe('The selection is over 4,000 characters')
    expect(rewriteReason(settings(), 50)).toBeNull()
    useRewriteStore.setState({
      session: {
        nodeId: 'sc-1',
        requestId: 'r',
        status: 'streaming',
        original: 'x',
        draft: '',
        result: null,
        error: null,
        from: 1,
        to: 2
      }
    })
    expect(rewriteReason(settings(), 50)).toBe('A rewrite is already in progress')
  })
})

describe('openAssistant', () => {
  it('opens the docked panel, or the floating one in focus mode', () => {
    openAssistant()
    expect(useLayoutStore.getState().layout.assistant.open).toBe(true)
    openAssistant()
    expect(useLayoutStore.getState().layout.assistant.open).toBe(true)
    useFocusStore.setState({ active: true })
    openAssistant()
    expect(useFocusStore.getState().panels.assistant).toBe(true)
  })
})
