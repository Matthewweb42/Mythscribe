// Boots the built Desk page (public/index.html + shim) in jsdom against wrangler dev.
import fs from 'node:fs'
import { JSDOM, VirtualConsole, ResourceLoader } from 'jsdom'
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb'
const JSZIP_SRC = fs.readFileSync(new URL('../../node_modules/jszip/dist/jszip.min.js', import.meta.url), 'utf8')
const BASE = process.env.SMOKE_BASE || 'http://127.0.0.1:8797'
const HTML = fs.readFileSync(new URL('../../public/index.html', import.meta.url), 'utf8')
const SHIM = fs.readFileSync(new URL('../../public/shim.js', import.meta.url), 'utf8')
export async function boot(name, idb = new IDBFactory()) {
  const errors = []
  const vc = new VirtualConsole()
  vc.on('jsdomError', (e) => errors.push('jsdom: ' + (e.message || e).toString().slice(0, 300)))
  vc.on('error', (...a) => errors.push('console.error: ' + a.map(String).join(' ').slice(0, 300)))
  vc.on('warn', (...a) => errors.push('console.warn: ' + a.map(String).join(' ').slice(0, 300)))
  class Loader extends ResourceLoader {
    fetch(url, opts) {
      if (url.endsWith('/shim.js')) return Promise.resolve(Buffer.from(SHIM))
      return Promise.reject(new Error('blocked in test: ' + url))
    }
  }
  const dom = new JSDOM(HTML, {
    url: BASE + '/', runScripts: 'dangerously', resources: new Loader(), pretendToBeVisual: true, virtualConsole: vc,
    beforeParse(w) {
      w.indexedDB = idb; w.IDBKeyRange = IDBKeyRange
      w.fetch = (u, i) => fetch(new URL(String(u), BASE), i)
      w.TextDecoder = TextDecoder; w.TextEncoder = TextEncoder; w.ReadableStream = ReadableStream; w.structuredClone = structuredClone
      w.Response = Response; w.Headers = Headers
      w.Blob.prototype.text ??= function () { return new Promise((r) => { const fr = new w.FileReader(); fr.onload = () => r(fr.result); fr.readAsText(this) }) }
      w.setImmediate = setImmediate; w.eval(JSZIP_SRC) // in-page copy, as the CDN would give it
      w.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} })
      w.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} }
      w.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} }
      w.scrollTo = () => {}; w.HTMLElement.prototype.scrollIntoView = function () {}
      if (!w.crypto?.randomUUID) Object.defineProperty(w, 'crypto', { value: globalThis.crypto })
    },
  })
  return { dom, w: dom.window, errors }
}
export const wait = (ms) => new Promise((r) => setTimeout(r, ms))
