import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Channel, Input, Output } from '@shared/ipc/contract'
import {
  PRESETS,
  STYLE_INSTRUCTION_MAX,
  builtinParams,
  defaultWritingPresets,
  type WritingPresets
} from '@shared/presets'
import { useDialogStore } from '@renderer/features/shell/dialogs/dialogStore'
import { setIpcClient, IpcRequestError, type IpcClient } from '@renderer/lib/ipc'
import { WritingPresetsSection } from './WritingPresetsSection'
import { resetPresetsStore, usePresetsStore } from './presetsStore'

interface Fake {
  client: IpcClient
  calls: { channel: Channel; input: unknown }[]
  settings: WritingPresets
  /** What `presets:set` answers; by default the sent value. */
  setAnswer: (value: WritingPresets) => WritingPresets
}

function fakeClient(initial: WritingPresets): Fake {
  const calls: Fake['calls'] = []
  const fake: Fake = {
    calls,
    settings: initial,
    setAnswer: (value) => value,
    client: {
      async invoke<C extends Channel>(channel: C, input: Input<C>): Promise<Output<C>> {
        calls.push({ channel, input })
        switch (channel) {
          case 'presets:get':
            return fake.settings as Output<C>
          case 'presets:set':
            fake.settings = fake.setAnswer(input as Input<'presets:set'>)
            return fake.settings as Output<C>
          default:
            throw new Error(`unexpected ${channel}`)
        }
      },
      on: () => () => {}
    }
  }
  return fake
}

let fake: Fake
const radio = (name: string): HTMLElement => screen.getByRole('radio', { name })
const params = (): HTMLElement => screen.getByTestId('preset-params')
/** The read-only lines as `{ term: definition }`, in the order the list shows them. */
const paramLines = (): Record<string, string> =>
  Object.fromEntries(
    Array.from(params().querySelectorAll('dt')).map((dt) => [
      dt.textContent,
      dt.nextElementSibling?.textContent ?? ''
    ])
  )
const instruction = (): HTMLElement =>
  screen.getByLabelText('Style instruction', { selector: 'textarea' })
const temperature = (): HTMLElement => screen.getByRole('spinbutton', { name: 'Temperature' })
const tokens = (): HTMLElement => screen.getByRole('spinbutton', { name: 'Max length (tokens)' })
const newElements = (): HTMLElement =>
  screen.getByRole('checkbox', { name: 'May introduce new plot elements' })
const sets = (): WritingPresets[] =>
  fake.calls.filter((c) => c.channel === 'presets:set').map((c) => c.input as WritingPresets)
const toasts = (): string[] => useDialogStore.getState().toasts.map((t) => t.message)

/** Renders the section with `initial` loaded, the way `App.tsx` loads it with the project. */
async function open(initial: WritingPresets = defaultWritingPresets()): Promise<void> {
  fake = fakeClient(initial)
  setIpcClient(fake.client)
  render(<WritingPresetsSection />)
  await usePresetsStore.getState().load()
  await screen.findByRole('radiogroup', { name: 'Writing preset' })
}

const CUSTOM: WritingPresets = {
  active: 'custom',
  custom: { ...builtinParams('general'), styleInstruction: 'Keep it clipped.' }
}

beforeEach(() => {
  resetPresetsStore()
  useDialogStore.setState({ modals: [], toasts: [] })
})
afterEach(() => {
  resetPresetsStore()
})

