import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ProjectManager } from './manager'
import { projectFolderFor } from './projectStore'

let tmp: string
let manager: ProjectManager

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mythscribe-mgr-'))
  manager = new ProjectManager()
})
afterEach(() => {
  manager.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('ProjectManager', () => {
  it('starts empty and throws NO_PROJECT from require()', () => {
    expect(manager.current()).toBeNull()
    expect(() => manager.require()).toThrowError(expect.objectContaining({ code: 'NO_PROJECT' }))
  })

  it('creates, reports, notifies, and closes', () => {
    const seen: (string | null)[] = []
    manager.onChange((info) => seen.push(info?.name ?? null))
    const info = manager.create(projectFolderFor(tmp, 'A'), 'A', 'novel')
    expect(manager.current()?.id).toBe(info.id)
    manager.close()
    expect(manager.current()).toBeNull()
    expect(seen).toEqual(['A', null])
  })

  it('closes the previous project when another is opened', () => {
    manager.create(projectFolderFor(tmp, 'A'), 'A', 'novel')
    const first = manager.require()
    const closeSpy = vi.spyOn(first, 'close')
    manager.create(projectFolderFor(tmp, 'B'), 'B', 'epic')
    expect(closeSpy).toHaveBeenCalledOnce()
    expect(manager.current()?.name).toBe('B')
    manager.close()
    expect(manager.open(projectFolderFor(tmp, 'A')).name).toBe('A')
  })
})
