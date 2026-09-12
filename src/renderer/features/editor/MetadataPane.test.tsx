import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Channel, Input, Output } from '@shared/ipc/contract'
import { EMPTY_SCENE_META, type SceneMeta } from '@shared/sceneMeta'
import { resetPendingSaves } from '@renderer/features/project/pendingSaves'
import { useDialogStore } from '@renderer/features/shell/dialogs/dialogStore'
import { tagFixture } from '@renderer/features/tags/tagFixture'
import { orderedIds, resetTagStore, useTagStore } from '@renderer/features/tags/tagStore'
import { setIpcClient, type IpcClient } from '@renderer/lib/ipc'
import { MetadataPane } from './MetadataPane'
import { resetSceneMetaStore, useSceneMetaStore } from './sceneMetaStore'

const stored: Record<string, SceneMeta> = {
  'sc-1': { location: 'dark-forest', pov: 'mara', timeline: 'Day 1' }
}

/** `sceneMeta:get` answers from `stored` (once released); `sceneMeta:set` records its input. */
function install(): { sets: Input<'sceneMeta:set'>[]; release: () => void } {
  const sets: Input<'sceneMeta:set'>[] = []
  let release: () => void = () => {}
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const client: IpcClient = {
    async invoke<C extends Channel>(channel: C, input: Input<C>): Promise<Output<C>> {
      if (channel === 'sceneMeta:get') {
        const { id } = input as Input<'sceneMeta:get'>
        await gate
        return { id, meta: stored[id] ?? { ...EMPTY_SCENE_META } } as Output<C>
      }
      if (channel === 'sceneMeta:set') {
        sets.push(input as Input<'sceneMeta:set'>)
        return { modified: 'm' } as Output<C>
      }
      throw new Error(`unexpected ${channel}`)
    },
    on: () => () => {}
  }
  setIpcClient(client)
  return { sets, release }
}

const field = (name: string): HTMLElement => screen.getByRole('combobox', { name })
const timeline = (): HTMLElement => screen.getByRole('textbox', { name: 'Timeline' })
const toasts = (): string[] => useDialogStore.getState().toasts.map((t) => t.message)

beforeEach(() => {
  resetPendingSaves()
  resetTagStore()
  resetSceneMetaStore()
  useDialogStore.setState({ modals: [], toasts: [] })
  const byId = Object.fromEntries(tagFixture.map((t) => [t.id, t]))
  useTagStore.setState({ byId, ids: orderedIds(byId), loaded: true })
})
afterEach(() => {
  resetSceneMetaStore()
})

describe('MetadataPane (F-4.5)', () => {
  it('disables the fields until the load resolves, then shows the stored values', async () => {
    const { release } = install()
    render(<MetadataPane id="sc-1" />)
    expect(screen.getByRole('group', { name: 'Scene metadata' })).toBeInTheDocument()
    expect(field('Location')).toBeDisabled()
    expect(field('POV')).toBeDisabled()
    expect(timeline()).toBeDisabled()
    release()
    await waitFor(() => expect(field('Location')).toBeEnabled())
    expect(field('Location')).toHaveValue('dark-forest')
    expect(field('POV')).toHaveValue('mara')
    expect(timeline()).toHaveValue('Day 1')
  })

  it('suggests only setting tags for Location and only character tags for POV', async () => {
    const { release } = install()
    release()
    render(<MetadataPane id="sc-2" />)
    await waitFor(() => expect(field('Location')).toBeEnabled())
    fireEvent.change(field('Location'), { target: { value: 'd' } })
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual(['dark-forest'])
    fireEvent.keyDown(field('Location'), { key: 'Escape' })
    fireEvent.change(field('POV'), { target: { value: 'm' } })
    // "moody" is a tone tag and "mara" a character: only the character is offered.
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual(['mara'])
  })

  it('every edit goes through the autosave store and flushes as one merged record', async () => {
    const { sets, release } = install()
    release()
    render(<MetadataPane id="sc-1" />)
    await waitFor(() => expect(field('Location')).toBeEnabled())
    fireEvent.change(field('Location'), { target: { value: 'docks' } })
    fireEvent.change(timeline(), { target: { value: 'Day 2, dawn' } })
    expect(field('Location')).toHaveValue('docks')
    expect(useSceneMetaStore.getState().docs['sc-1']?.dirty).toBe(true)
    expect(sets).toHaveLength(0)
    await act(() => useSceneMetaStore.getState().flush())
    expect(sets).toEqual([
      { id: 'sc-1', meta: { location: 'docks', pov: 'mara', timeline: 'Day 2, dawn' } }
    ])
    expect(useSceneMetaStore.getState().docs['sc-1']?.dirty).toBe(false)
  })

  it('unloads the record when it unmounts and reloads for a new id', async () => {
    const { release } = install()
    release()
    const view = render(<MetadataPane id="sc-1" />)
    await waitFor(() => expect(field('Location')).toHaveValue('dark-forest'))
    view.rerender(<MetadataPane id="sc-2" />)
    await waitFor(() => expect(field('Location')).toBeEnabled())
    expect(field('Location')).toHaveValue('')
    expect(useSceneMetaStore.getState().docs['sc-1']).toBeUndefined()
    view.unmount()
    expect(useSceneMetaStore.getState().docs['sc-2']).toBeUndefined()
    expect(toasts()).toEqual([])
  })
})
