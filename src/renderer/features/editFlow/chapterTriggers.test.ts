import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Channel, Input, Output, ProjectInfo, TreeNode } from '@shared/ipc/contract'
import type { StoryMemoryVersion } from '@shared/storyMemory'
import { treeFixture } from '@renderer/features/manuscript/treeFixture'
import { buildIndex, useTreeStore } from '@renderer/features/manuscript/treeStore'
import { registerPendingSave, resetPendingSaves } from '@renderer/features/project/pendingSaves'
import { useProjectStore } from '@renderer/features/project/projectStore'
import { setIpcClient } from '@renderer/lib/ipc'
import {
  chapterOf,
  noteChapterSaved,
  startChapterTriggers,
  stopChapterTriggers
} from './chapterTriggers'

let left: Input<'editFlow:chapterLeft'>[]
let order: string[]
/** A save the flush lands (the scene's last keystrokes), or nothing. */
let pendingSave: string | null

function project(memory: StoryMemoryVersion): ProjectInfo {
  return {
    id: 'p-1',
    name: 'Notes',
    format: 'novel',
    path: '/books/Notes.mythscribe',
    created: 'c',
    modified: 'm',
    lastOpened: 'l',
    schemaVersion: 42,
    storyMemory: memory
  }
}

/** A second scene in Chapter 1. */
const sceneOneB: TreeNode = {
  id: 'sc-1b',
  parentId: 'ch-1',
  sectionType: null,
  kind: 'document',
  hierarchyLevel: 'scene',
  title: 'Scene 1b',
  position: 1,
  wordCount: 10,
  matterType: null,
  preset: null,
  created: 'c',
  modified: 'm'
}

const select = (id: string | null): void => useTreeStore.setState({ selectedId: id })

/** Lets the leave's flush and invoke run. */
async function flushed(): Promise<void> {
  for (let i = 0; i < 6; i += 1) await Promise.resolve()
}

beforeEach(() => {
  left = []
  order = []
  pendingSave = null
  resetPendingSaves()
  stopChapterTriggers()
  useProjectStore.setState({ current: project('v1') })
  useTreeStore.setState({ ...buildIndex([...treeFixture, sceneOneB]), selectedId: null })
  registerPendingSave(() => {
    order.push('flush')
    if (pendingSave !== null) noteChapterSaved(pendingSave)
    pendingSave = null
    return Promise.resolve()
  })
  setIpcClient({
    invoke<C extends Channel>(channel: C, input: Input<C>): Promise<Output<C>> {
      if (channel !== 'editFlow:chapterLeft')
        return Promise.reject(new Error(`unexpected ${channel}`))
      order.push('left')
      left.push(input as Input<'editFlow:chapterLeft'>)
      return Promise.resolve({ started: false, reason: 'off' } as Output<C>)
    },
    on: () => () => {}
  })
})

afterEach(() => {
  stopChapterTriggers()
  resetPendingSaves()
  setIpcClient(null)
  useProjectStore.setState({ current: null })
})

describe('chapterOf', () => {
  it('is the folder a scene sits in, never a section root', () => {
    expect(chapterOf('sc-1')).toBe('ch-1')
    expect(chapterOf('sc-1b')).toBe('ch-1')
    expect(chapterOf('missing')).toBeNull()
  })
})

describe('chapter triggers (notes redesign phase 3)', () => {
  it('tells main once when a scene in another chapter opens after a save in the chapter left', async () => {
    select('sc-1')
    startChapterTriggers()
    noteChapterSaved('sc-1')
    // Another scene of the same chapter is not leaving it.
    select('sc-1b')
    await flushed()
    expect(left).toEqual([])
    select('sc-2')
    await flushed()
    expect(left).toEqual([{ chapterId: 'ch-1' }])
    expect(order).toEqual(['flush', 'left'])
    // Back and away again without writing: nothing more.
    select('sc-1')
    select('sc-2')
    await flushed()
    expect(left).toEqual([{ chapterId: 'ch-1' }])
  })

  it('counts the last keystrokes the flush saves as you leave', async () => {
    select('sc-1')
    startChapterTriggers()
    pendingSave = 'sc-1'
    select('sc-4')
    await flushed()
    expect(left).toEqual([{ chapterId: 'ch-1' }])
  })

  it('sends nothing for a leave without writing, to a note page, the Outline or a folder', async () => {
    select('sc-1')
    startChapterTriggers()
    select('sc-2')
    await flushed()
    expect(left).toEqual([])
    noteChapterSaved('sc-2')
    // A folder, front matter or nothing selected (a note page or the Outline) is not leaving it.
    for (const id of ['ch-4', 'title-page', null]) select(id)
    await flushed()
    expect(left).toEqual([])
    // A save of a document outside the manuscript marks no chapter.
    noteChapterSaved('title-page')
    select('sc-2')
    await flushed()
    expect(left).toEqual([])
  })

  it('closing the project sends nothing, and a v2 project never tells main', async () => {
    select('sc-1')
    startChapterTriggers()
    noteChapterSaved('sc-1')
    stopChapterTriggers()
    select('sc-2')
    await flushed()
    expect(left).toEqual([])

    useProjectStore.setState({ current: project('v2') })
    select('sc-1')
    startChapterTriggers()
    noteChapterSaved('sc-1')
    select('sc-2')
    await flushed()
    expect(left).toEqual([])
  })
})
