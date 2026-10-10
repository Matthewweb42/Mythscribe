import { z } from 'zod'

/**
 * Themes (F-7.8). Four built-in themes, each a block of `--ms-*` tokens in
 * `src/renderer/styles/tokens.css` selected by `data-theme` on <html> (dark is `:root` itself),
 * plus custom themes: a built-in base with the eight surface and text colours below replaced,
 * applied as inline variables on <html>. Dark, Light, and High contrast are free; Sepia and
 * custom themes are Supporter extras (F-15.9), so without the license they fall back to Dark
 * while the choice stays stored, the same as the accent.
 */
export const BUILT_IN_THEME_IDS = ['dark', 'light', 'high-contrast', 'sepia'] as const
export const BuiltInThemeId = z.enum(BUILT_IN_THEME_IDS)
export type BuiltInThemeId = z.infer<typeof BuiltInThemeId>

export const DEFAULT_THEME: BuiltInThemeId = 'dark'

/** The tokens a custom theme sets; everything else (accent, status, tree colours) is its base's. */
export const THEME_TOKENS = [
  'bg',
  'surface',
  'surfaceRaised',
  'line',
  'fg',
  'fgMuted',
  'desk',
  'sheet'
] as const
export type ThemeToken = (typeof THEME_TOKENS)[number]

/** The CSS variable each token sets. */
export const THEME_TOKEN_VARS: Record<ThemeToken, string> = {
  bg: '--ms-bg',
  surface: '--ms-surface',
  surfaceRaised: '--ms-surface-raised',
  line: '--ms-line',
  fg: '--ms-fg',
  fgMuted: '--ms-fg-muted',
  desk: '--ms-desk',
  sheet: '--ms-sheet'
}

/** What the custom theme editor calls each token. */
export const THEME_TOKEN_LABELS: Record<ThemeToken, string> = {
  bg: 'Background',
  surface: 'Panels',
  surfaceRaised: 'Raised panels',
  line: 'Lines',
  fg: 'Text',
  fgMuted: 'Secondary text',
  desk: 'Desk',
  sheet: 'Page'
}

