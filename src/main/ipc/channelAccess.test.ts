import { describe, expect, it } from 'vitest'
import { channels } from '@shared/ipc/contract'
import { CHANNEL_ACCESS, isWriteChannel } from './channelAccess'

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
