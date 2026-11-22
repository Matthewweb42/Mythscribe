// Runs the shim as two "devices" (each its own IndexedDB and localStorage) against wrangler dev:
// the db contract Desk relies on, sync from one device to the other, and Ms Scribe's tool loop.
import vm from 'node:vm'
import fs from 'node:fs'
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb'
const SRC = fs.readFileSync(new URL('../../public/shim.js', import.meta.url), 'utf8')
const BASE = process.env.SMOKE_BASE || 'http://127.0.0.1:8797'
function device(name) {
  const store = new Map()
  const g = {
    console, setTimeout, clearTimeout, setInterval: () => 0, clearInterval() {}, queueMicrotask, structuredClone,
    TextEncoder, TextDecoder, URL, Blob, AbortController, Response, Headers, crypto, JSON, Promise,
    indexedDB: new IDBFactory(), IDBKeyRange,
    localStorage: { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) },
    fetch: (u, i) => fetch(new URL(u, BASE), i),
    navigator: { onLine: true }, location: { reload() {} },
    document: { visibilityState: 'visible', addEventListener() {}, getElementById: () => null, body: { appendChild() {} }, createElement: () => ({}) },
    addEventListener() {},
  }
  g.window = g; g.self = g
  vm.createContext(g); vm.runInContext(SRC, g, { filename: name + '/shim.js' })
  return g
}
const ok = (c, m) => { if (!c) { console.error('FAIL', m); process.exitCode = 1 } else console.log('ok  ', m) }
const A = device('A'), B = device('B')
const dbA = await A.claude.use('db')
ok(dbA, 'device A gets db')
// db contract
await dbA.doc('books/sor').set({ title: 'Test Book', meta: { words: 10, tags: ['a'] } })
await dbA.doc('books/sor').update({ meta: { words: 12 } })
let s = await dbA.doc('books/sor').get()
ok(s.exists && s.data().meta.words === 12 && s.data().meta.tags[0] === 'a', 'update deep-merges')
let threw = null; try { await dbA.doc('books/none').update({ x: 1 }) } catch (e) { threw = e.code }
ok(threw === 'invalid_argument', 'update on missing doc rejects invalid_argument')
const ch = dbA.collection('books/sor/chapters')
for (let i = 1; i <= 3; i++) await ch.doc('c' + i).set({ n: i, title: 'Chapter ' + i })
const added = await ch.add({ n: 4, title: 'Chapter 4' })
const q = await ch.where('n', '>=', 2).orderBy('n', 'desc').limit(2).get()
ok(q.size === 2 && q.docs[0].data().n === 4 && q.docs[1].data().n === 3, 'where/orderBy/limit query')
let events = []
const unsub = ch.orderBy('n').onSnapshot((qs) => events.push(qs.docChanges().map((c) => c.type + ':' + c.doc.id).join(',')))
await new Promise((r) => setTimeout(r, 20))
await ch.doc('c2').delete(); await ch.doc('c2').delete()
await new Promise((r) => setTimeout(r, 20)); unsub()
ok(events.length >= 2 && events.at(-1) === 'removed:c2', 'onSnapshot docChanges ' + JSON.stringify(events))
const lease = await dbA.doc('books/sor').acquire({ ttlMs: 5000 })
ok(lease.acquired === true, 'acquire lease')
// sync A -> server -> B
await A.__mythscribeWeb.sync.run()
const dbB = await B.claude.use('db')
const sb = await dbB.doc('books/sor').get()
const qb = await dbB.collection('books/sor/chapters').get()
ok(sb.exists && sb.data().title === 'Test Book', 'device B pulls the book on first open')
ok(qb.size === 3 && !qb.docs.some((d) => d.id === 'c2') && qb.docs.some((d) => d.id === added.id), 'device B has chapters, deletion carried ' + qb.docs.map((d) => d.id))
await dbB.doc('books/sor').update({ title: 'Test Book (edited on B)' })
await B.__mythscribeWeb.sync.run(); await A.__mythscribeWeb.sync.run()
s = await dbA.doc('books/sor').get()
ok(s.data().title === 'Test Book (edited on B)', 'edit on B reaches A')
// sample through /api/ai with the mock's tool round
const sample = await A.claude.use('sample')
let calls = 0, lastText = ''
const r = await sample([{ role: 'user', content: 'ctx' }, { role: 'assistant', content: 'Understood.' }, { role: 'user', content: 'Who is Kael?' }], {
  tools: [{ name: 'search_book', description: 'Search the book', inputSchema: { type: 'object', properties: { q: { type: 'string' } } }, execute: async (i) => { calls++; return { hits: [i.q] } } }],
  onText: ({ text }) => { lastText = text },
})
ok(calls === 1 && r.text === 'Kael is the heir of Ashkeep.' && lastText === r.text, 'sample tool loop + streaming: ' + JSON.stringify(r))
const j = await sample.json('give json', { modelTier: 'quick', cache: false }).catch((e) => e.code)
ok(j === 'invalid_json', 'sample.json rejects non-JSON with invalid_json')
const usage = await (await fetch(BASE + '/api/usage')).json()
console.log('usage', usage)
const log = await (await fetch((process.env.SMOKE_AI || 'http://127.0.0.1:8798') + '/__log')).json()
console.log('models seen', log.map((l) => l.body.model + (l.body.tools ? '+tools' : '') + (l.body.messages.some((m) => Array.isArray(m.content)) ? '+tool_result' : '')).join(' | '))
process.exit()