describe('WritingPresetsSection (F-5.2)', () => {
  it('renders nothing until the presets load, then the seven presets with General checked and its params', async () => {
    fake = fakeClient(defaultWritingPresets())
    setIpcClient(fake.client)
    render(<WritingPresetsSection />)
    expect(screen.queryByRole('radiogroup')).not.toBeInTheDocument()
    await usePresetsStore.getState().load()
    const group = await screen.findByRole('radiogroup', { name: 'Writing preset' })
    const radios = within(group).getAllByRole('radio')
    expect(radios.map((r) => r.getAttribute('aria-checked'))).toEqual([
      'true',
      'false',
      'false',
      'false',
      'false',
      'false',
      'false'
    ])
    expect(radios.map((r) => r.getAttribute('tabindex'))).toEqual([
      '0',
      '-1',
      '-1',
      '-1',
      '-1',
      '-1',
      '-1'
    ])
    expect(radio('General')).toHaveAccessibleDescription(PRESETS.general.blurb)
    expect(radio('Action')).toHaveAccessibleDescription(PRESETS.action.blurb)
    expect(radio('Suspense/Mystery')).toHaveAccessibleDescription(PRESETS.suspense.blurb)
    expect(radio('Dialogue')).toHaveAccessibleDescription(PRESETS.dialogue.blurb)
    expect(radio('Romance')).toHaveAccessibleDescription(PRESETS.romance.blurb)
    expect(radio('World Building')).toHaveAccessibleDescription(PRESETS.worldBuilding.blurb)
    expect(radio('Custom')).toHaveAccessibleDescription(/Your own instruction/)
    expect(screen.getByText('Writing presets')).toBeInTheDocument()
    expect(paramLines()).toEqual({
      Temperature: '0.8',
      'Max length': '40 tokens',
      'New elements': 'No',
      Instruction: PRESETS.general.styleInstruction
    })
    expect(screen.queryByTestId('preset-custom')).not.toBeInTheDocument()
  })

  it('selects a built-in on click, shows its read-only params, and writes once after the debounce', async () => {
    await open()
    await userEvent.click(radio('World Building'))
    expect(radio('World Building')).toHaveAttribute('aria-checked', 'true')
    expect(radio('General')).toHaveAttribute('aria-checked', 'false')
    expect(screen.getAllByTestId('preset-params')).toHaveLength(1)
    expect(paramLines()).toEqual({
      Temperature: '0.7',
      'Max length': '50 tokens',
      'New elements': 'Yes',
      Instruction: PRESETS.worldBuilding.styleInstruction
    })
    await waitFor(() => expect(sets()).toHaveLength(1))
    expect(sets()[0]).toEqual({ ...defaultWritingPresets(), active: 'worldBuilding' })
  })

  it('moves and selects with the arrow keys, Home, and End', async () => {
    await open()
    radio('General').focus()
    await userEvent.keyboard('{ArrowDown}')
    expect(radio('Action')).toHaveAttribute('aria-checked', 'true')
    expect(radio('Action')).toHaveFocus()
    await userEvent.keyboard('{ArrowRight}{ArrowRight}')
    expect(radio('Dialogue')).toHaveAttribute('aria-checked', 'true')
    await userEvent.keyboard('{End}')
    expect(radio('Custom')).toHaveAttribute('aria-checked', 'true')
    expect(radio('Custom')).toHaveFocus()
    expect(screen.getByTestId('preset-custom')).toBeInTheDocument()
    await userEvent.keyboard('{ArrowDown}')
    expect(radio('General')).toHaveAttribute('aria-checked', 'true') // wraps
    await userEvent.keyboard('{ArrowUp}')
    expect(radio('Custom')).toHaveAttribute('aria-checked', 'true')
    await userEvent.keyboard('{Home}')
    expect(radio('General')).toHaveAttribute('aria-checked', 'true')
    expect(radio('General')).toHaveFocus()
    await waitFor(() => expect(sets()).toHaveLength(1))
    expect(sets()[0]?.active).toBe('general')
  })

  it('arrow keys inside the Custom textarea move the caret, not the radiogroup selection', async () => {
    await open(CUSTOM)
    await userEvent.click(radio('Custom'))
    expect(radio('Custom')).toHaveAttribute('aria-checked', 'true')
    instruction().focus()
    await userEvent.keyboard('{ArrowUp}{ArrowDown}{ArrowLeft}{ArrowRight}{Home}{End}')
    expect(radio('Custom')).toHaveAttribute('aria-checked', 'true')
    expect(radio('General')).toHaveAttribute('aria-checked', 'false')
    expect(instruction()).toHaveFocus()
    expect(sets()).toHaveLength(0)
  })

  it('selecting Custom reveals the four fields seeded from the stored custom params', async () => {
    await open()
    await userEvent.click(radio('Custom'))
    expect(screen.queryByTestId('preset-params')).not.toBeInTheDocument()
    expect(instruction()).toHaveValue(PRESETS.general.styleInstruction)
    expect(instruction()).toHaveAttribute('maxlength', String(STYLE_INSTRUCTION_MAX))
    expect(instruction()).toHaveAccessibleDescription(
      `${PRESETS.general.styleInstruction.length}/${STYLE_INSTRUCTION_MAX}`
    )
    expect(temperature()).toHaveValue(0.8)
    expect(temperature()).toHaveAttribute('min', '0')
    expect(temperature()).toHaveAttribute('max', '1.5')
    expect(temperature()).toHaveAttribute('step', '0.1')
    expect(tokens()).toHaveValue(40)
    expect(tokens()).toHaveAttribute('min', '20')
    expect(tokens()).toHaveAttribute('max', '60')
    expect(newElements()).not.toBeChecked()
    await waitFor(() => expect(sets()).toHaveLength(1))
    expect(sets()[0]?.active).toBe('custom')
  })

  it('commits the instruction on blur with the whole custom object, counting characters as typed', async () => {
    await open(CUSTOM)
    await userEvent.clear(instruction())
    await userEvent.type(instruction(), 'Be terse.')
    expect(instruction()).toHaveAccessibleDescription(`9/${STYLE_INSTRUCTION_MAX}`)
    expect(sets()).toHaveLength(0)
    await userEvent.tab()
    await waitFor(() => expect(sets()).toHaveLength(1))
    expect(sets()[0]).toEqual({
      active: 'custom',
      custom: { ...CUSTOM.custom, styleInstruction: 'Be terse.' }
    })
  })

  it('a blank instruction commit restores the saved value without a write; an over-long one is cut to the cap', async () => {
    await open(CUSTOM)
    await userEvent.clear(instruction())
    expect(instruction()).toHaveValue('')
    await userEvent.tab()
    expect(instruction()).toHaveValue('Keep it clipped.')
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(sets()).toHaveLength(0)
    fireEvent.change(instruction(), { target: { value: 'x'.repeat(STYLE_INSTRUCTION_MAX + 5) } })
    fireEvent.blur(instruction())
    await waitFor(() => expect(sets()).toHaveLength(1))
    expect(sets()[0]?.custom.styleInstruction).toBe('x'.repeat(STYLE_INSTRUCTION_MAX))
    expect(instruction()).toHaveValue('x'.repeat(STYLE_INSTRUCTION_MAX))
  })

  it('clamps temperature and max length on commit and previews in-range values as typed', async () => {
    await open(CUSTOM)
    await userEvent.clear(temperature())
    await userEvent.type(temperature(), '5')
    expect(temperature()).toHaveValue(5)
    await userEvent.tab()
    expect(temperature()).toHaveValue(1.5)
    await userEvent.clear(tokens())
    await userEvent.type(tokens(), '3')
    await userEvent.keyboard('{Enter}')
    expect(tokens()).toHaveValue(20)
    await userEvent.clear(tokens())
    await userEvent.type(tokens(), '55')
    expect(tokens()).toHaveValue(55)
    await waitFor(() => expect(sets().length).toBeGreaterThan(0))
    await waitFor(() =>
      expect(sets().at(-1)).toEqual({
        active: 'custom',
        custom: { ...CUSTOM.custom, temperature: 1.5, maxSuggestionTokens: 55 }
      })
    )
  })

  it('writes the new-elements checkbox at once', async () => {
    await open(CUSTOM)
    await userEvent.click(newElements())
    expect(newElements()).toBeChecked()
    await waitFor(() => expect(sets()).toHaveLength(1))
    expect(sets()[0]).toEqual({
      active: 'custom',
      custom: { ...CUSTOM.custom, allowNewElements: true }
    })
    await userEvent.click(newElements())
    expect(newElements()).not.toBeChecked()
    await waitFor(() => expect(sets()).toHaveLength(2))
    expect(sets()[1]?.custom.allowNewElements).toBe(false)
  })

  it('reverts and toasts when the write is refused', async () => {
    await open()
    fake.setAnswer = () => {
      throw new IpcRequestError({ code: 'IO', message: 'Disk is read-only' })
    }
    await userEvent.click(radio('Romance'))
    expect(radio('Romance')).toHaveAttribute('aria-checked', 'true')
    await waitFor(() => expect(toasts()).toEqual(['Disk is read-only']))
    expect(radio('General')).toHaveAttribute('aria-checked', 'true')
    expect(params()).toHaveTextContent(PRESETS.general.styleInstruction)
  })
})
