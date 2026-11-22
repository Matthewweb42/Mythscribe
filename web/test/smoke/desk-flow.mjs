// Drives Desk's own page in jsdom: a new book from a Word file, "Back up all books", then
// "Restore a backup" on a second device. Test data only.
import JSZip from 'jszip'
import { boot, wait } from './desk-boot.mjs'
const ok = (c, m) => { console.log(c ? 'ok  ' : 'FAIL', m); if (!c) process.exitCode = 1 }
const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"'
const para = (t, style) => `<w:p>${style ? `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>` : ''}${t}</w:p>`
const run = (t, i) => `<w:r>${i ? '<w:rPr><w:i/></w:rPr>' : ''}<w:t xml:space="preserve">${t}</w:t></w:r>`
const xml = `<?xml version="1.0"?><w:document ${W}><w:body>` +
  para(run('Sample Saga'), 'Title') +
  para(run('Chapter One'), 'Heading1') + para(run('The rain fell on ') + run('Ashkeep', true) + run(' all night.')) + para(run('Kael waited.')) +
  para(run('Chapter Two'), 'Heading1') + para(run('Morning came grey.')) +
  para(run('Chapter Three'), 'Heading1') + para(run('The gate opened.')) +
  `</w:body></w:document>`
const zip = new JSZip()
zip.file('[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>')
zip.file('word/document.xml', xml)
const docx = await zip.generateAsync({ type: 'uint8array' })

const A = await boot('A'); const w = A.w, d = w.document
await wait(4000)
const db = await w.claude.use('db')
const before = (await db.collection('books').get()).size
// 1) Word import on the shelf
d.getElementById('shelfDoc').click(); await wait(300)
const inp = d.getElementById('gdFile')
ok(!!inp, 'shelf "From a Word file" opens a file picker (label: ' + d.getElementById('shelfDoc').textContent.trim().replace(/\s+/g, ' ') + ')')
const file = new w.File([docx], 'Sample Saga.docx', { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' })
Object.defineProperty(inp, 'files', { value: [file] }); inp.dispatchEvent(new w.Event('change'))
await wait(1500)
console.log('   state:', d.getElementById('gdState')?.textContent, '| how:', [...(d.getElementById('gdHow')?.options || [])].map((o) => o.textContent).join(' / '))
console.log('   preview:', d.getElementById('gdPreview')?.textContent.replace(/\s+/g, ' ').slice(0, 160))
d.getElementById('gdGo')?.click(); await wait(2500)
const books = (await db.collection('books').get()).docs
const nb = books.find((b) => /Sample Saga/.test(b.data().title || ''))
ok(books.length === before + 1 && nb, 'a new book was made: ' + books.map((b) => b.data().title).join(', '))
const nodes = nb ? (await db.collection('books/' + nb.id + '/nodes').get()).docs.map((x) => x.data()) : []
const html = nodes.map((n) => n.html || '').join(' ')
ok(nodes.filter((n) => n.level === 'chapter' || n.kind === 'doc').length >= 3, 'chapters made: ' + nodes.map((n) => (n.title || '') + '[' + (n.level || n.kind) + ']').join(', '))
ok(/<em>Ashkeep<\/em>/.test(html) && /Kael waited/.test(html), 'italics and paragraphs kept: ' + html.slice(0, 140))
// 2) Back up all books
let saved = null
w.URL.createObjectURL = (b) => { saved = b; return 'blob:test' }; w.URL.revokeObjectURL = () => {}
d.getElementById('settingsBtn').click(); await wait(300)
d.getElementById('setBackup').click(); await wait(2500)
const backupText = saved ? await new Promise((r) => { const fr = new w.FileReader(); fr.onload = () => r(fr.result); fr.readAsText(saved) }) : ''
const backup = backupText ? JSON.parse(backupText) : null
ok(backup && backup.app === 'Mythscribe Desk' && backup.books.length === books.length, 'backup file made with ' + (backup?.books.length ?? 0) + ' books, ' + backupText.length + ' bytes')
await A.w.__mythscribeWeb.sync.run()
// 3) Restore it on a second device
const B = await boot('B'); const wb = B.w, db2 = B.w.document
await wait(4000)
const dbB = await wb.claude.use('db')
const onB = (await dbB.collection('books').get()).size
ok(onB === books.length, 'device B sees the same ' + onB + ' books after sign-in sync')
let picker = null
wb.HTMLInputElement.prototype.click = function () { if (this.type === 'file') picker = this }
db2.getElementById('settingsBtn').click(); await wait(300)
db2.getElementById('setRestore').click(); await wait(200)
ok(!!picker, 'Restore a backup opens a file picker')
Object.defineProperty(picker, 'files', { value: [new wb.File([backupText], 'Mythscribe Desk backup.json', { type: 'application/json' })] })
picker.dispatchEvent(new wb.Event('change')); await wait(800)
db2.getElementById('cmOk')?.click(); await wait(4000)
const after = (await dbB.collection('books').get()).docs.map((b) => b.data().title)
ok(after.filter((t) => / \(restored\)$/.test(t)).length === books.length, 'restored copies: ' + after.join(', '))
const rb = (await dbB.collection('books').get()).docs.find((b) => /Sample Saga.*restored/.test(b.data().title))
const rn = rb ? (await dbB.collection('books/' + rb.id + '/nodes').get()).size : 0
ok(rn === nodes.length, 'restored book has all ' + rn + ' of ' + nodes.length + ' contents entries')
const errs = [...A.errors, ...B.errors].filter((e) => !/fonts.googleapis|navigation|Not implemented: HTMLAnchor/.test(e))
console.log('errors:', errs.length); for (const e of errs.slice(0, 12)) console.log('  ', e)
process.exit()
