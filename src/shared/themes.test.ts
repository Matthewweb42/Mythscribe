import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  BUILT_IN_THEMES,
  THEME_TOKENS,
  THEME_TOKEN_VARS,
  availableThemes,
  builtInTheme,
  nextTheme,
  resolveTheme,
  themeBackground,
  themeNeedsLicense,
  type CustomTheme,
  type ThemeSettings
} from './themes'

const HARBOUR: CustomTheme = {
  id: 'custom-harbour',
  name: 'Harbour',
  base: 'light',
  colors: { ...builtInTheme('light').colors, bg: '#102030' }
}

const settings = (theme: string, customThemes: CustomTheme[] = [HARBOUR]): ThemeSettings => ({
  theme,
  customThemes
})

/** The `--ms-*: #hex;` lines inside one `selector {` block of tokens.css. */
function cssBlock(css: string, selector: string): Map<string, string> {
  const start = css.indexOf(`${selector} {`)
  expect(start, `tokens.css has no ${selector} block`).toBeGreaterThanOrEqual(0)
  const body = css.slice(start, css.indexOf('}', start))
  return new Map(
    [...body.matchAll(/(--ms-[a-z-]+):\s*(#[0-9a-fA-F]{6});/g)].map((m) => [
      m[1] ?? '',
      (m[2] ?? '').toLowerCase()
    ])
  )
}

describe('themes (F-7.8)', () => {
  it('matches the hexes in tokens.css for every built-in theme', () => {
    const css = fs.readFileSync(path.join(__dirname, '../renderer/styles/tokens.css'), 'utf8')
    for (const theme of BUILT_IN_THEMES) {
      const block = cssBlock(css, theme.id === 'dark' ? ':root' : `:root[data-theme='${theme.id}']`)
      for (const token of THEME_TOKENS) {
        expect(block.get(THEME_TOKEN_VARS[token]), `${theme.id} ${token}`).toBe(theme.colors[token])
      }
    }
  })

  it('keeps the sheet lighter than the desk in every built-in theme (F-7.11)', () => {
    const luminance = (hex: string): number =>
      [1, 3, 5].reduce((sum, i) => sum + parseInt(hex.slice(i, i + 2), 16), 0)
    for (const theme of BUILT_IN_THEMES) {
      expect(luminance(theme.colors.sheet), theme.id).toBeGreaterThan(luminance(theme.colors.desk))
    }
  })

  it('locks Sepia and custom themes behind the license, and nothing else', () => {
    expect(['dark', 'light', 'high-contrast'].map(themeNeedsLicense)).toEqual([false, false, false])
    expect(themeNeedsLicense('sepia')).toBe(true)
    expect(themeNeedsLicense('custom-harbour')).toBe(true)
  })

  it('paints the stored choice when allowed, otherwise Dark', () => {
    expect(resolveTheme(settings('light'), false)).toMatchObject({ id: 'light', overrides: null })
    expect(resolveTheme(settings('sepia'), false).id).toBe('dark')
    expect(resolveTheme(settings('sepia'), true).id).toBe('sepia')
    expect(resolveTheme(settings('custom-harbour'), false).id).toBe('dark')
    expect(resolveTheme(settings('custom-harbour'), true)).toMatchObject({
      id: 'custom-harbour',
      label: 'Harbour',
      base: { id: 'light' },
      overrides: HARBOUR.colors
    })
    // A deleted custom theme, or a hand-edited id, paints Dark.
    expect(resolveTheme(settings('custom-gone'), true).id).toBe('dark')
    expect(resolveTheme(settings('neon'), true).id).toBe('dark')
  })

  it('lists and cycles through only the themes the author can use', () => {
    expect(availableThemes(settings('dark'), false).map((t) => t.id)).toEqual([
      'dark',
      'light',
      'high-contrast'
    ])
    expect(availableThemes(settings('dark'), true).map((t) => t.id)).toEqual([
      'dark',
      'light',
      'high-contrast',
      'sepia',
      'custom-harbour'
    ])
    expect(nextTheme(settings('dark'), false)).toBe('light')
    expect(nextTheme(settings('high-contrast'), false)).toBe('dark')
    expect(nextTheme(settings('high-contrast'), true)).toBe('sepia')
    expect(nextTheme(settings('custom-harbour'), true)).toBe('dark')
    // A locked choice paints Dark, so the next one is Light.
    expect(nextTheme(settings('sepia'), false)).toBe('light')
  })

  it('gives the window the painted background', () => {
    expect(themeBackground(settings('custom-harbour'))).toBe('#102030')
    expect(themeBackground(settings('custom-harbour'), false)).toBe('#1b1b1f')
    expect(themeBackground(settings('high-contrast'))).toBe('#000000')
  })
})
