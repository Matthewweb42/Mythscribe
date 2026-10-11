import { describe, expect, it } from 'vitest'
import { channels, type Channel } from '@shared/ipc/contract'
import {
  assertChannelMemory,
  CHANNEL_ACCESS,
  CHANNEL_MEMORY,
  isWriteChannel,
  OTHER_MEMORY_MESSAGE
} from './channelAccess'

describe('channel access after the trial (AI-BILLING-SPEC M1)', () => {
  it('classifies every channel and nothing else', () => {
    expect(Object.keys(CHANNEL_ACCESS).sort()).toEqual([...channels].sort())
  })

  it('never refuses export, backup, reading, or the purchase', () => {
    const always = [
      'compile:run',
      'manuscript:compile',
      'provenance:export',
      'tag:export',
      'entity:export',
      'backups:now',
      'backups:restore',
      'backups:setSettings',
      'account:buySupporter',
      'account:refreshSupporter',
      'app:getAccess',
      'project:open',
      'document:get'
    ] as const
    for (const channel of always) expect(isWriteChannel(channel)).toBe(false)
  })

  it('refuses the writes that change what the author wrote', () => {
    const writes = [
      'document:save',
      'notes:save',
      'tree:create',
      'tree:delete',
      'entity:update',
      'tag:create',
      'proposal:settle',
      'replace:commit',
      'import:commit'
    ] as const
    for (const channel of writes) expect(isWriteChannel(channel)).toBe(true)
  })
})

describe('story memory per channel (F-16.4; plan P1 §0)', () => {
  const byMemory = (memory: 'any' | 'v1' | 'v2'): Channel[] =>
    channels.filter((channel) => CHANNEL_MEMORY[channel] === memory)

  it('classifies every channel and nothing else', () => {
    expect(Object.keys(CHANNEL_MEMORY).sort()).toEqual([...channels].sort())
  })

  it('refuses every v2 channel in a v1 project, and passes it in v2 and with nothing open', () => {
    const v2 = byMemory('v2')
    expect(v2).toContain('record:create')
    expect(v2).toContain('passages:search')
    for (const channel of v2) {
      expect(() => assertChannelMemory(channel, 'v1'), channel).toThrow(OTHER_MEMORY_MESSAGE)
      expect(() => assertChannelMemory(channel, 'v2'), channel).not.toThrow()
      expect(() => assertChannelMemory(channel, null), channel).not.toThrow()
    }
  })

  it('refuses every v1 write channel in a v2 project, and passes it in v1', () => {
    for (const channel of byMemory('v1')) {
      expect(() => assertChannelMemory(channel, 'v2'), channel).toThrow(OTHER_MEMORY_MESSAGE)
      expect(() => assertChannelMemory(channel, 'v1'), channel).not.toThrow()
    }
  })

  it('makes every write or AI channel of the v1 memory families v1, and leaves their reads to both', () => {
    const families = [
      'tag:',
      'documentTag:',
      'entity:',
      'fact:',
      'changes:',
      'organise:',
      'sheetSync:',
      'todo:',
      'knowledge:convert',
      'bible:'
    ]
    for (const channel of channels) {
      if (!families.some((family) => channel.startsWith(family))) continue
      const access = CHANNEL_ACCESS[channel]
      expect(CHANNEL_MEMORY[channel], channel).toBe(access === 'read' ? 'any' : 'v1')
    }
    for (const channel of [
      'storyBible:set',
      'library:process',
      'library:reviewChat',
      'library:apply',
      'ai:recommendTags',
      'ai:continuity',
      'continuity:settle'
    ] as const) {
      expect(CHANNEL_MEMORY[channel], channel).toBe('v1')
    }
  })

  it('leaves the tree, documents, notes, scene meta, categories and the library’s uploads to both', () => {
    for (const channel of [
      'tree:create',
      'document:save',
      'notes:save',
      'sceneMeta:set',
      'category:create',
      'library:add',
      'library:list',
      'library:choose',
      'library:open',
      'project:open'
    ] as const) {
      expect(CHANNEL_MEMORY[channel], channel).toBe('any')
    }
  })
})
