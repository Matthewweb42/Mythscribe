import { Editor } from '@tiptap/core'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Channel, Input, Output, VoiceExemplar } from '@shared/ipc/contract'
import { VOICE_EXEMPLAR_MAX } from '@shared/voice'
import { resetVoiceStore, useVoiceStore } from '@renderer/features/ai/voiceStore'
import { useDialogStore } from '@renderer/features/shell/dialogs/dialogStore'
import { IpcRequestError, setIpcClient, type IpcClient } from '@renderer/lib/ipc'
import { buildExtensions } from './extensions'
import { MarkVoiceExemplarButton } from './MarkVoiceExemplarButton'
import { selectedText } from './selectedText'

const FIRST = 'Mara turned from the window and looked at the ridge, where the storm had settled.'
const SECOND = 'She knew she was tired, and she thought about the river and what it wanted.'

let host: HTMLDivElement
let editor: Editor
let calls: { channel: Channel; input: unknown }[]
/** What `voice:addExemplar` answers; a thrown value rejects. */
let addAnswer: (input: Input<'voice:addExemplar'>) => VoiceExemplar

const exemplar = (text: string, id = 'e-new'): VoiceExemplar => ({
  id,
  nodeId: 'scene-1',
  text,
  pov: null,
  kind: 'mixed',
  created: '2026-09-14T08:00:00.000Z'
})

const button = (): HTMLElement => screen.getByRole('button', { name: 'Mark voice exemplar' })
const toasts = (): string[] => useDialogStore.getState().toasts.map((t) => t.message)
/** Selects `from`..`to` in the editor; a plain paragraph starts at position 1. */
const select = (from: number, to: number): boolean => editor.commands.setTextSelection({ from, to })

beforeEach(() => {
  resetVoiceStore()
  useDialogStore.setState({ modals: [], toasts: [] })
  calls = []
  addAnswer = ({ text }) => exemplar(text)
  const client: IpcClient = {
    async invoke<C extends Channel>(channel: C, input: Input<C>): Promise<Output<C>> {
      calls.push({ channel, input })
      if (channel === 'voice:addExemplar') {
        return addAnswer(input as Input<'voice:addExemplar'>) as Output<C>
      }
      throw new Error(`unexpected ${channel}`)
    },
    on: () => () => {}
  }
  setIpcClient(client)
  useVoiceStore.setState({ exemplars: [] })
  host = document.createElement('div')
  document.body.appendChild(host)
  editor = new Editor({
    element: host,
    extensions: buildExtensions({ sceneBreak: '* * *', onSave: () => {}, inlineTagNodeId: 'n' }),
    content: {
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: FIRST }] },
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'Tagged ' },
            { type: 'inlineTag', attrs: { id: 't1', name: 'dark-forest' } },
            { type: 'text', text: ` ${SECOND}` }
          ]
        }
      ]
    }
  })
})
afterEach(() => {
  editor.destroy()
  host.remove()
  resetVoiceStore()
})

describe('selectedText', () => {
  it('joins blocks with newlines and renders inline tags as #name, trimmed', () => {
    select(1, editor.state.doc.content.size - 1)
    expect(selectedText(editor)).toBe(`${FIRST}\nTagged #dark-forest ${SECOND}`)
    select(1, 5)
    expect(selectedText(editor)).toBe('Mara')
  })
})

describe('MarkVoiceExemplarButton (F-14.1)', () => {
  it('is disabled without an editor or with a selection under 80 characters, and says what to select', () => {
    const { rerender } = render(<MarkVoiceExemplarButton editor={null} nodeId="scene-1" />)
    expect(button()).toBeDisabled()
    rerender(<MarkVoiceExemplarButton editor={editor} nodeId="scene-1" />)
    expect(button()).toBeDisabled()
    expect(button()).toHaveAttribute(
      'title',
      'Select 80–2,000 characters to mark them as a voice exemplar'
    )
    select(1, 40)
    expect(button()).toBeDisabled()
  })

  it('enables for 80–2,000 characters and disables over the limit with the reason', async () => {
    render(<MarkVoiceExemplarButton editor={editor} nodeId="scene-1" />)
    select(1, FIRST.length + 1)
    await waitFor(() => expect(button()).toBeEnabled())
    expect(button()).toHaveAttribute('title', 'Mark the selection as a voice exemplar')
    editor.commands.setContent({
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'x'.repeat(2_001) }] }]
    })
    editor.commands.selectAll()
    await waitFor(() => expect(button()).toBeDisabled())
    expect(button()).toHaveAttribute('title', 'The selection is over 2,000 characters')
  })

  it('is disabled once the project holds twelve exemplars', async () => {
    useVoiceStore.setState({
      exemplars: Array.from({ length: VOICE_EXEMPLAR_MAX }, (_, i) => exemplar(FIRST, `e${i}`))
    })
    render(<MarkVoiceExemplarButton editor={editor} nodeId="scene-1" />)
    select(1, FIRST.length + 1)
    await waitFor(() =>
      expect(button()).toHaveAttribute(
        'title',
        'Your voice profile already holds 12 exemplars (remove one in Settings, AI tab)'
      )
    )
    expect(button()).toBeDisabled()
  })

  it('marks the selected text through the store and toasts the new count', async () => {
    render(<MarkVoiceExemplarButton editor={editor} nodeId="scene-1" />)
    select(1, FIRST.length + 1)
    await waitFor(() => expect(button()).toBeEnabled())
    await userEvent.click(button())
    await waitFor(() => expect(toasts()).toEqual(['Added to your voice profile (1 of 12)']))
    expect(calls).toEqual([
      { channel: 'voice:addExemplar', input: { nodeId: 'scene-1', text: FIRST } }
    ])
    expect(useVoiceStore.getState().exemplars?.map((e) => e.text)).toEqual([FIRST])
    // The selection survived the click: the button is still enabled for the same text.
    expect(selectedText(editor)).toBe(FIRST)
  })

  it('toasts a refusal and adds nothing', async () => {
    addAnswer = () => {
      throw new IpcRequestError({
        code: 'VALIDATION',
        message: 'A voice profile holds at most 12 exemplars. Remove one to add another.'
      })
    }
    render(<MarkVoiceExemplarButton editor={editor} nodeId="scene-1" />)
    select(1, FIRST.length + 1)
    await waitFor(() => expect(button()).toBeEnabled())
    await userEvent.click(button())
    await waitFor(() =>
      expect(toasts()).toEqual([
        'A voice profile holds at most 12 exemplars. Remove one to add another.'
      ])
    )
    expect(useVoiceStore.getState().exemplars).toEqual([])
  })
})
