import { describe, expect, it } from 'vitest'
import { EditorSettings } from '@shared/editorSettings'
import { seedSettings, seedSkeleton } from './seed'

const NOW = '2026-09-10T00:00:00.000Z'

function stubIds(): () => string {
  let n = 0
  return () => `id-${++n}`
}

describe('seedSkeleton', () => {
  it('produces the 17-row starter structure with contiguous positions', () => {
    const rows = seedSkeleton('novel', NOW, stubIds())
    expect(rows).toHaveLength(17)

    const roots = rows.filter((r) => r.parentId === null)
    expect(roots.map((r) => r.sectionType)).toEqual(['front', 'manuscript', 'end'])
    expect(roots.map((r) => r.position)).toEqual([0, 1, 2])
    expect(roots.map((r) => r.title)).toEqual(['front', 'manuscript', 'end'])
    expect(rows.filter((r) => r.sectionType).length).toBe(3)

    const ids = new Set(rows.map((r) => r.id))
    expect(ids.size).toBe(17)
    for (const r of rows) {
      if (r.parentId !== null) expect(ids.has(r.parentId ?? '')).toBe(true)
      expect(r).toMatchObject({ created: NOW, modified: NOW, wordCount: 0 })
      expect(r.content ?? null).toBeNull()
      expect(r.notes ?? null).toBeNull()
      expect(r.sceneMeta ?? null).toBeNull()
      expect(r.matterType ?? null).toBeNull()
      expect(r.preset ?? null).toBeNull()
    }

    const byParent = new Map<string | null, number[]>()
    for (const r of rows) {
      const key = r.parentId ?? null
      byParent.set(key, [...(byParent.get(key) ?? []), r.position])
    }
    for (const positions of byParent.values()) {
      expect([...positions].sort((a, b) => a - b)).toEqual(positions.map((_, i) => i))
    }
  })

  it('uses novel labels and nests parts → chapters → scenes', () => {
    const rows = seedSkeleton('novel', NOW, stubIds())
    const manuscript = rows.find((r) => r.sectionType === 'manuscript')
    const parts = rows.filter((r) => r.parentId === manuscript?.id)
    expect(parts.map((r) => r.title)).toEqual(['Part 1', 'Part 2'])
    expect(parts.every((r) => r.kind === 'folder' && r.hierarchyLevel === 'part')).toBe(true)
    for (const part of parts) {
      const chapters = rows.filter((r) => r.parentId === part.id)
      expect(chapters.map((r) => r.title)).toEqual(['Chapter 1', 'Chapter 2', 'Chapter 3'])
      expect(chapters.every((r) => r.kind === 'folder' && r.hierarchyLevel === 'chapter')).toBe(
        true
      )
      for (const chapter of chapters) {
        const scenes = rows.filter((r) => r.parentId === chapter.id)
        expect(scenes.map((r) => r.title)).toEqual(['Scene 1'])
        expect(scenes[0]).toMatchObject({ kind: 'document', hierarchyLevel: 'scene' })
      }
    }
    expect(rows.filter((r) => r.parentId === rows[0]?.id)).toHaveLength(0)
    expect(rows.filter((r) => r.parentId === rows[2]?.id)).toHaveLength(0)
  })

  it('labels webnovel parts as arcs', () => {
    const titles = seedSkeleton('webnovel', NOW, stubIds()).map((r) => r.title)
    expect(titles).toContain('Arc 1')
    expect(titles).toContain('Arc 2')
    expect(titles).not.toContain('Part 1')
  })

  it('is deterministic for a given id generator', () => {
    const a = seedSkeleton('epic', NOW, stubIds())
    const b = seedSkeleton('epic', NOW, stubIds())
    expect(a).toEqual(b)
    expect(a.map((r) => r.id)).toEqual(Array.from({ length: 17 }, (_, i) => `id-${i + 1}`))
  })
})

describe('seedSettings', () => {
  it('seeds the format-specific editor settings under the editor key', () => {
    const rows = seedSettings('webnovel')
    expect(rows).toHaveLength(1)
    expect(rows[0]?.key).toBe('editor')
    const parsed = EditorSettings.parse(JSON.parse(rows[0]?.value ?? ''))
    expect(parsed.sceneBreak).toBe('~~~')
    expect(EditorSettings.parse(JSON.parse(seedSettings('novel')[0]?.value ?? '')).sceneBreak).toBe(
      '* * *'
    )
  })
})
