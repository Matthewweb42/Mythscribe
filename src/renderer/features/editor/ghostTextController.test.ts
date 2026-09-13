import { act, renderHook } from '@testing-library/react'
import { Editor } from '@tiptap/core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AiSettings, defaultAiSettings } from '@shared/aiSettings'
import { GHOST_BACKOFF_MS, GHOST_MAX_PER_DAY, GHOST_MIN_NEW_CHARS } from '@shared/aiThrottle'
import type { AiGhostTextResult, Channel, Input, Output } from '@shared/ipc/contract'
import { resetAiSettingsStore, useAiSettingsStore } from '@renderer/features/ai/aiSettingsStore'
import { resetPendingSaves } from '@renderer/features/project/pendingSaves'
import { useDialogStore } from '@renderer/features/shell/dialogs/dialogStore'
import { resetTagStore } from '@renderer/features/tags/tagStore'
import { setIpcClient, type IpcClient } from '@renderer/lib/ipc'
import { buildExtensions } from './extensions'
import { ghostOf } from './ghostText'
import {
  caretWindow,
  resetGhostTextController,
  useGhostTextController
} from './ghostTextController'

interface PendingRequest {
  input: Input<'ai:ghostText'>
  resolve: (result: AiGhostTextResult) => void
  reject: (err: Error) => void
}

const IDLE_MS = 1000
const CONTENT = 'The storm broke at dusk.'
const ENOUGH = 'a'.repeat(GHOST_MIN_NEW_CHARS)

let editor: Editor
let requests: PendingRequest[]
let settingsWrites: AiSettings[]

function fakeClient(): IpcClient {
  return {
    async invoke<C extends Channel>(channel: C, input: Input<C>): Promise<Output<C>> {
      if (channel === 'ai:ghostText') {
        return new Promise<Output<C>>((resolve, reject) => {
          requests.push({
            input: input as Input<'ai:ghostText'>,
            resolve: (result) => resolve(result as Output<C>),
            reject
          })
        })
      }
      if (channel === 'aiSettings:set') {
        const value = AiSettings.parse(input)
        settingsWrites.push(value)
        return value as Output<C>
      }
      throw new Error(`unexpected ${channel}`)
    },
    on: () => () => {}
  }
}

const settings = (over: Partial<AiSettings> = {}): AiSettings => ({
  ...defaultAiSettings(),
  dial: 2,
  ghostText: { enabled: true, idleMs: IDLE_MS },
  ...over
})

const ok = (requestId: string, text = ' Rain followed.'): AiGhostTextResult => ({
  ok: true,
  text,
  usage: { inputTokens: 100, outputTokens: 5 },
  costUsd: 0.0001,
  cached: false,
  model: 'gpt-fake',
  requestId
})
const fail = (
  requestId: string,
  code: AiGhostTextResult['ok'] extends true
    ? never
    : 'DISABLED' | 'NO_KEY' | 'INVALID_KEY' | 'RATE_LIMIT' | 'NETWORK'
): AiGhostTextResult => ({
  ok: false,
  code,
  message: `${code} happened.`,
  nextStep: 'Do the thing.',
  requestId
})

const type = (text: string): void => {
  act(() => {
    editor.commands.insertContent(text)
  })
}
const idle = async (ms = IDLE_MS): Promise<void> => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
  })
}
const answer = async (result: AiGhostTextResult, index = requests.length - 1): Promise<void> => {
  await act(async () => {
    requests[index]?.resolve(result)
    await vi.advanceTimersByTimeAsync(0)
  })
}
const ghostText = (): string | null => ghostOf(editor.state)?.text ?? null
const toasts = (): string[] => useDialogStore.getState().toasts.map((t) => t.message)
const mount = (
  props: { nodeId: string; active: boolean } = { nodeId: 'sc-1', active: true }
): ReturnType<typeof renderHook<{ error: string | null }, { nodeId: string; active: boolean }>> =>
  renderHook((p) => useGhostTextController({ editor, nodeId: p.nodeId, active: p.active }), {
    initialProps: props
  })

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date(2026, 8, 13, 10, 0, 0))
  resetGhostTextController()
  resetAiSettingsStore()
  resetPendingSaves()
  resetTagStore()
  useDialogStore.setState({ modals: [], toasts: [] })
  requests = []
  settingsWrites = []
  setIpcClient(fakeClient())
  useAiSettingsStore.setState({ settings: settings() })
  editor = new Editor({
    extensions: buildExtensions({ sceneBreak: '~~~', onSave: () => {}, inlineTagNodeId: 'sc-1' }),
    content: {
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: CONTENT }] }]
    }
  })
  editor.commands.focus('end')
})
afterEach(() => {
  editor.destroy()
  resetAiSettingsStore()
  resetGhostTextController()
  vi.useRealTimers()
})

