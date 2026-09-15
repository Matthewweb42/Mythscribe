import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { JSDOM } from 'jsdom'
import { describe, expect, it } from 'vitest'
import {
  AI_DATA_SHARING,
  AI_DIAL_LABEL,
  AI_DIAL_LEVELS,
  AI_DIAL_MEANING,
  AI_FEATURES_BY_LEVEL
} from './aiSettings'

/**
 * The website (F-15.10) is static HTML under `site/public/`, deployed as-is. These tests keep it
 * honest without a build step: the docs page must quote the app's dial and data-sharing copy
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

function cells(doc: Document, tableId: string): string[][] {
  const rows = Array.from(doc.querySelectorAll(`#${tableId} tbody tr`))
  return rows.map((row) => Array.from(row.querySelectorAll('th, td')).map(text))
}

describe('docs page mirrors the AI settings copy (F-15.10)', () => {
  const doc = load(join(SITE_ROOT, 'docs/index.html'))

  it('lists the four dial levels with their labels and meanings verbatim', () => {
    expect(cells(doc, 'dial-levels')).toEqual(
      AI_DIAL_LEVELS.map((level) => [String(level), AI_DIAL_LABEL[level], AI_DIAL_MEANING[level]])
    )
  })

  it('lists every feature, what it sends, and the level it needs, in the app’s order', () => {
    expect(cells(doc, 'feature-sharing')).toEqual(
      AI_FEATURES_BY_LEVEL.map((feature) => {
        const entry = AI_DATA_SHARING[feature]
        return [entry.label, entry.sends, AI_DIAL_LABEL[entry.minDial]]
      })
    )
  })
})

describe('every page (F-15.10)', () => {
  const pages = htmlFiles()

  it('exists: landing, privacy, terms, docs, and the 404 page', () => {
    expect(pages.map((file) => relative(SITE_ROOT, file).split(sep).join('/'))).toEqual([
      '404.html',
      'docs/index.html',
      'index.html',
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
      const target = path.startsWith('/')
        ? join(SITE_ROOT, path)
        : resolve(dirname(file), path === '' ? '.' : path)
      expect(relative(SITE_ROOT, target).startsWith('..'), `${ref} escapes the site`).toBe(false)
      // Workers assets serve `/privacy` for `privacy.html` (`html_handling = "auto-trailing-slash"`)
      // and 307 the `.html` form, so pages link the clean path and the test resolves it.
      expect(path.endsWith('.html'), `${ref} should link the clean path`).toBe(false)
      const resolved =
        existsSync(target) && statSync(target).isDirectory()
          ? join(target, 'index.html')
          : existsSync(target)
            ? target
            : `${target}.html`
      expect(existsSync(resolved), `${relative(SITE_ROOT, file)} → ${ref}`).toBe(true)
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
