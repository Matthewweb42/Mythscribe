import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { defaultEditorSettings, type EditorSettings } from '@shared/editorSettings'
import type { Channel, Input, Output } from '@shared/ipc/contract'
import { resetPendingSaves } from '@renderer/features/project/pendingSaves'
import { useDialogStore } from '@renderer/features/shell/dialogs/dialogStore'
import { setIpcClient, type IpcClient } from '@renderer/lib/ipc'
import { EditorSettingsTab } from './EditorSettingsTab'
import { resetEditorSettingsStore, useEditorSettingsStore } from './settingsStore'

/** Records every `editorSettings:set` and resolves it at once. */
function recordingClient(): { client: IpcClient; sets: EditorSettings[] } {
  const sets: EditorSettings[] = []
  const client: IpcClient = {
    async invoke<C extends Channel>(channel: C, input: Input<C>): Promise<Output<C>> {
      if (channel !== 'editorSettings:set') throw new Error(`unexpected ${channel}`)
      const value = input as Input<'editorSettings:set'>
      sets.push(value)
      return value as Output<C>
    },
    on: () => () => {}
  }
  return { client, sets }
}

const novel = defaultEditorSettings('novel')
let sets: EditorSettings[]

const current = (): EditorSettings | null => useEditorSettingsStore.getState().settings
const button = (name: string): HTMLElement => screen.getByRole('button', { name })
const spin = (name: string): HTMLElement => screen.getByRole('spinbutton', { name })
const preview = (): HTMLElement => screen.getByTestId('editor-preview')
const previewBreak = (): HTMLElement | null => preview().querySelector('[data-scene-break]')

function open(): void {
  render(<EditorSettingsTab format="novel" />)
}

beforeEach(() => {
  resetEditorSettingsStore()
  resetPendingSaves()
  useDialogStore.setState({ modals: [], toasts: [] })
  const recording = recordingClient()
  sets = recording.sets
  setIpcClient(recording.client)
  useEditorSettingsStore.setState({ settings: { ...novel } })
})
// The store's debounced write outlives a test: cancel it here so it cannot fire into the next file's fake client.
afterEach(() => {
  resetEditorSettingsStore()
})

