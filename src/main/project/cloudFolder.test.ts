import { describe, expect, it } from 'vitest'
import { cloudProviderFor, type CloudProbe } from './cloudFolder'

function probe(overrides: Partial<CloudProbe> = {}): CloudProbe {
  return {
    platform: 'win32',
    env: {},
    volumeLabel: () => null,
    exists: () => false,
    ...overrides
  }
}

describe('cloudProviderFor', () => {
  it('finds Google Drive for desktop by its folders', () => {
    expect(cloudProviderFor('G:\\My Drive\\Novels\\Book.mythscribe', probe())).toBe('googleDrive')
    expect(cloudProviderFor('G:\\Shared drives\\Team\\Book.mythscribe', probe())).toBe(
      'googleDrive'
    )
    expect(cloudProviderFor('H:\\Other computers\\Laptop\\Book.mythscribe', probe())).toBe(
      'googleDrive'
    )
    expect(cloudProviderFor('C:\\Users\\m\\GoogleDrive\\Book.mythscribe', probe())).toBe(
      'googleDrive'
    )
  })

  it('finds Google Drive by the volume label when the path does not say so', () => {
    const labelled = probe({
      volumeLabel: (root) => (root === 'G:\\' ? 'Volume in drive G is Google Drive' : null)
    })
    expect(cloudProviderFor('G:\\Book.mythscribe', labelled)).toBe('googleDrive')
    expect(cloudProviderFor('D:\\Book.mythscribe', labelled)).toBeNull()
  })

  it('asks for a volume label only on Windows', () => {
    const asked: string[] = []
    const mac = probe({
      platform: 'darwin',
      volumeLabel: (root) => {
        asked.push(root)
        return 'Google Drive'
      }
    })
    expect(cloudProviderFor('/Users/m/Book.mythscribe', mac)).toBeNull()
    expect(asked).toEqual([])
  })

  it('finds OneDrive by its environment variables, case-insensitively on Windows', () => {
    const env = probe({ env: { OneDrive: 'C:\\Users\\m\\Work Files' } })
    expect(cloudProviderFor('c:\\users\\M\\work files\\Book.mythscribe', env)).toBe('oneDrive')
    expect(cloudProviderFor('C:\\Users\\m\\Work Filesystem\\Book.mythscribe', env)).toBeNull()
    const commercial = probe({ env: { OneDriveCommercial: 'D:\\Corp' } })
    expect(cloudProviderFor('D:\\Corp\\Book.mythscribe', commercial)).toBe('oneDrive')
  })

  it('finds OneDrive by a folder named for it', () => {
    expect(cloudProviderFor('C:\\Users\\m\\OneDrive - Acme\\Book.mythscribe', probe())).toBe(
      'oneDrive'
    )
    expect(cloudProviderFor('C:\\Users\\m\\OneDrive\\Book.mythscribe', probe())).toBe('oneDrive')
  })

  it('finds Dropbox by its folder name or a .dropbox marker above the project', () => {
    expect(cloudProviderFor('C:\\Users\\m\\Dropbox\\Book.mythscribe', probe())).toBe('dropbox')
    expect(cloudProviderFor('C:\\Users\\m\\Dropbox (Acme)\\Book.mythscribe', probe())).toBe(
      'dropbox'
    )
    const marked = probe({
      platform: 'linux',
      exists: (file) => file === '/home/m/Sync/.dropbox'
    })
    expect(cloudProviderFor('/home/m/Sync/Novels/Book.mythscribe', marked)).toBe('dropbox')
  })

  it('finds iCloud Drive on Windows and macOS', () => {
    expect(cloudProviderFor('C:\\Users\\m\\iCloudDrive\\Book.mythscribe', probe())).toBe('iCloud')
    expect(
      cloudProviderFor(
        '/Users/m/Library/Mobile Documents/com~apple~CloudDocs/Book.mythscribe',
        probe({ platform: 'darwin' })
      )
    ).toBe('iCloud')
  })

  it('reads macOS File Provider folders under Library/CloudStorage', () => {
    const mac = probe({ platform: 'darwin' })
    expect(
      cloudProviderFor(
        '/Users/m/Library/CloudStorage/GoogleDrive-m@example.com/Novels/Book.mythscribe',
        mac
      )
    ).toBe('googleDrive')
    expect(
      cloudProviderFor('/Users/m/Library/CloudStorage/OneDrive-Personal/Book.mythscribe', mac)
    ).toBe('oneDrive')
    expect(cloudProviderFor('/Users/m/Library/CloudStorage/Dropbox/Book.mythscribe', mac)).toBe(
      'dropbox'
    )
  })

  it('leaves plain folders alone', () => {
    expect(cloudProviderFor('C:\\Users\\m\\Documents\\Book.mythscribe', probe())).toBeNull()
    expect(
      cloudProviderFor('/home/m/coding/Book.mythscribe', probe({ platform: 'linux' }))
    ).toBeNull()
    // A folder that merely contains the words is not one of them.
    expect(cloudProviderFor('C:\\Users\\m\\My Drives\\Book.mythscribe', probe())).toBeNull()
  })
})
