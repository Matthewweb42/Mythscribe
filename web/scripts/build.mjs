// Builds public/index.html from Desk's page (desk/mythscribe-desk.html, kept exactly as the
// artifact has it) plus a few small, checked patches. Each patch names the exact text it
// expects to find once; if Desk changes and a patch no longer fits, the build stops.
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(here, '..')
const src = readFileSync(path.join(root, 'desk', 'mythscribe-desk.html'), 'utf8')
const localImport = readFileSync(path.join(root, 'desk', 'patches', 'local-doc-import.js'), 'utf8')

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
  ].map(([find, to]) => ({ why: 'say "Word file" where Desk offers a Google Doc', find, replace: () => to }))
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
