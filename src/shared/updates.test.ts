import { describe, expect, it } from 'vitest'
import {
  RELEASE_NOTES_MAX,
  UPDATE_CHANNELS,
  UPDATE_CHANNEL_LABEL,
  UPDATE_CHANNEL_MEANING,
  UpdateSettings,
  UpdateState,
  defaultUpdateSettings,
  releaseNotesText,
  updaterChannelFor
} from './updates'

describe('update settings (F-15.7)', () => {
  it('installs on the stable channel, checking by itself, with nothing seen yet', () => {
    expect(defaultUpdateSettings()).toEqual({
      channel: 'stable',
      autoCheck: true,
      installedNotes: null,
      lastSeenVersion: null
    })
  })

  it('fills every field in for a stored object written before one of them existed', () => {
    expect(UpdateSettings.parse({})).toEqual(defaultUpdateSettings())
    expect(UpdateSettings.parse({ channel: 'beta' })).toEqual({
      ...defaultUpdateSettings(),
      channel: 'beta'
    })
  })

  it('refuses a channel that is not one of the two', () => {
    expect(UpdateSettings.safeParse({ channel: 'nightly' }).success).toBe(false)
  })

  it('labels and explains every channel', () => {
    for (const channel of UPDATE_CHANNELS) {
      expect(UPDATE_CHANNEL_LABEL[channel].length).toBeGreaterThan(0)
      expect(UPDATE_CHANNEL_MEANING[channel]).toMatch(/\.$/)
    }
    expect(UPDATE_CHANNEL_MEANING.beta).toContain('rough edges')
  })

  it('maps the channels to the files a release publishes', () => {
    expect(updaterChannelFor('stable')).toBe('latest')
    expect(updaterChannelFor('beta')).toBe('beta')
  })

  it('validates a state with each status shape', () => {
    const base = {
      currentVersion: '0.1.0',
      channel: 'stable' as const,
      autoCheck: true,
      installedNotes: null,
      unseenNotes: false
    }
    expect(UpdateState.parse({ ...base, status: { state: 'idle' } }).status).toEqual({
      state: 'idle'
    })
    expect(
      UpdateState.safeParse({
        ...base,
        status: { state: 'downloading', version: '0.2.0', percent: 42 }
      }).success
    ).toBe(true)
    // The percent is a whole number between 0 and 100; anything else is a bug upstream.
    expect(
      UpdateState.safeParse({
        ...base,
        status: { state: 'downloading', version: '0.2.0', percent: 120 }
      }).success
    ).toBe(false)
    expect(UpdateState.safeParse({ ...base, status: { state: 'ready' } }).success).toBe(false)
  })
})

describe('releaseNotesText (F-15.7)', () => {
  it('answers an empty string for nothing at all', () => {
    expect(releaseNotesText(null)).toBe('')
    expect(releaseNotesText(undefined)).toBe('')
    expect(releaseNotesText('')).toBe('')
    expect(releaseNotesText([])).toBe('')
  })

  it('turns list items into dashed lines and paragraphs into their own lines', () => {
    const html =
      '<h2>Highlights</h2><p>Faster saves.</p><ul><li>Fixed the tag filter</li>' +
      '<li>Fixed focus mode</li></ul><p>Thanks for<br>reading.</p>'
    expect(releaseNotesText(html)).toBe(
      'Highlights\n\nFaster saves.\n\n- Fixed the tag filter\n- Fixed focus mode\n\nThanks for\nreading.'
    )
  })

  it('strips every remaining tag and never leaves markup behind', () => {
    const html = '<p>Use <strong>Ctrl+K</strong> for the <a href="https://x/">assistant</a>.</p>'
    expect(releaseNotesText(html)).toBe('Use Ctrl+K for the assistant.')
    expect(releaseNotesText('<script>alert(1)</script><p>Safe.</p>')).toBe('Safe.')
  })

  it('decodes the five basic entities, and decodes an escaped tag as text', () => {
    expect(releaseNotesText('<p>Tom &amp; Mara said &quot;yes&quot; &#39;again&#39;</p>')).toBe(
      'Tom & Mara said "yes" \'again\''
    )
    expect(releaseNotesText('<p>&lt;p&gt; is a paragraph</p>')).toBe('<p> is a paragraph')
    // `&amp;lt;` is a literal `&lt;`, not a `<`: nothing decodes twice.
    expect(releaseNotesText('&amp;lt;')).toBe('&lt;')
  })

  it('collapses blank runs and trims the ends', () => {
    expect(releaseNotesText('  <p></p><p>One.</p><p></p><p></p><p>Two.</p>  ')).toBe('One.\n\nTwo.')
    expect(releaseNotesText('Spaced   out\n\n\n\nlines')).toBe('Spaced out\n\nlines')
  })

  it('caps a very long body with an ellipsis', () => {
    const text = releaseNotesText('x'.repeat(RELEASE_NOTES_MAX * 2))
    expect(text).toHaveLength(RELEASE_NOTES_MAX)
    expect(text.endsWith('…')).toBe(true)
  })

  it('joins the multi-version form under a line per version, dropping the empty ones', () => {
    expect(
      releaseNotesText([
        { version: '0.3.0', note: '<ul><li>Beta reader</li></ul>' },
        { version: '0.2.1', note: null },
        { version: '0.2.0', note: '<p>First public build.</p>' }
      ])
    ).toBe('Version 0.3.0\n- Beta reader\n\nVersion 0.2.0\nFirst public build.')
  })
})
