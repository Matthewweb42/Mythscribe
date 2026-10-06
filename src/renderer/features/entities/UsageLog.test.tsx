import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Channel, Entity, Input, Output } from '@shared/ipc/contract'
import { EMPTY_SCENE_META, type SceneMeta } from '@shared/sceneMeta'
import { resetSceneMetaStore } from '@renderer/features/editor/sceneMetaStore'
import { treeFixture } from '@renderer/features/manuscript/treeFixture'
import { buildIndex, useTreeStore } from '@renderer/features/manuscript/treeStore'
import { resetPendingSaves } from '@renderer/features/project/pendingSaves'
import { resetDocumentTagStore } from '@renderer/features/tags/documentTagStore'
import { resetMentionStore } from '@renderer/features/tags/mentionStore'
import { resetTimelineStore, useTimelineStore } from '@renderer/features/timeline/timelineStore'
import { setIpcClient, type IpcClient } from '@renderer/lib/ipc'
import { UsageLog } from './UsageLog'
import { entityFixture } from './entityFixture'

const meta = (over: Partial<SceneMeta>): SceneMeta => ({ ...EMPTY_SCENE_META, ...over })

/** Scene 1 on the fall; Scenes 2 and 4 on the siege, at the Keep and the Harbor; Scene 5 in the forest. */
const stored: Record<string, SceneMeta> = {
  'sc-1': meta({ eventId: 'b' }),
  'sc-2': meta({ eventId: 'a', pov: ' mara ', location: 'Keep' }),
  'sc-4': meta({ eventId: 'a', location: 'Harbor' }),
  'sc-5': meta({ location: 'dark forest', pov: 'Dark Forest' })
}

const entity = (id: string, over: Partial<Entity> = {}): Entity => {
  const found = entityFixture.find((row) => row.id === id)
  if (!found) throw new Error(`no entity ${id}`)
  return { ...found, ...over }
}

/** What main answers for the document tags and the tag's mentions; set per test. */
let links: Output<'documentTag:listAll'> = []
let tagMentions: Output<'mention:listForTag'> = []

function install(): void {
  const client: IpcClient = {
    async invoke<C extends Channel>(channel: C, input: Input<C>): Promise<Output<C>> {
      if (channel === 'sceneMeta:get') {
        const { id } = input as Input<'sceneMeta:get'>
        return { id, meta: stored[id] ?? { ...EMPTY_SCENE_META } } as Output<C>
      }
      if (channel === 'documentTag:listAll') return links as Output<C>
      if (channel === 'mention:listForTag') return tagMentions as Output<C>
      throw new Error(`unexpected ${channel}`)
    },
    on: () => () => {}
  }
  setIpcClient(client)
}

const rowsOf = (list: HTMLElement): string[] =>
  within(list)
    .getAllByRole('listitem')
    .map((li) => li.textContent ?? '')

beforeEach(() => {
  links = []
  tagMentions = []
  resetPendingSaves()
  resetSceneMetaStore()
  resetTimelineStore()
  resetDocumentTagStore()
  resetMentionStore()
  useTreeStore.setState({ ...buildIndex(treeFixture), selectedId: null, loaded: true })
  useTimelineStore.setState({
    loaded: true,
    events: [
      { id: 'a', label: 'The siege', when: 'Spring', year: null, note: '' },
      { id: 'b', label: 'The fall', when: '', year: null, note: '' }
    ]
  })
  install()
})
afterEach(() => {
  cleanup()
  resetSceneMetaStore()
  resetTimelineStore()
  resetDocumentTagStore()
  resetMentionStore()
  resetPendingSaves()
  useTreeStore.getState().clear()
  setIpcClient(null)
})

describe('UsageLog (F-11.2c)', () => {
  it('lists a character´s linked, mentioned, and POV scenes, flags a location conflict, and groups by event', async () => {
    const user = userEvent.setup()
    // The front matter's Title Page is outside the manuscript, but its link counts (as in F-9.4).
    links = [
      { nodeId: 'sc-4', tagId: 't-mara' },
      { nodeId: 'title-page', tagId: 't-mara' }
    ]
    tagMentions = [{ tagId: 't-mara', nodeId: 'sc-1', count: 2, ranges: [[1, 5]] }]
    render(<UsageLog entity={entity('e-mara', { tagId: 't-mara' })} />)

    const section = screen.getByRole('region', { name: 'Appearances' })
    await waitFor(() =>
      expect(rowsOf(within(section).getByRole('list', { name: 'Appearances' }))).toEqual([
        'Title PageTagged',
        'Scene 1Chapter 1×2',
        'Scene 2Chapter 2POV',
        'Scene 4Chapter 4Tagged'
      ])
    )
    expect(section).toHaveTextContent('In 4 scenes')
    expect(within(section).getByTestId('location-conflict')).toHaveTextContent(
      'At The siege: Keep, Harbor'
    )
    expect(screen.queryByRole('region', { name: 'Scenes set here' })).toBeNull()

    await user.click(screen.getByRole('button', { name: 'Story order' }))
    expect(screen.getByRole('button', { name: 'Story order' })).toHaveAttribute(
      'aria-pressed',
      'true'
    )
    expect(rowsOf(screen.getByRole('list', { name: 'Appearances: The siege' }))).toEqual([
      'Scene 2Chapter 2POV',
      'Scene 4Chapter 4Tagged'
    ])
    expect(rowsOf(screen.getByRole('list', { name: 'Appearances: The fall' }))).toEqual([
      'Scene 1Chapter 1×2'
    ])
    expect(rowsOf(screen.getByRole('list', { name: 'Appearances: Not on the timeline' }))).toEqual([
      'Title PageTagged'
    ])
    expect(screen.getByRole('heading', { name: 'The siege · Spring' })).toBeVisible()

    // A row with no mention selects its document (F-9.4); a mention row jumps (EntityEditor tests).
    await user.click(within(section).getByRole('button', { name: /^Scene 4/ }))
    expect(useTreeStore.getState().selectedId).toBe('sc-4')
  })

  it('a setting lists the scenes set there, ignores a POV, and says when it appears nowhere', async () => {
    const user = userEvent.setup()
    render(<UsageLog entity={entity('e-forest')} />)
    const setHere = screen.getByRole('region', { name: 'Scenes set here' })
    await waitFor(() =>
      expect(rowsOf(within(setHere).getByRole('list', { name: 'Scenes set here' }))).toEqual([
        'Scene 5Chapter 5'
      ])
    )
    expect(screen.getByRole('region', { name: 'Appearances' })).toHaveTextContent(
      'Not in any scene yet'
    )
    expect(screen.queryByTestId('location-conflict')).toBeNull()

    await user.click(screen.getByRole('button', { name: 'Story order' }))
    expect(
      rowsOf(screen.getByRole('list', { name: 'Scenes set here: Not on the timeline' }))
    ).toEqual(['Scene 5Chapter 5'])
  })
})
