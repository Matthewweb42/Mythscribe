import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { JSDOM } from 'jsdom'
import { describe, expect, it } from 'vitest'
import {
  AI_DATA_SHARING,
  AI_FEATURES_BY_LEVEL,
  ASSISTANT_MODES,
  ASSISTANT_MODE_LABEL,
  ASSISTANT_MODE_MEANING,
  USE_AI_LABEL,
  USE_AI_MEANING
} from './aiSettings'

/**
 * The website (F-15.10) is static HTML under `site/public/`, deployed as-is. These tests keep it
 * honest without a build step: the docs page must quote the app's Use AI, chat mode, and data-sharing copy
 * verbatim (author-control rule 3: a feature must not send text the panel does not list, so the
 * public page and the panel have to say the same thing), every relative link and asset must
 * resolve, and every page must carry the basics a browser and a screen reader need.
 */
const SITE_ROOT = resolve(import.meta.dirname, '../../site/public')

function htmlFiles(): string[] {
  return readdirSync(SITE_ROOT, { recursive: true, encoding: 'utf8' })
    .filter((name) => name.endsWith('.html'))
    .map((name) => join(SITE_ROOT, name))
    .sort()
}

function load(file: string): Document {
  return new JSDOM(readFileSync(file, 'utf8')).window.document
}

/** HTML collapses runs of whitespace, so compare text the way a reader sees it. */
function text(node: Element | null): string {
  return (node?.textContent ?? '').replace(/\s+/g, ' ').trim()
}

/** Where a relative or root-relative link in `file` points on disk. */
function target(file: string, path: string): string {
  return path.startsWith('/')
    ? join(SITE_ROOT, path)
    : resolve(dirname(file), path === '' ? '.' : path)
}

/** The file Workers assets serve for that link: a folder's index, the file, or the clean `.html` path. */
function served(file: string, path: string): string {
  const onDisk = target(file, path)
  if (existsSync(onDisk) && statSync(onDisk).isDirectory()) return join(onDisk, 'index.html')
  return existsSync(onDisk) ? onDisk : `${onDisk}.html`
}

function cells(doc: Document, tableId: string): string[][] {
  const rows = Array.from(doc.querySelectorAll(`#${tableId} tbody tr`))
  return rows.map((row) => Array.from(row.querySelectorAll('th, td')).map(text))
}

describe('docs page mirrors the AI settings copy (F-15.10)', () => {
  const doc = load(join(SITE_ROOT, 'docs/index.html'))

  it('lists Use AI off and on and the three chat modes with their meanings verbatim (2026-10-07)', () => {
    expect(cells(doc, 'dial-levels')).toEqual([
      [`${USE_AI_LABEL} off`, USE_AI_MEANING.off],
      [`${USE_AI_LABEL} on`, USE_AI_MEANING.on],
      ...ASSISTANT_MODES.map((mode) => [ASSISTANT_MODE_LABEL[mode], ASSISTANT_MODE_MEANING[mode]])
    ])
  })

  it('lists every feature and what it sends, in the app’s order', () => {
    expect(cells(doc, 'feature-sharing')).toEqual(
      AI_FEATURES_BY_LEVEL.map((feature) => {
        const entry = AI_DATA_SHARING[feature]
        return [entry.label, entry.sends]
      })
    )
  })
})