describe('EditorSettingsTab (F-3.6, F-7.5)', () => {
  it('shows the store values and follows a change made elsewhere', async () => {
    open()
    expect(spin('Font size')).toHaveValue(16)
    expect(spin('Line height')).toHaveValue(2)
    expect(spin('Paragraph spacing')).toHaveValue(0)
    expect(spin('First-line indent')).toHaveValue(1.5)
    expect(spin('Max width')).toHaveValue(700)
    expect(screen.getByRole('combobox', { name: 'Scene break' })).toHaveValue('* * *')
    expect(screen.queryByRole('textbox', { name: 'Custom scene break' })).not.toBeInTheDocument()

    act(() => useEditorSettingsStore.getState().update({ fontSize: 20, sceneBreak: '~ ~ ~' }))
    expect(spin('Font size')).toHaveValue(20)
    expect(screen.getByRole('combobox', { name: 'Scene break' })).toHaveValue('custom')
    expect(screen.getByRole('textbox', { name: 'Custom scene break' })).toHaveValue('~ ~ ~')
  })

  it('previews an in-range number as it is typed and clamps an out-of-range one on commit', async () => {
    open()
    const fontSize = spin('Font size')
    await userEvent.clear(fontSize)
    expect(current()?.fontSize).toBe(16) // nothing committed for an empty field
    await userEvent.type(fontSize, '2')
    expect(current()?.fontSize).toBe(16) // 2 is out of range: kept as a draft, not clamped to 12
    expect(fontSize).toHaveValue(2)
    await userEvent.type(fontSize, '0')
    expect(current()?.fontSize).toBe(20)
    expect(fontSize).toHaveValue(20)

    await userEvent.clear(fontSize)
    await userEvent.type(fontSize, '99')
    expect(current()?.fontSize).toBe(20)
    await userEvent.tab()
    expect(current()?.fontSize).toBe(24)
    expect(fontSize).toHaveValue(24)

    await userEvent.clear(fontSize)
    await userEvent.type(fontSize, '3{Enter}')
    expect(current()?.fontSize).toBe(12)
    expect(fontSize).toHaveValue(12)

    // Emptying the field and leaving restores the value.
    await userEvent.clear(fontSize)
    await userEvent.tab()
    expect(current()?.fontSize).toBe(12)
    expect(fontSize).toHaveValue(12)
  })

  it('updates each numeric setting with the right key', async () => {
    open()
    await userEvent.clear(spin('Line height'))
    await userEvent.type(spin('Line height'), '1.2')
    await userEvent.clear(spin('Paragraph spacing'))
    await userEvent.type(spin('Paragraph spacing'), '0.5')
    await userEvent.clear(spin('First-line indent'))
    await userEvent.type(spin('First-line indent'), '0')
    await userEvent.clear(spin('Max width'))
    await userEvent.type(spin('Max width'), '900')
    expect(current()).toEqual({
      ...novel,
      lineHeight: 1.2,
      paragraphSpacing: 0.5,
      paragraphIndent: 0,
      maxWidth: 900
    })
    // One debounced write carries the merged value.
    await waitFor(() => expect(sets).toHaveLength(1))
    expect(sets[0]).toEqual(current())
  })

  it('picks a scene-break preset, and Custom… reveals a field committed on Enter or blur', async () => {
    open()
    const select = screen.getByRole('combobox', { name: 'Scene break' })
    await userEvent.selectOptions(select, '###')
    expect(current()?.sceneBreak).toBe('###')
    expect(screen.queryByRole('textbox', { name: 'Custom scene break' })).not.toBeInTheDocument()

    await userEvent.selectOptions(select, 'Custom…')
    const custom = screen.getByRole('textbox', { name: 'Custom scene break' })
    expect(custom).toHaveValue('###')
    expect(custom).toHaveAttribute('maxlength', '20')
    expect(current()?.sceneBreak).toBe('###') // nothing changes until the text commits
    await userEvent.clear(custom)
    await userEvent.type(custom, '~ ~ ~{Enter}')
    expect(current()?.sceneBreak).toBe('~ ~ ~')
    expect(select).toHaveValue('custom')

    await userEvent.clear(custom)
    await userEvent.type(custom, '  ...  ')
    await userEvent.tab()
    expect(current()?.sceneBreak).toBe('...')
    expect(custom).toHaveValue('...')

    // Blank text is not a scene break: the field falls back to the value.
    await userEvent.clear(custom)
    await userEvent.tab()
    expect(current()?.sceneBreak).toBe('...')
    expect(custom).toHaveValue('...')

    await userEvent.selectOptions(select, '* * *')
    expect(current()?.sceneBreak).toBe('* * *')
    expect(screen.queryByRole('textbox', { name: 'Custom scene break' })).not.toBeInTheDocument()
  })

  it('resets every setting to the format defaults', async () => {
    useEditorSettingsStore.setState({
      settings: { ...novel, fontSize: 22, maxWidth: 950, sceneBreak: '###' }
    })
    render(<EditorSettingsTab format="webnovel" />)
    await userEvent.click(button('Reset to format defaults'))
    expect(current()).toEqual(defaultEditorSettings('webnovel'))
    expect(spin('Font size')).toHaveValue(16)
    expect(spin('Max width')).toHaveValue(700)
    expect(screen.getByRole('combobox', { name: 'Scene break' })).toHaveValue('~~~')
    await waitFor(() => expect(sets).toEqual([defaultEditorSettings('webnovel')]))
  })

  it('renders a live preview styled from the current settings (F-7.5)', async () => {
    useEditorSettingsStore.setState({
      settings: { ...novel, fontSize: 18, maxWidth: 800, sceneBreak: '###' }
    })
    open()
    const box = preview()
    expect(box).toHaveAccessibleName('Preview')
    expect(box.style.getPropertyValue('--ms-editor-font-size')).toBe('18px')
    expect(box.style.getPropertyValue('--ms-editor-max-width')).toBe('800px')
    expect(box.style.getPropertyValue('--ms-editor-line-height')).toBe('2')
    expect(box.style.getPropertyValue('--ms-editor-paragraph-spacing')).toBe('0em')
    expect(box.style.getPropertyValue('--ms-editor-paragraph-indent')).toBe('1.5em')
    // The sample uses the editor's own classes, so `app.css` styles it like the real pane.
    const sample = box.querySelector('.ms-editor')
    expect(sample).toHaveClass('max-w-(--ms-editor-max-width)', 'mx-auto', 'w-full')
    expect(sample?.querySelectorAll('p').length).toBeGreaterThanOrEqual(3)
    expect(previewBreak()).toHaveTextContent('###')
    expect(previewBreak()).toHaveClass('scene-break')

    // A control change restyles the same nodes; nothing remounts.
    const sampleBreak = previewBreak()
    await userEvent.clear(spin('Font size'))
    await userEvent.type(spin('Font size'), '22')
    expect(box.style.getPropertyValue('--ms-editor-font-size')).toBe('22px')
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Scene break' }), '~~~')
    expect(previewBreak()).toBe(sampleBreak)
    expect(previewBreak()).toHaveTextContent('~~~')
    expect(preview()).toBe(box)
  })
})
