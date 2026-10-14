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

  it('F-16.20, F-16.21: refuses the summary channels and v1’s plan-link job in v2, and v2’s Keep and card lines in v1', () => {
    for (const channel of [
      'summary:get',
      'ai:summarize',
      'jobs:indexAll',
      'planLinks:run',
      'planLinks:confirm',
      'planLinks:dismiss'
    ] as const) {
      expect(CHANNEL_MEMORY[channel], channel).toBe('v1')
      expect(() => assertChannelMemory(channel, 'v2'), channel).toThrow(OTHER_MEMORY_MESSAGE)
    }
    for (const channel of ['planLinks:keep', 'memory:cardLines'] as const) {
      expect(() => assertChannelMemory(channel, 'v1'), channel).toThrow(OTHER_MEMORY_MESSAGE)
    }
    // Get and Unlink branch by memory; the queue's status stays both's.
    for (const channel of ['planLinks:get', 'planLinks:unlink', 'jobs:status'] as const) {
      expect(CHANNEL_MEMORY[channel], channel).toBe('any')
    }
  })

  it('F-16.22: who knows what is v2; the grid reads, the author’s answers on secrets write', () => {
    const channels = [
      'memory:knows',
      'memory:knewBefore',
      'memory:splitTopic',
      'memory:topicNotRight'
    ] as const
    for (const channel of channels) {
      expect(CHANNEL_MEMORY[channel], channel).toBe('v2')
      expect(() => assertChannelMemory(channel, 'v1'), channel).toThrow(OTHER_MEMORY_MESSAGE)
    }
    expect(CHANNEL_ACCESS['memory:knows']).toBe('read')
    for (const channel of channels.slice(1)) expect(isWriteChannel(channel), channel).toBe(true)
  })

  it('F-16.25, F-16.26: sheet lines are v2 writes; the search misses a v2 read', () => {
    for (const channel of ['record:addLine', 'record:removeLine', 'scribe:searchMisses'] as const) {
      expect(CHANNEL_MEMORY[channel], channel).toBe('v2')
      expect(() => assertChannelMemory(channel, 'v1'), channel).toThrow(OTHER_MEMORY_MESSAGE)
    }
    for (const channel of ['record:addLine', 'record:removeLine'] as const) {
      expect(CHANNEL_ACCESS[channel], channel).toBe('write')
      expect(isWriteChannel(channel), channel).toBe(true)
    }
    expect(CHANNEL_ACCESS['scribe:searchMisses']).toBe('read')
    expect(isWriteChannel('scribe:searchMisses')).toBe(false)
  })

  it('F-16.25 (P3 slice 4): the navigator is v2’s AI channel; the router is v1’s, so v2 never sends route.v2', () => {
    expect(CHANNEL_MEMORY['ai:navigate']).toBe('v2')
    expect(CHANNEL_ACCESS['ai:navigate']).toBe('ai')
    expect(() => assertChannelMemory('ai:navigate', 'v1')).toThrow(OTHER_MEMORY_MESSAGE)
    expect(CHANNEL_MEMORY['ai:route']).toBe('v1')
    expect(() => assertChannelMemory('ai:route', 'v2')).toThrow(OTHER_MEMORY_MESSAGE)
    expect(() => assertChannelMemory('ai:route', 'v1')).not.toThrow()
    // Story Intelligence (query.v4) is v1's too: Ms Scribe answers questions in v2.
    expect(CHANNEL_MEMORY['ai:query']).toBe('v1')
    expect(() => assertChannelMemory('ai:query', 'v2')).toThrow(OTHER_MEMORY_MESSAGE)
    // Ms Scribe's answer stays one channel for both memories.
    expect(CHANNEL_MEMORY['ai:agent']).toBe('any')
  })

  it('F-16.23, F-16.27: the Threads, the Timeline and the findings are v2 and only read', () => {
    for (const channel of ['memory:threads', 'memory:timeline', 'memory:findings'] as const) {
      expect(CHANNEL_MEMORY[channel], channel).toBe('v2')
      expect(() => assertChannelMemory(channel, 'v1'), channel).toThrow(OTHER_MEMORY_MESSAGE)
      expect(CHANNEL_ACCESS[channel], channel).toBe('read')
      expect(isWriteChannel(channel), channel).toBe(false)
    }
  })

  it('F-16.29, F-16.30: Check the book is v2’s AI; its price, report, loose ends and note proposal read; the answers write', () => {
    const access: [Channel, 'read' | 'write' | 'ai'][] = [
      ['memory:checkEstimate', 'read'],
      ['memory:checkBook', 'ai'],
      ['memory:checkReport', 'read'],
      ['memory:findingAction', 'write'],
      ['memory:notePatch', 'read'],
      ['memory:applyNotePatch', 'write'],
      ['memory:looseEnds', 'read'],
      ['memory:looseEndAction', 'write']
    ]
    for (const [channel, kind] of access) {
      expect(CHANNEL_MEMORY[channel], channel).toBe('v2')
      expect(() => assertChannelMemory(channel, 'v1'), channel).toThrow(OTHER_MEMORY_MESSAGE)
      expect(CHANNEL_ACCESS[channel], channel).toBe(kind)
      expect(isWriteChannel(channel), channel).toBe(kind === 'write')
    }
  })
})