describe('every page (F-15.10)', () => {
  const pages = htmlFiles()

  it('exists: landing, pricing, FAQ, privacy, terms, docs, and the 404 page', () => {
    expect(pages.map((file) => relative(SITE_ROOT, file).split(sep).join('/'))).toEqual([
      '404.html',
      'docs/index.html',
      'faq.html',
      'index.html',
      'pricing.html',
      'privacy.html',
      'terms.html'
    ])
  })

  it.each(pages)('%s has the document basics', (file) => {
    const doc = load(file)
    expect(doc.documentElement.getAttribute('lang')).toBe('en')
    expect(text(doc.querySelector('title'))).not.toBe('')
    expect(doc.querySelector('meta[charset]')?.getAttribute('charset')?.toLowerCase()).toBe('utf-8')
    expect(doc.querySelector('meta[name="viewport"]')?.getAttribute('content')).toContain(
      'width=device-width'
    )
    const sheets = Array.from(doc.querySelectorAll('link[rel="stylesheet"]')).map((link) =>
      link.getAttribute('href')
    )
    expect(sheets).toHaveLength(1)
    expect(sheets[0]).toMatch(/(^|\/)styles\.css$/)
    expect(doc.querySelectorAll('h1')).toHaveLength(1)
    expect(doc.querySelectorAll('main')).toHaveLength(1)
    for (const img of Array.from(doc.querySelectorAll('img'))) {
      expect(
        img.hasAttribute('alt'),
        `${file}: <img src="${img.getAttribute('src')}"> needs alt`
      ).toBe(true)
    }
    expect(doc.querySelectorAll('script, [style]')).toHaveLength(0)
  })

  it.each(pages)('%s links and assets resolve inside site/public', (file) => {
    const doc = load(file)
    const refs = Array.from(doc.querySelectorAll('a[href], link[href], img[src]'))
      .map((el) => el.getAttribute('href') ?? el.getAttribute('src') ?? '')
      .filter((ref) => !/^(#|mailto:|https?:\/\/)/.test(ref))
    expect(refs.length).toBeGreaterThan(0)
    for (const ref of refs) {
      const path = ref.replace(/[#?].*$/, '')
      expect(
        relative(SITE_ROOT, target(file, path)).startsWith('..'),
        `${ref} escapes the site`
      ).toBe(false)
      // Workers assets serve `/privacy` for `privacy.html` (`html_handling = "auto-trailing-slash"`)
      // and 307 the `.html` form, so pages link the clean path and the test resolves it.
      expect(path.endsWith('.html'), `${ref} should link the clean path`).toBe(false)
      expect(existsSync(served(file, path)), `${relative(SITE_ROOT, file)} → ${ref}`).toBe(true)
    }
  })

  it.each(pages)('%s links only to fragments that exist', (file) => {
    const doc = load(file)
    const refs = Array.from(doc.querySelectorAll('a[href*="#"]'))
      .map((el) => el.getAttribute('href') ?? '')
      .filter((ref) => !/^(mailto:|https?:\/\/)/.test(ref))
    for (const ref of refs) {
      const at = ref.indexOf('#')
      const path = ref.slice(0, at)
      const fragment = ref.slice(at + 1)
      const page = path === '' ? file : served(file, path)
      expect(
        load(page).getElementById(fragment),
        `${relative(SITE_ROOT, file)} → ${ref}`
      ).not.toBeNull()
    }
  })

  it('keeps a Download button in the sticky header of every page (2026-10-08)', () => {
    for (const file of pages) {
      const doc = load(file)
      expect(
        doc.querySelector('header.site-header a.header-download[href$="#download"]'),
        relative(SITE_ROOT, file)
      ).not.toBeNull()
    }
  })
})

describe('deploy files (F-15.10)', () => {
  it('sets the security headers for every path', () => {
    const headers = readFileSync(join(SITE_ROOT, '_headers'), 'utf8')
    expect(headers.startsWith('/*\n')).toBe(true)
    for (const name of [
      'X-Content-Type-Options: nosniff',
      'X-Frame-Options: DENY',
      'Referrer-Policy: strict-origin-when-cross-origin',
      'Permissions-Policy:',
      "Content-Security-Policy: default-src 'self'",
      'Strict-Transport-Security: max-age=31536000'
    ]) {
      expect(headers).toContain(name)
    }
  })

  it('has no _redirects file (Workers assets refuse absolute sources; www lives in a zone rule)', () => {
    expect(existsSync(join(SITE_ROOT, '_redirects'))).toBe(false)
  })
})
