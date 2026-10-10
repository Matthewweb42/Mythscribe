import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { normalizeAssistantName } from '@shared/assistantName'
import type { Channel, Input, Output } from '@shared/ipc/contract'
import {
  THEME_NEEDS_LICENSE_MESSAGE,
  builtInTheme,
  type CustomTheme,
  type CustomThemeInput
} from '@shared/themes'
import { defaultViewSettings, nextZoom, type ViewSettings } from '@shared/zoom'
import { resetAccountStore, useAccountStore } from '@renderer/features/account/accountStore'
import { useDialogStore } from '@renderer/features/shell/dialogs/dialogStore'
import { setIpcClient, type IpcClient } from '@renderer/lib/ipc'
import { currentAssistantName, resetViewStore, useViewStore } from './viewStore'

interface Fake {
  client: IpcClient
  calls: { channel: Channel; input: unknown }[]
  /** What main holds; it steps and answers exactly as the handlers do. */
  view: ViewSettings
  /** Thrown by every channel while set, so the failure path is driven. */
  fail: Error | null
}

function fakeClient(): Fake {
  const fake: Fake = {
    calls: [],
    view: defaultViewSettings(),
    fail: null,
    client: {
      async invoke<C extends Channel>(channel: C, input: Input<C>): Promise<Output<C>> {
        fake.calls.push({ channel, input })
        if (fake.fail) throw fake.fail
        switch (channel) {
          case 'view:get':
            return fake.view as Output<C>
          case 'view:zoomDocument': {
            const { step } = input as { step: 'in' | 'out' | 'reset' }
            fake.view = { ...fake.view, editorZoom: nextZoom(fake.view.editorZoom, step) }
            return fake.view as Output<C>
          }
          case 'view:setUiScale': {
            const { scale } = input as { scale: ViewSettings['uiScale'] }
            fake.view = { ...fake.view, uiScale: scale }
            return fake.view as Output<C>
          }
          case 'view:setPageEdges': {
            const { on } = input as { on: boolean }
            fake.view = { ...fake.view, pageEdges: on }
            return fake.view as Output<C>
          }
          case 'view:setTheme': {
            const { theme } = input as { theme: string }
            fake.view = { ...fake.view, theme }
            return fake.view as Output<C>
          }
          case 'view:saveCustomTheme': {
            const { theme } = input as { theme: CustomThemeInput }
            const saved: CustomTheme = { ...theme, id: theme.id ?? 'custom-a1b2c3d4e5f6' }
            const others = fake.view.customThemes.filter((t) => t.id !== saved.id)
            fake.view = { ...fake.view, theme: saved.id, customThemes: [...others, saved] }
            return fake.view as Output<C>
          }
          case 'view:deleteCustomTheme': {
            const { id } = input as { id: string }
            const gone = fake.view.customThemes.find((t) => t.id === id)
            fake.view = {
              ...fake.view,
              theme: fake.view.theme === id && gone ? gone.base : fake.view.theme,
              customThemes: fake.view.customThemes.filter((t) => t.id !== id)
            }
            return fake.view as Output<C>
          }
          case 'view:setAssistantName': {
            const { name } = input as { name: string }
            fake.view = { ...fake.view, assistantName: normalizeAssistantName(name) }
            return fake.view as Output<C>
          }
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

const toasts = (): string[] => useDialogStore.getState().toasts.map((t) => t.message)

beforeEach(() => {
  fake = fakeClient()
  setIpcClient(fake.client)
  resetViewStore()
  resetAccountStore()
  useDialogStore.setState({ modals: [], toasts: [] })
})

afterEach(() => {
  resetViewStore()
  resetAccountStore()
})

describe('viewStore (F-7.10)', () => {
  it('starts at the installed defaults and takes the persisted values on load', async () => {
    expect(useViewStore.getState()).toMatchObject({
      editorZoom: 1,
      uiScale: 'medium',
      pageEdges: true,
      loaded: false
    })
    fake.view = { ...defaultViewSettings(), editorZoom: 1.25, uiScale: 'large', pageEdges: false }
    await useViewStore.getState().load()
    expect(useViewStore.getState()).toMatchObject({
      editorZoom: 1.25,
      uiScale: 'large',
      pageEdges: false,
      theme: 'dark',
      customThemes: [],
      loaded: true
    })
    expect(fake.calls).toEqual([{ channel: 'view:get', input: undefined }])
  })

  it('steps the document zoom and announces where it landed', async () => {
    await useViewStore.getState().zoomDocument('in')
    expect(fake.calls).toEqual([{ channel: 'view:zoomDocument', input: { step: 'in' } }])
    expect(useViewStore.getState().editorZoom).toBe(1.1)
    await useViewStore.getState().zoomDocument('in')
    expect(useViewStore.getState().editorZoom).toBe(1.25)
    await useViewStore.getState().zoomDocument('reset')
    expect(useViewStore.getState().editorZoom).toBe(1)
    expect(toasts()).toEqual(['Document zoom 110 %', 'Document zoom 125 %', 'Document zoom 100 %'])
  })

  it('sets the interface size without a toast: the window is already resized when main answers', async () => {
    await useViewStore.getState().setUiScale('large')
    expect(fake.calls).toEqual([{ channel: 'view:setUiScale', input: { scale: 'large' } }])
    expect(useViewStore.getState().uiScale).toBe('large')
    expect(toasts()).toEqual([])
  })

  it('keeps the two apart: a zoom leaves the size alone and the other way round', async () => {
    await useViewStore.getState().setUiScale('small')
    await useViewStore.getState().zoomDocument('out')
    expect(useViewStore.getState()).toMatchObject({ editorZoom: 0.9, uiScale: 'small' })
  })

  it('sets the page edges silently from Settings and toasts the flip from the menu (F-7.11)', async () => {
    await useViewStore.getState().setPageEdges(false)
    expect(fake.calls).toEqual([{ channel: 'view:setPageEdges', input: { on: false } }])
    expect(useViewStore.getState().pageEdges).toBe(false)
    expect(toasts()).toEqual([])
    await useViewStore.getState().togglePageEdges()
    expect(fake.calls.at(-1)).toEqual({ channel: 'view:setPageEdges', input: { on: true } })
    expect(useViewStore.getState().pageEdges).toBe(true)
    await useViewStore.getState().togglePageEdges()
    expect(useViewStore.getState().pageEdges).toBe(false)
    expect(toasts()).toEqual(['Page edges shown', 'Page edges hidden'])
    // The other two are untouched.
    expect(useViewStore.getState()).toMatchObject({ editorZoom: 1, uiScale: 'medium' })
  })

  it('toasts the cause of a failure and changes nothing', async () => {
    fake.fail = new Error('no window')
    await useViewStore.getState().zoomDocument('in')
    await useViewStore.getState().setUiScale('large')
    await useViewStore.getState().togglePageEdges()
    expect(useViewStore.getState()).toMatchObject({
      editorZoom: 1,
      uiScale: 'medium',
      pageEdges: true
    })
    expect(toasts()).toEqual(['no window', 'no window', 'no window'])
  })

  it('drops an answer to a request the reset superseded', async () => {
    const pending = useViewStore.getState().zoomDocument('in')
    resetViewStore()
    await pending
    expect(useViewStore.getState()).toMatchObject({ editorZoom: 1, loaded: false })
  })
})

const MIDNIGHT: CustomThemeInput = {
  name: 'Midnight',
  base: 'dark',
  colors: { ...builtInTheme('dark').colors, bg: '#000814' }
}

function license(licensed: boolean): void {
  useAccountStore.setState({
    supporter: {
      licensed,
      since: licensed ? '2026-09-20T10:00:00.000Z' : null,
      validUntil: null,
      offline: false,
      product: null,
      accent: 'default'
    }
  })
}

describe('viewStore themes (F-7.8)', () => {
  it('sets a theme silently from Settings', async () => {
    await useViewStore.getState().setTheme('light')
    expect(fake.calls).toEqual([{ channel: 'view:setTheme', input: { theme: 'light' } }])
    expect(useViewStore.getState().theme).toBe('light')
    expect(toasts()).toEqual([])
  })

  it('switches through the free themes without a license, naming each one', async () => {
    for (let i = 0; i < 3; i++) await useViewStore.getState().switchTheme()
    expect(fake.calls.map((c) => c.input)).toEqual([
      { theme: 'light' },
      { theme: 'high-contrast' },
      { theme: 'dark' }
    ])
    expect(toasts()).toEqual(['Theme: Light', 'Theme: High contrast', 'Theme: Dark'])
  })

  it('switches through Sepia and the custom themes with a license', async () => {
    license(true)
    await useViewStore.getState().saveCustomTheme(MIDNIGHT)
    await useViewStore.getState().setTheme('high-contrast')
    await useViewStore.getState().switchTheme()
    await useViewStore.getState().switchTheme()
    await useViewStore.getState().switchTheme()
    expect(fake.calls.slice(-3).map((c) => c.input)).toEqual([
      { theme: 'sepia' },
      { theme: 'custom-a1b2c3d4e5f6' },
      { theme: 'dark' }
    ])
    expect(toasts()).toEqual(['Theme: Sepia', 'Theme: Midnight', 'Theme: Dark'])
  })

  it('saves a custom theme, selects it, and reports success; a refusal toasts and reports failure', async () => {
    license(true)
    expect(await useViewStore.getState().saveCustomTheme(MIDNIGHT)).toBe(true)
    expect(useViewStore.getState()).toMatchObject({
      theme: 'custom-a1b2c3d4e5f6',
      customThemes: [{ ...MIDNIGHT, id: 'custom-a1b2c3d4e5f6' }]
    })
    fake.fail = new Error(THEME_NEEDS_LICENSE_MESSAGE)
    expect(await useViewStore.getState().saveCustomTheme(MIDNIGHT)).toBe(false)
    expect(toasts()).toEqual([THEME_NEEDS_LICENSE_MESSAGE])
  })

  it('deletes a custom theme and takes main’s fallback to its base', async () => {
    license(true)
    await useViewStore.getState().saveCustomTheme({ ...MIDNIGHT, base: 'sepia' })
    await useViewStore.getState().deleteCustomTheme('custom-a1b2c3d4e5f6')
    expect(fake.calls.at(-1)).toEqual({
      channel: 'view:deleteCustomTheme',
      input: { id: 'custom-a1b2c3d4e5f6' }
    })
    expect(useViewStore.getState()).toMatchObject({ theme: 'sepia', customThemes: [] })
  })

  it('renames the assistant through main and mirrors the answer; a failure toasts and keeps the name (F-7.12)', async () => {
    expect(currentAssistantName()).toBe('Ms Scribe')
    await useViewStore.getState().setAssistantName('  Quill ')
    expect(fake.calls.at(-1)).toEqual({
      channel: 'view:setAssistantName',
      input: { name: '  Quill ' }
    })
    expect(currentAssistantName()).toBe('Quill')
    await useViewStore.getState().setAssistantName('')
    expect(currentAssistantName()).toBe('Ms Scribe')
    fake.fail = new Error('disk full')
    await useViewStore.getState().setAssistantName('Nib')
    expect(currentAssistantName()).toBe('Ms Scribe')
    expect(toasts()).toEqual(['disk full'])
  })
})