describe('caretWindow', () => {
  it('reads the text before and after the caret across blocks, inline tags as #name, within the caps', () => {
    editor.commands.setContent({
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'One.' }] },
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'Into the ' },
            { type: 'inlineTag', attrs: { id: 't-1', name: 'dark-forest' } },
            { type: 'text', text: ' she went.' }
          ]
        },
        { type: 'paragraph', content: [{ type: 'text', text: 'x'.repeat(300) }] }
      ]
    })
    // Paragraph 1 spans 0–6; paragraph 2 opens at 6, its text starts at 7, the tag atom is one position.
    editor.commands.setTextSelection(7 + 'Into the '.length + 1)
    expect(caretWindow(editor.state)).toEqual({
      before: 'One.\nInto the #dark-forest',
      after: ` she went.\n${'x'.repeat(89)}`
    })
    editor.commands.setContent({
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'y'.repeat(2000) }] }]
    })
    editor.commands.focus('end')
    expect(caretWindow(editor.state)).toEqual({ before: 'y'.repeat(500), after: '' })
  })
})

describe('useGhostTextController (F-5.3)', () => {
  it('asks after the idle delay once enough new characters were typed, and shows the answer', async () => {
    mount()
    type(ENOUGH)
    await idle(IDLE_MS - 1)
    expect(requests).toHaveLength(0)
    await idle(1)
    expect(requests).toHaveLength(1)
    expect(requests[0]?.input).toEqual({
      nodeId: 'sc-1',
      before: CONTENT + ENOUGH,
      after: '',
      requestId: '1'
    })
    await answer(ok('1'))
    expect(ghostText()).toBe(' Rain followed.')
  })

  it('does not ask below the minimum new characters, while a suggestion shows, or while one is pending', async () => {
    mount()
    type('a'.repeat(GHOST_MIN_NEW_CHARS - 1))
    await idle()
    expect(requests).toHaveLength(0)
    type('a')
    await idle()
    expect(requests).toHaveLength(1)
    type(ENOUGH) // while pending: no second request
    await idle()
    expect(requests).toHaveLength(1)
    await answer(ok('1')) // edited since it left, so the answer is dropped
    expect(ghostText()).toBeNull()
    type(ENOUGH)
    await idle()
    expect(requests).toHaveLength(2)
    await answer(ok('2'))
    expect(ghostText()).toBe(' Rain followed.')
    type(' ') // consumes the first character, keeps the suggestion showing
    type(ENOUGH.slice(1))
    expect(ghostText()).toBeNull() // a mismatch cleared it
    type('b'.repeat(GHOST_MIN_NEW_CHARS))
    await idle()
    expect(requests).toHaveLength(3)
    await answer(ok('3'))
    expect(ghostText()).toBe(' Rain followed.')
    type(' R')
    await idle()
    expect(requests).toHaveLength(3) // visible: no request
  })

  it('never asks while VibeWrite is off, the dial is below Suggest, or outside the single-document view', async () => {
    useAiSettingsStore.setState({
      settings: settings({ ghostText: { enabled: false, idleMs: IDLE_MS } })
    })
    const hook = mount()
    type(ENOUGH)
    await idle()
    expect(requests).toHaveLength(0)
    act(() => {
      useAiSettingsStore.setState({ settings: settings({ dial: 1 }) })
    })
    type(ENOUGH)
    await idle()
    expect(requests).toHaveLength(0)
    act(() => {
      useAiSettingsStore.setState({ settings: settings() })
    })
    hook.rerender({ nodeId: 'sc-1', active: false })
    type(ENOUGH)
    await idle()
    expect(requests).toHaveLength(0)
    hook.rerender({ nodeId: 'sc-1', active: true })
    type(ENOUGH)
    await idle()
    expect(requests).toHaveLength(1)
  })

  it('drops an answer for a superseded request id, a moved caret, a blurred editor, or a switched document', async () => {
    const hook = mount()
    type(ENOUGH)
    await idle()
    await answer(ok('0'))
    expect(ghostText()).toBeNull()
    type(ENOUGH)
    await idle()
    expect(requests).toHaveLength(2)
    act(() => {
      editor.commands.setTextSelection(2)
    })
    await answer(ok('2'))
    expect(ghostText()).toBeNull()
    act(() => {
      editor.commands.focus('end')
    })
    type(ENOUGH)
    await idle()
    expect(requests).toHaveLength(3)
    act(() => {
      editor.view.dom.dispatchEvent(new FocusEvent('blur'))
    })
    await answer(ok('3'))
    expect(ghostText()).toBeNull()
    type(ENOUGH)
    await idle()
    expect(requests).toHaveLength(4)
    hook.rerender({ nodeId: 'sc-2', active: true })
    await answer(ok('4'))
    expect(ghostText()).toBeNull()
  })

  it('clears a showing suggestion when the document switches or the mode turns off', async () => {
    const hook = mount()
    type(ENOUGH)
    await idle()
    await answer(ok('1'))
    expect(ghostText()).toBe(' Rain followed.')
    act(() => {
      useAiSettingsStore.setState({
        settings: settings({ ghostText: { enabled: false, idleMs: IDLE_MS } })
      })
    })
    expect(ghostText()).toBeNull()
    act(() => {
      useAiSettingsStore.setState({ settings: settings() })
    })
    type(ENOUGH)
    await idle()
    await answer(ok('2'))
    expect(ghostText()).toBe(' Rain followed.')
    hook.rerender({ nodeId: 'sc-2', active: true })
    expect(ghostText()).toBeNull()
  })

  it('turns VibeWrite off with one toast on DISABLED, NO_KEY, or INVALID_KEY, whatever the answer’s age', async () => {
    mount()
    type(ENOUGH)
    await idle()
    type('zz') // stale by the time it answers; the failure still counts
    await answer(fail('1', 'DISABLED'))
    expect(useAiSettingsStore.getState().settings?.ghostText.enabled).toBe(false)
    expect(toasts()).toEqual(['VibeWrite turned off: DISABLED happened. Do the thing.'])
    await idle(200)
    expect(settingsWrites.at(-1)?.ghostText).toEqual({ enabled: false, idleMs: IDLE_MS })
    // The author turns it back on: the next such failure toasts again, once.
    act(() => {
      useAiSettingsStore.getState().update({ ghostText: { enabled: true, idleMs: IDLE_MS } })
    })
    type(ENOUGH)
    await idle()
    expect(requests).toHaveLength(2)
    await answer(fail('2', 'NO_KEY'))
    expect(useAiSettingsStore.getState().settings?.ghostText.enabled).toBe(false)
    expect(toasts()).toHaveLength(2)
    act(() => {
      useAiSettingsStore.getState().update({ ghostText: { enabled: true, idleMs: IDLE_MS } })
    })
    type(ENOUGH)
    await idle()
    await answer(fail('3', 'INVALID_KEY'))
    expect(useAiSettingsStore.getState().settings?.ghostText.enabled).toBe(false)
    expect(toasts()).toHaveLength(3)
    expect(ghostText()).toBeNull()
  })

  it('shows any other failure in the indicator, without a toast, and backs off for 30 s', async () => {
    const hook = mount()
    type(ENOUGH)
    await idle()
    await answer(fail('1', 'RATE_LIMIT'))
    expect(hook.result.current.error).toBe('RATE_LIMIT happened. Do the thing.')
    expect(toasts()).toEqual([])
    expect(useAiSettingsStore.getState().settings?.ghostText.enabled).toBe(true)
    type(ENOUGH)
    await idle()
    expect(requests).toHaveLength(1)
    await idle(GHOST_BACKOFF_MS)
    type(ENOUGH)
    await idle()
    expect(requests).toHaveLength(2)
    await answer(ok('2'))
    expect(hook.result.current.error).toBeNull()
    expect(ghostText()).toBe(' Rain followed.')
  })

  it('treats a thrown request like a subtle failure', async () => {
    const hook = mount()
    type(ENOUGH)
    await idle()
    await act(async () => {
      requests[0]?.reject(new Error('bridge down'))
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(hook.result.current.error).toBe('bridge down')
    expect(toasts()).toEqual([])
  })

  it('stops at the per-day request cap and counts again on the next local day', async () => {
    mount()
    for (let i = 0; i < GHOST_MAX_PER_DAY; i++) {
      type(ENOUGH)
      await idle()
      await answer(ok(String(i + 1), ''))
    }
    expect(requests).toHaveLength(GHOST_MAX_PER_DAY)
    type(ENOUGH)
    await idle()
    expect(requests).toHaveLength(GHOST_MAX_PER_DAY)
    vi.setSystemTime(new Date(2026, 8, 14, 0, 0, 1))
    type(ENOUGH)
    await idle()
    expect(requests).toHaveLength(GHOST_MAX_PER_DAY + 1)
  })

  it('ignores its own accept and clear transactions when counting activity', async () => {
    mount()
    type(ENOUGH)
    await idle()
    await answer(ok('1'))
    act(() => {
      editor.commands.acceptGhost()
    })
    expect(editor.getText()).toBe(`${CONTENT}${ENOUGH} Rain followed.`)
    await idle()
    expect(requests).toHaveLength(1) // accepting is not typing: no new request
  })
})
