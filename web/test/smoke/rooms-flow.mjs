// Reader links, end to end on Desk's own page in jsdom (test data only): the author makes a link
// for "Sam", the link serves the reading page with its sandbox, Sam's page sends notes, and the
// author brings them in through Desk's own preview, where they land as reader notes.
import JSZip from 'jszip'
import { JSDOM, VirtualConsole } from 'jsdom'
import { boot, wait } from './desk-boot.mjs'
const BASE = process.env.SMOKE_BASE || 'http://127.0.0.1:8797'
const ok = (c, m) => { console.log(c ? 'ok  ' : 'FAIL', m); if (!c) process.exitCode = 1 }
const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"'
const para = (t, style) => `<w:p>${style ? `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>` : ''}<w:r><w:t xml:space="preserve">${t}</w:t></w:r></w:p>`
const zip = new JSZip()
zip.file('[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>')
zip.file('word/document.xml', `<?xml version="1.0"?><w:document ${W}><w:body>` + para('Room Test Book', 'Title') +
  para('Chapter One', 'Heading1') + para('The lantern swung over the quay.') + para('Chapter Two', 'Heading1') + para('Gulls argued at dawn.') + '</w:body></w:document>')
const docx = await zip.generateAsync({ type: 'uint8array' })

const A = await boot('A'); const w = A.w, d = w.document
await wait(4000)
d.getElementById('shelfDoc').click(); await wait(300)
const inp = d.getElementById('gdFile')
Object.defineProperty(inp, 'files', { value: [new w.File([docx], 'Room Test Book.docx')] }); inp.dispatchEvent(new w.Event('change'))
await wait(1500); d.getElementById('gdGo')?.click(); await wait(3000)
const q = (sel) => d.querySelector(sel)
d.getElementById('tab-revise').click(); await wait(800)
ok(!!q('[data-rdsend]') && !!q('[data-rdlinks]'), 'Revise › Readers shows Send to a reader and Reader links')

// 1) the author makes a link for Sam
q('[data-rdsend]').click(); await wait(300)
ok(q('input[name="rdFmt"][value="link"]')?.checked, 'Send to a reader offers "A reader link" first')
d.getElementById('rdName').value = 'Sam'
d.getElementById('rdOk').click(); await wait(2500)
const link = d.getElementById('rlLink')?.value || ''
const token = (/\/r\/([A-Za-z0-9_-]{32})$/.exec(link) || [])[1]
ok(!!token, 'a link was made: ' + link.replace(/\/r\/.+/, '/r/…'))

// 2) the link serves the reading page, sandboxed
const page = await fetch(link)
const csp = page.headers.get('content-security-policy') || ''
const html = await page.text()
ok(page.status === 200 && /^sandbox allow-scripts/.test(csp) && !/allow-same-origin/.test(csp), 'reading page served with its sandbox: ' + page.status + ' ' + csp.slice(0, 60))
ok(/Lantern|lantern swung/.test(html) && /mythscribe-reader/.test(html), 'it holds the book text')
ok((await fetch(BASE + '/r/' + 'x'.repeat(32))).status === 404, 'an unknown link is a 404')
const pre = await fetch(BASE + '/api/r/' + token + '/notes', { method: 'OPTIONS', headers: { origin: 'null', 'access-control-request-method': 'PUT' } })
ok(pre.status === 204 && pre.headers.get('access-control-allow-origin') === '*', 'notes API answers CORS preflight')

// 3) Sam's page: open it, leave a note, and it is sent
const vc = new VirtualConsole(); const rErr = []; vc.on('jsdomError', (e) => rErr.push(String(e.message || e)))
const R = new JSDOM(html, { url: link, runScripts: 'dangerously', pretendToBeVisual: true, virtualConsole: vc,
  beforeParse(rw) { rw.fetch = (u, i) => fetch(new URL(String(u), BASE), i); rw.scrollTo = () => {}; rw.HTMLElement.prototype.scrollIntoView = function () {} } })
await wait(1200)
const rd = R.window.document
ok(/Send my notes/.test(rd.getElementById('saveBtn')?.textContent || ''), 'the reader sees "Send my notes"')
ok(/as you write them/.test(rd.body.textContent), 'the reader is told their notes go to the author as they write')
// Sam leaves a note on Chapter One with the page's own button; the page sends it after a pause
rd.querySelector('.chnote').click(); await wait(100)
rd.getElementById('dt').value = 'Lovely image, but is it night?'
rd.getElementById('dok').click(); await wait(3000)
const sent = await (await fetch(BASE + '/api/r/' + token + '/notes')).json()
ok(sent.notes?.length === 1 && sent.notes[0].scope === 'chapter' && /is it night/.test(sent.notes[0].text), 'Sam\'s note reached the server by itself: ' + JSON.stringify(sent.notes?.map((n) => n.scope + ':' + n.text)))
const note = sent.notes[0]
const R2 = new JSDOM(html, { url: link, runScripts: 'dangerously', pretendToBeVisual: true, virtualConsole: vc,
  beforeParse(rw) { rw.fetch = (u, i) => fetch(new URL(String(u), BASE), i); rw.scrollTo = () => {}; rw.HTMLElement.prototype.scrollIntoView = function () {} } })
await wait(1500)
ok(/\(1\)|>1</.test(R2.window.document.getElementById('showList')?.innerHTML || ''), 'on another device Sam\'s page shows the note it sent: ' + (R2.window.document.getElementById('showList')?.textContent || ''))
const big = await fetch(BASE + '/api/r/' + token + '/notes', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ notes: [{ ...note, text: 'x'.repeat(2_100_000) }] }) })
ok(big.status === 413, 'oversized notes are refused: ' + big.status)

// 4) the author lists links and brings the notes in
d.getElementById('tab-revise').click(); await wait(800)
q('[data-rdlinks]').click(); await wait(1500)
const row = d.getElementById('rlList')?.textContent || ''
ok(/Sam/.test(row) && /1 note/.test(row), 'Reader links lists Sam with 1 note: ' + row.replace(/\s+/g, ' ').slice(0, 80))
q('[data-rlin]').click(); await wait(1500)
ok(/Bring in 1/.test(d.getElementById('riOk')?.textContent || ''), 'Desk\'s Bring in notes preview opens with Sam\'s note')
d.getElementById('riOk')?.click(); await wait(2500)
const db = await w.claude.use('db')
const bk = (await db.collection('books').get()).docs.find((b) => /Room Test Book/.test(b.data().title))
const nn = bk ? (await db.collection('books/' + bk.id + '/nextnotes').get()).docs.map((x) => x.data()) : []
const got = nn.find((x) => /is it night/.test(x.text || ''))
ok(got && got.by === 'reader' && got.reader === 'Sam' && got.scope === 'chapter' && got.nodeId, 'the note is now a reader note on Chapter One: ' + JSON.stringify(got && { by: got.by, reader: got.reader, scope: got.scope }))

// 5) stopping the link
d.getElementById('tab-revise').click(); await wait(800)
q('[data-rdlinks]').click(); await wait(1200)
q('[data-rlstop]').click(); await wait(300)
d.getElementById('cmOk')?.click(); await wait(1200)
ok((await fetch(link)).status === 404 && (await fetch(BASE + '/api/r/' + token + '/notes')).status === 404, 'a stopped link no longer opens')
const errs = [...A.errors, ...rErr].filter((e) => !/fonts.googleapis|navigation|Not implemented: HTMLAnchor|Not implemented: window.getSelection|clipboard/.test(e))
console.log('errors:', errs.length); for (const e of errs.slice(0, 12)) console.log('  ', e)
process.exit()
