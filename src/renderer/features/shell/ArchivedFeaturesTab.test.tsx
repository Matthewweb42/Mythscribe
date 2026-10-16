import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  ARCHIVABLE_FEATURES,
  isArchived,
  isStoryBibleArchived,
  withArchived
} from '@shared/archivedFeatures'
import { defaultEditorSettings, EditorSettings } from '@shared/editorSettings'
import type { Channel, Input, Output } from '@shared/ipc/contract'
import {
  resetEditorSettingsStore,
  useEditorSettingsStore
} from '@renderer/features/editor/settingsStore'
import { setIpcClient } from '@renderer/lib/ipc'
import { archivedNow } from './archived'
import { ArchivedFeaturesTab } from './ArchivedFeaturesTab'
import { Unarchived } from './Unarchived'

/** Settings › Archived features (notes redesign, 2026-10-15). */

let writes: unknown[]

beforeEach(() => {
  writes = []
  resetEditorSettingsStore()
  setIpcClient({
    async invoke<C extends Channel>(channel: C, input: Input<C>): Promise<Output<C>> {
      if (channel === 'editorSettings:set') {
        writes.push(input)
        return EditorSettings.parse(input) as Output<C>
      }
      throw new Error(`unexpected ${channel}`)
    },
    on: () => () => undefined
  })
})
afterEach(() => {
  resetEditorSettingsStore()
  setIpcClient(null)
})

describe('the archive rule', () => {
  it('archives all nine by default (the old Outline and Timeline views among them) and switches one back on or off', () => {
    expect(ARCHIVABLE_FEATURES).toHaveLength(9)
    expect(ARCHIVABLE_FEATURES).toContain('oldViews')
    for (const feature of ARCHIVABLE_FEATURES) expect(isArchived(feature, undefined)).toBe(true)
    const on = withArchived(undefined, 'proofread', false)
    expect(on).toEqual(['proofread'])
    expect(isArchived('proofread', on)).toBe(false)
    expect(isArchived('voiceProfile', on)).toBe(true)
    expect(withArchived(on, 'proofread', true)).toEqual([])
  })

  it('archives the old story bible in story memory v1 only (fresh start)', () => {
    expect(isStoryBibleArchived(undefined, 'v1')).toBe(true)
    expect(isStoryBibleArchived(['storyBible'], 'v1')).toBe(false)
    expect(isStoryBibleArchived(undefined, 'v2')).toBe(false)
  })

  it('keeps the switched-on list in the editor settings, a row without it still parsing', () => {
    const stored = defaultEditorSettings('novel')
    expect(EditorSettings.parse(stored).unarchived).toBeUndefined()
    expect(EditorSettings.parse({ ...stored, unarchived: ['proofread'] }).unarchived).toEqual([
      'proofread'
    ])
    expect(EditorSettings.safeParse({ ...stored, unarchived: ['nope'] }).success).toBe(false)
  })
})

describe('ArchivedFeaturesTab', () => {
  it('lists the nine switches on, and switching one off brings its entry point back', async () => {
    useEditorSettingsStore.setState({ settings: defaultEditorSettings('novel') })
    render(
      <>
        <ArchivedFeaturesTab />
        <Unarchived feature="proofread">
          <button type="button">Proofread the scene</button>
        </Unarchived>
      </>
    )
    const switches = screen.getAllByRole('switch')
    expect(switches).toHaveLength(9)
    expect(
      screen.getByRole('switch', { name: 'Archive Old Outline and Timeline views' })
    ).toBeChecked()
    for (const each of switches) expect(each).toBeChecked()
    expect(archivedNow('proofread')).toBe(true)
    expect(screen.queryByRole('button', { name: 'Proofread the scene' })).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('switch', { name: 'Archive Proofread' }))
    expect(screen.getByRole('switch', { name: 'Archive Proofread' })).not.toBeChecked()
    expect(screen.getByRole('button', { name: 'Proofread the scene' })).toBeInTheDocument()
    expect(archivedNow('proofread')).toBe(false)
    // Saved with the project's editor settings after the usual debounce.
    await waitFor(() => expect(writes).toHaveLength(1))
    expect(writes[0]).toMatchObject({ unarchived: ['proofread'] })
  })

  it('hides nothing before the project’s settings load', () => {
    expect(archivedNow('editorsNotes')).toBe(false)
  })
})
