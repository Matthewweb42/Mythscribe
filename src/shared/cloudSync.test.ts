import { describe, expect, it } from 'vitest'
import { cloudSyncExplainer, describeCloudSync, type CloudSyncStatus } from './cloudSync'

const base: CloudSyncStatus = {
  provider: 'googleDrive',
  state: 'synced',
  lastSyncedAt: '2026-10-08T12:00:00.000Z',
  error: null,
  conflictCopy: null
}

describe('describeCloudSync', () => {
  const now = new Date('2026-10-08T12:02:30.000Z')

  it('says when the project was last copied', () => {
    expect(describeCloudSync(base, now)).toBe('Copied to Google Drive 2 min ago')
    expect(describeCloudSync(base, new Date('2026-10-08T12:00:20.000Z'))).toBe(
      'Copied to Google Drive just now'
    )
    expect(describeCloudSync(base, new Date('2026-10-08T15:10:00.000Z'))).toBe(
      'Copied to Google Drive 3 hours ago'
    )
    expect(describeCloudSync({ ...base, lastSyncedAt: null }, now)).toBe(
      'Working on a local copy for Google Drive'
    )
  })

  it('says when it is copying or failed', () => {
    expect(describeCloudSync({ ...base, provider: 'oneDrive', state: 'copying' }, now)).toBe(
      'Copying to OneDrive…'
    )
    expect(describeCloudSync({ ...base, state: 'failed', error: 'EBUSY' }, now)).toBe(
      'Could not copy to Google Drive. Retrying'
    )
  })

  it('adds the cause to the tooltip only while failed', () => {
    expect(cloudSyncExplainer(base)).not.toContain('EBUSY')
    expect(cloudSyncExplainer({ ...base, state: 'failed', error: 'EBUSY' })).toContain('EBUSY')
  })
})
