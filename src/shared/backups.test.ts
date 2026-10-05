import { describe, expect, it } from 'vitest'
import {
  BackupSettings,
  BackupSettingsPatch,
  backupFileName,
  backupProjectName,
  backupsToPrune,
  defaultBackupSettings,
  parseBackupFileName,
  projectBackupDirName,
  restoredFolderName
} from './backups'

describe('backups (F-8.4)', () => {
  it('defaults every setting, so an empty object parses to the defaults', () => {
    expect(BackupSettings.parse({})).toEqual(defaultBackupSettings())
    expect(defaultBackupSettings()).toEqual({
      enabled: true,
      folder: null,
      intervalMinutes: 30,
      onClose: true,
      keep: 10
    })
  })

  it('refuses an interval or a retention off the choices', () => {
    expect(BackupSettings.safeParse({ intervalMinutes: 45 }).success).toBe(false)
    expect(BackupSettings.safeParse({ keep: 3 }).success).toBe(false)
    expect(BackupSettings.safeParse({ intervalMinutes: 120, keep: 50 }).success).toBe(true)
  })

  it('lets the renderer reset the folder but never name one', () => {
    expect(BackupSettingsPatch.safeParse({ folder: null }).success).toBe(true)
    expect(BackupSettingsPatch.safeParse({ folder: '/tmp/elsewhere' }).success).toBe(false)
  })

  it('names a backup by local time and reads the time back', () => {
    const date = new Date(2026, 9, 4, 9, 5, 7)
    const name = backupFileName('My Novel', date)
    expect(name).toBe('My Novel 2026-10-04 090507.zip')
    expect(parseBackupFileName(name)?.getTime()).toBe(date.getTime())
  })

  it('ignores files that are not backups, and impossible dates', () => {
    expect(parseBackupFileName('notes.txt')).toBeNull()
    expect(parseBackupFileName('My Novel 2026-10-04 090507.zip.tmp')).toBeNull()
    expect(parseBackupFileName('2026-10-04 090507.zip')).toBeNull()
    expect(parseBackupFileName('My Novel 2026-02-31 090507.zip')).toBeNull()
    expect(parseBackupFileName('My Novel 2026-10-04 250507.zip')).toBeNull()
  })

  it('keys the project folder by the id and names the restored copy', () => {
    expect(projectBackupDirName('My Novel', '0123456789abcdef')).toBe('My Novel (01234567)')
    expect(restoredFolderName('My Novel', new Date(2026, 9, 4, 21, 3))).toBe(
      'My Novel (restored 2026-10-04 2103).mythscribe'
    )
  })

  it('reads the project name back from a backup file name', () => {
    expect(backupProjectName('My Novel 2026-10-04 090507.zip')).toBe('My Novel')
    expect(backupProjectName('Something else.ZIP')).toBe('Something else')
  })

  it('prunes everything past the newest N', () => {
    expect(backupsToPrune(['a', 'b', 'c', 'd'], 2)).toEqual(['c', 'd'])
    expect(backupsToPrune(['a'], 10)).toEqual([])
  })
})