export const HexColor = z.string().regex(/^#[0-9a-f]{6}$/i, 'Expected a colour like #1b1b1f')

export const ThemeColors = z.object({
  bg: HexColor,
  surface: HexColor,
  surfaceRaised: HexColor,
  line: HexColor,
  fg: HexColor,
  fgMuted: HexColor,
  desk: HexColor,
  sheet: HexColor
})
export type ThemeColors = z.infer<typeof ThemeColors>

export interface BuiltInTheme {
  id: BuiltInThemeId
  label: string
  /** The CSS `color-scheme`: native scrollbars and form controls follow it. */
  scheme: 'dark' | 'light'
  /** Sepia is a Supporter extra; the other three are free. */
  supporter: boolean
  /**
   * The theme's values for the custom-theme tokens: the editor starts a new theme from them and
   * the picker draws its preview from them. The same hexes as the theme's block in `tokens.css`
   * (CSS cannot import the TypeScript, so change both; `themes.test.ts` compares them).
   */
  colors: ThemeColors
  /** The accent the picker preview shows. */
  accent: string
}

export const BUILT_IN_THEMES: readonly BuiltInTheme[] = [
  {
    id: 'dark',
    label: 'Dark',
    scheme: 'dark',
    supporter: false,
    colors: {
      bg: '#1b1b1f',
      surface: '#232327',
      surfaceRaised: '#2b2b31',
      line: '#3a3a42',
      fg: '#e6e6ea',
      fgMuted: '#9a9aa6',
      desk: '#1b1b1f',
      sheet: '#26262b'
    },
    accent: '#6cc38f'
  },
  {
    id: 'light',
    label: 'Light',
    scheme: 'light',
    supporter: false,
    colors: {
      bg: '#eeeef0',
      surface: '#e4e4e8',
      surfaceRaised: '#f8f8f9',
      line: '#cfcfd6',
      fg: '#1c1c21',
      fgMuted: '#585864',
      desk: '#eeeef0',
      sheet: '#f8f8f9'
    },
    accent: '#2f8a57'
  },
  {
    id: 'high-contrast',
    label: 'High contrast',
    scheme: 'dark',
    supporter: false,
    colors: {
      bg: '#000000',
      surface: '#0a0a0a',
      surfaceRaised: '#161616',
      line: '#8a8a8a',
      fg: '#ffffff',
      fgMuted: '#e0e0e0',
      desk: '#000000',
      sheet: '#121212'
    },
    accent: '#ffd60a'
  },
  {
    id: 'sepia',
    label: 'Sepia',
    scheme: 'light',
    supporter: true,
    colors: {
      bg: '#efe4cc',
      surface: '#e6d8ba',
      surfaceRaised: '#f7eedb',
      line: '#d3c29d',
      fg: '#3b2f22',
      fgMuted: '#5e4e3a',
      desk: '#efe4cc',
      sheet: '#f7eedb'
    },
    accent: '#9b5f2a'
  }
]

export function builtInTheme(id: BuiltInThemeId): BuiltInTheme {
  const theme = BUILT_IN_THEMES.find((t) => t.id === id)
  if (!theme) throw new Error(`Unknown theme ${id}`)
  return theme
}

export const CUSTOM_THEMES_MAX = 8
export const CUSTOM_THEME_NAME_MAX = 40

export const CustomThemeId = z.string().regex(/^custom-[a-z0-9]{1,32}$/)

export const CustomTheme = z.object({
  id: CustomThemeId,
  name: z.string().trim().min(1).max(CUSTOM_THEME_NAME_MAX),
  base: BuiltInThemeId,
  colors: ThemeColors
})
export type CustomTheme = z.infer<typeof CustomTheme>

/** A custom theme as the editor sends it: no id for a new one. */
export const CustomThemeInput = CustomTheme.extend({ id: CustomThemeId.optional() })
export type CustomThemeInput = z.infer<typeof CustomThemeInput>

/** A built-in id or a custom theme's id. */
export const ThemeId = z.union([BuiltInThemeId, CustomThemeId])
export type ThemeId = z.infer<typeof ThemeId>

/** The view settings' theme fields, as `ViewSettings` holds them. */
export interface ThemeSettings {
  theme: string
  customThemes: readonly CustomTheme[]
}

/** What the app paints: the base block, the inline overrides (custom only), and the name. */
export interface ResolvedTheme {
  id: string
  label: string
  base: BuiltInTheme
  overrides: ThemeColors | null
}

function isBuiltIn(id: string): id is BuiltInThemeId {
  return (BUILT_IN_THEME_IDS as readonly string[]).includes(id)
}

/**
 * Whether `id` is a paid extra: Sepia and every custom theme. They are on during the trial and
 * with the license (`extrasUnlocked` in `appAccess.ts`; changed by the author 2026-10-10).
 */
export function themeNeedsLicense(id: string): boolean {
  return isBuiltIn(id) ? builtInTheme(id).supporter : true
}

/**
 * The theme to paint: the stored choice when it exists and is allowed, otherwise Dark. A locked
 * choice is kept in the settings, so it comes back when the license does.
 */
export function resolveTheme(settings: ThemeSettings, licensed: boolean): ResolvedTheme {
  const fallback = builtInTheme(DEFAULT_THEME)
  const id = settings.theme
  if (themeNeedsLicense(id) && !licensed) {
    return { id: fallback.id, label: fallback.label, base: fallback, overrides: null }
  }
  if (isBuiltIn(id)) {
    const base = builtInTheme(id)
    return { id, label: base.label, base, overrides: null }
  }
  const custom = settings.customThemes.find((t) => t.id === id)
  if (!custom) return { id: fallback.id, label: fallback.label, base: fallback, overrides: null }
  return { id, label: custom.name, base: builtInTheme(custom.base), overrides: custom.colors }
}

/** The themes the author can switch to, in picker order: built-ins, then custom themes. */
export function availableThemes(
  settings: ThemeSettings,
  licensed: boolean
): { id: string; label: string }[] {
  const builtIns = BUILT_IN_THEMES.filter((t) => licensed || !t.supporter).map((t) => ({
    id: t.id,
    label: t.label
  }))
  const customs = licensed ? settings.customThemes.map((t) => ({ id: t.id, label: t.name })) : []
  return [...builtIns, ...customs]
}

/** The theme after the one painted now, wrapping round (View › Switch theme). */
export function nextTheme(settings: ThemeSettings, licensed: boolean): string {
  const list = availableThemes(settings, licensed)
  const current = resolveTheme(settings, licensed).id
  const at = list.findIndex((t) => t.id === current)
  return list[(at + 1) % list.length]?.id ?? DEFAULT_THEME
}

/** Why main refused a Supporter theme (Sepia, custom) without the license. */
export const THEME_NEEDS_LICENSE_MESSAGE =
  'Sepia and custom themes come with the MythScribe license. Dark, Light, and High contrast are free.'

/** Why main refused an id that names no theme (a custom one deleted in another window). */
export const THEME_NOT_FOUND_MESSAGE = 'That theme no longer exists.'

/** The colour behind the page for the window itself: the painted theme's background. */
export function themeBackground(settings: ThemeSettings, licensed = true): string {
  const { base, overrides } = resolveTheme(settings, licensed)
  return overrides?.bg ?? base.colors.bg
}
