import { describe, expect, it } from 'vitest'
import { defaultLayout } from '@shared/layout'
import { isColumnShown } from './layoutStore'
import { withStoryBiblePanelsClosed } from './dockLayout'

describe('withStoryBiblePanelsClosed (notes redesign, fresh start)', () => {
  it('closes the tags column and the quick reference on screen, leaving the rest as stored', () => {
    const stored = defaultLayout()
    const open = {
      ...stored,
      tags: { ...stored.tags, open: true },
      references: { ...stored.references, open: true },
      notes: { ...stored.notes, open: true }
    }
    const shown = withStoryBiblePanelsClosed(open)
    expect(shown.tags.open).toBe(false)
    expect(shown.references.open).toBe(false)
    expect(shown.notes.open).toBe(true)
    expect(shown.dock).toBe(open.dock)
    // A column of only those two panels is not drawn; the stored layout is untouched.
    expect(isColumnShown(shown, ['tags', 'references'])).toBe(false)
    expect(open.tags.open).toBe(true)
  })
})
