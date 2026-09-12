import type { Tag } from '@shared/ipc/contract'

/** Three tags across two categories, in `tag:list` order (by name), for the tag tests (F-4.2). */
export const tagFixture: Tag[] = [
  {
    id: 't-forest',
    name: 'dark-forest',
    category: 'setting',
    color: '#ea580c',
    parentId: null,
    usageCount: 3,
    created: '2026-09-01T10:00:00.000Z',
    modified: '2026-09-02T11:30:00.000Z'
  },
  {
    id: 't-mara',
    name: 'mara',
    category: 'character',
    color: '#dc2626',
    parentId: null,
    usageCount: 1,
    created: '2026-09-03T10:00:00.000Z',
    modified: '2026-09-03T10:00:00.000Z'
  },
  {
    id: 't-moody',
    name: 'moody',
    category: 'tone',
    color: '#2563eb',
    parentId: null,
    usageCount: 0,
    created: '2026-09-04T10:00:00.000Z',
    modified: '2026-09-04T10:00:00.000Z'
  }
]
