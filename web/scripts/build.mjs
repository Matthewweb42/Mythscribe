// Builds public/index.html from Desk's page (desk/mythscribe-desk.html, kept exactly as the
// artifact has it) plus a few small, checked patches. Each patch names the exact text it
// expects to find once; if Desk changes and a patch no longer fits, the build stops.
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(here, '..')
// Read with Unix line endings, so the patches match on a Windows checkout (git autocrlf) too.
const read = (...p) => readFileSync(path.join(root, ...p), 'utf8').replace(/\r\n/g, '\n')
const src = read('desk', 'mythscribe-desk.html')
const localImport = read('desk', 'patches', 'local-doc-import.js')
const readerLinks = read('desk', 'patches', 'reader-links.js')

const patches = [
  {
    why: 'load the browser shim before any of Desk runs',
    find: '<!doctype html><html><head><meta charset=utf8>',
    replace: (m) => m + '<script src="/shim.js"></script>'
  },
  {
    why: 'with no Google Drive, "bring in a doc" picks a Word, text or Markdown file from this device',
    find: 'function openDocImport(target) {\n  if (!mcp) { toast("Drive isn\'t available in this view."); return; }',
    replace: () => localImport + '\nfunction openDocImport(target) {\n  if (!mcp) { openLocalDocImport(target); return; }'
  },
  {
    why: 'sign-in copy: there is no claude.ai session on the web',
    find: 'session_expired: "Your session expired. Sign in to claude.ai again."',
    replace: () => 'session_expired: "Your session expired. Sign in again."'
  },
  // Labels: on the web, "bring in a doc" means a Word, text or Markdown file (no Drive, no PDF yet).
  ...[
    ['<span class="label">From a Google Doc, Word file or PDF</span>', '<span class="label">From a Word file</span>'],
    ['id="bringDoc" type="button">Bring in another Google Doc…', 'id="bringDoc" type="button">Bring in another Word file…'],
    ['<p id="blankText">Add a chapter to start writing, or bring in a Google Doc.</p>', '<p id="blankText">Add a chapter to start writing, or bring in a Word file.</p>'],
    ['id="blankImport" type="button">Import a Google Doc</button>', 'id="blankImport" type="button">Import a Word file</button>'],
    ["bring one in from a Google Doc, Word file or PDF.", "bring one in from a Word file."],
    ['No chapters yet. Use Add, or bring in a Google Doc.', 'No chapters yet. Use Add, or bring in a Word file.'],
    ['empty ? "Add a chapter to start writing, or bring in a Google Doc."', 'empty ? "Add a chapter to start writing, or bring in a Word file."'],
    ['add("Import a Google Doc into this book"', 'add("Import a Word file into this book"'],
    ['add("New book from a Google Doc"', 'add("New book from a Word file"'],
    ['{ label: "Import a Google Doc…"', '{ label: "Import a Word file…"']
  ].map(([find, to]) => ({ why: 'say "Word file" where Desk offers a Google Doc', find, replace: () => to })),
  // Reader links: Send to a reader can give a link; notes come back under Revise › Readers › Reader links.
  {
    why: 'put the reader-link code inside Desk, beside Send to a reader',
    find: 'function sendToReaderModal() {',
    replace: () => readerLinks + '\nfunction sendToReaderModal() {'
  },
  ...[
    ['name="rdFmt" value="page" checked>', 'name="rdFmt" value="page"\' + (webRooms() ? "" : " checked") + \'>'],
    ['<div class="field"><span>As</span><label class="adddest"><input type="radio" name="rdFmt"', '<div class="field"><span>As</span>\' + (webRooms() ? \'<label class="adddest"><input type="radio" name="rdFmt" value="link" checked> A reader link: they read in their browser and select words to leave a note. Their notes come back to you here.</label>\' : "") + \'<label class="adddest"><input type="radio" name="rdFmt"'],
    ["Nothing is sent from here: you get the file and send it yourself. When notes come back, use Bring in notes. If you\\'d rather give them a page on claude.ai, ask Claude in your Mythscribe chat to put the reading page up for you.", "Nothing is sent from here: you send the link or the file yourself. Notes from a link come back under Revise › Readers › Reader links; notes in a file, with Bring in notes."],
    ['id="rdOk">Make the file</button>', 'id="rdOk">Make it</button>'],
    ['if (fmt === "page" && !name) {', 'if ((fmt === "page" || fmt === "link") && !name) {'],
    ['await makeReaderPage(name, what === "ch" && ch ? ch.id : null);', 'await makeReaderPage(name, what === "ch" && ch ? ch.id : null, fmt === "link");'],
    ['async function makeReaderPage(name, rootId) {', 'async function makeReaderPage(name, rootId, asLink) {'],
    ['  const ok = await saveFile(fileName(data.book + " for " + name) + ".html", html, "text/html");', '  if (asLink && (await shareReaderPage(data, html))) return;\n  const ok = await saveFile(fileName(data.book + " for " + name) + ".html", html, "text/html");'],
    ['data-rdin>Bring in notes…</button>', 'data-rdin>Bring in notes…</button>\' + (webRooms() ? \'<button class="iconbtn" type="button" data-rdlinks>Reader links…</button>\' : "") + \''],
    ['if (t.closest("[data-rdin]")) { bringNotesIn(); return; }', 'if (t.closest("[data-rdin]")) { bringNotesIn(); return; }\n    if (t.closest("[data-rdlinks]")) { openReaderLinks(); return; }'],
    // the reading page itself: on a link, notes are sent as the reader goes, not saved to a file
    ['var save = function () { try { localStorage.setItem(KEY, JSON.stringify(notes)); } catch (e) {} };', "var ROOM = (/^\\/r\\/([A-Za-z0-9_-]{32})$/.exec(location.pathname) || [])[1] || null, sendT = 0;\n  var push = function (show) {\n    if (!ROOM) return;\n    clearTimeout(sendT); var b = document.getElementById(\"saveBtn\");\n    fetch(\"/api/r/\" + ROOM + \"/notes\", { method: \"PUT\", headers: { \"content-type\": \"application/json\" }, body: JSON.stringify({ notes: notes }) })\n      .then(function (r) { if (!r.ok) throw new Error(String(r.status)); if (b) { b.textContent = show ? \"Sent\" : \"Send my notes\"; if (show) setTimeout(function () { b.textContent = \"Send my notes\"; }, 2500); } })\n      .catch(function () { if (b) b.textContent = \"Not sent yet. Tap to try again\"; });\n  };\n  var save = function () { try { localStorage.setItem(KEY, JSON.stringify(notes)); } catch (e) {} if (ROOM) { clearTimeout(sendT); sendT = setTimeout(push, 1200); } };"],
    ['id="saveBtn">Save my notes</button>', 'id="saveBtn">\' + (ROOM ? "Send my notes" : "Save my notes") + \'</button>'],
    ["Your notes stay in this browser until you save them. When you’re done, press Save my notes and send the file you get back to ' + E(D.author || \"the author\") + '.</p>';", "' + (ROOM ? \"Your notes go to \" + E(D.author || \"the author\") + \" as you write them.\" : \"Your notes stay in this browser until you save them. When you’re done, press Save my notes and send the file you get back to \" + E(D.author || \"the author\") + \".\") + '</p>';"],
    ['$("saveBtn").onclick = async function () {', '$("saveBtn").onclick = async function () {\n    if (ROOM) { push(true); return; }'],
    ['setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 2000);\n  };', "setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 2000);\n  };\n  if (ROOM) fetch(\"/api/r/\" + ROOM + \"/notes\").then(function (r) { return r.ok ? r.json() : null; }).then(function (j) {\n    if (!j || !Array.isArray(j.notes)) return;\n    var key = function (n) { return (n.at || 0) + \"|\" + (n.quote || \"\") + \"|\" + (n.text || \"\"); }, seen = {}, added = 0;\n    notes.forEach(function (n) { seen[key(n)] = 1; });\n    j.notes.forEach(function (n) { if (!seen[key(n)]) { notes.push(n); added++; } });\n    if (added) { notes.sort(function (a, b) { return (a.at || 0) - (b.at || 0); }); paint(); }\n    if (notes.length > j.notes.length) push();\n  }).catch(function () {});"]
  ].map(([find, to]) => ({ why: 'reader links in Send to a reader, Readers and the reading page', find, replace: () => to }))
]

let out = src
for (const p of patches) {
  const count = out.split(p.find).length - 1
  if (count !== 1) {
    console.error(`build: the patch to ${p.why} expected its text once in Desk's page and found it ${count} times.`)
    process.exit(1)
  }
  out = out.replace(p.find, () => p.replace(p.find))
}
writeFileSync(path.join(root, 'public', 'index.html'), out)
console.log(`build: public/index.html (${(out.length / 1024).toFixed(0)} KB, ${patches.length} patches)`)
