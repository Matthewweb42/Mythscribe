# Mythscribe Desk on the web

Mythscribe Desk (the claude.ai artifact) as a normal web app: the same page, running in any
browser, with Ms Scribe on the Anthropic API and books kept in the browser and synced to the
server. Week 1 of the plan: a simple MVP. Week 2 adds reader links for beta readers.

## What's here

- `desk/mythscribe-desk.html`: Desk's page, copied exactly from the artifact. To update, copy the
  newer page over it and run `npm run build`; the build stops if a patch no longer fits.
- `desk/patches/local-doc-import.js` and `scripts/build.mjs`: the few changes the web needs, made
  at build time inside Desk's own code. "Bring in a doc" picks a Word file (.docx), or a .txt or .md
  file, from the device instead of Google Drive; the labels say "Word file"; the session copy no
  longer mentions claude.ai.
- `public/shim.js`: what `window.claude.use(...)` gives Desk in a browser.
  - `db`: every document in IndexedDB, synced to the server (last writer wins, per document).
  - `sample`: Ms Scribe through `/api/ai`, streamed, with Desk's tools run in the browser.
  - `downloads` and `assets`: files saved through the browser; pictures kept on this device.
  - `mcp`: none, so Desk hides what needs Drive.
- `src/`: the Cloudflare Worker.
  - `/api/ai`: Anthropic, with prompt caching on every call. Haiku 5.5 runs quick jobs (fact
    filing); Sonnet 5.5 runs chat and checks, with the server-side refusal fallback on. Each call's
    tokens and cost go in `ai_usage`, and a monthly cap per account applies (`AI_MONTHLY_CAP_USD`,
    default $10).
  - `/api/sync`: the books, in D1.
  - `/api/rooms` and `/r/<link>`: reader links (below).
  - `/api/auth/*`: sign-in with the MythScribe account the cloud Worker already has. It's passed
    through unchanged, and the cloud Worker itself isn't changed.

## Reader links (week 2)

Desk already makes a reading page for a beta reader and brings their notes back in. On the web,
Send to a reader can give a link instead of a file:

1. The author picks Send to a reader, names the reader and keeps "A reader link". Desk makes its
   usual reading page and keeps it on the server (`POST /api/rooms`); the author copies the link.
2. The reader opens `/r/<link>` in any browser, selects words (or uses Note on this chapter) and
   writes a note. Each note is sent a moment later (`PUT /api/r/<link>/notes`); Send my notes sends
   at once. On another device the reader sees the notes they already sent.
3. The author opens Revise › Readers › Reader links, sees each reader with their note count, and
   picks Bring in notes. That runs Desk's own Bring in notes preview, so the notes land as reader
   notes on their scenes or chapters, in Review and in the scene's Notes panel, with no duplicates
   on a second bring-in. Stop link closes a link for good.

How it's kept apart: the link is a 32-character random token, and it's the only key. The reading
page is served with a CSP `sandbox` (no same-origin), so its script can't see the author's
sign-in on the same site, and it can reach only its own notes. Limits: 30 MB per page, 2,000
notes or 2 MB per reader, 200 links per book.

## Run it on your computer

```
cd web
npm install --legacy-peer-deps
cp .dev.vars.example .dev.vars     # then put your Anthropic key in .dev.vars
npm run dev                        # http://localhost:8787
```

`.dev.vars` sets `AUTH_MODE=none`, so there's no sign-in locally: one local author. It's ignored
by git.

Checks:

- `npm test`: the unit tests.
- `npm run typecheck`: the type check.
- `npm run smoke`: Desk's page and the shim against a throwaway `wrangler dev` and a stand-in for
  the Anthropic API, with no key and no cost. It covers a new book from a Word file, a backup
  restored on a second device, sync between two devices, Ms Scribe's tool loop, and a reader
  link from making it to bringing the reader's note in.

## What you create before it goes live

Nothing in your Cloudflare account was created or changed for this.

1. The database: `npx wrangler d1 create mythscribe-web`. Put the id it prints in `wrangler.toml`
   in place of the zeros.
2. Its tables: `npx wrangler d1 migrations apply mythscribe-web --remote`. This applies both
   migrations, `0001_web.sql` and `0002_rooms.sql` (reader links). Nothing else is new for week 2.
3. The AI key: `npx wrangler secret put ANTHROPIC_API_KEY`.
4. An address. The Worker has no route and `workers_dev = false`, so a deploy reaches nobody until
   you add one, for example a `routes` entry for `desk.mythscribe.app`. The live mythscribe.app
   site isn't touched.
5. Then `npx wrangler deploy`.

Sign-in uses `CLOUD_API` (`https://api.mythscribe.app`), so the cloud Worker must be deployed
for sign-in to work.

## Known gaps (on purpose, for now)

- Pictures stay on the device they were added on. They aren't synced yet, and the first visit may
  need one reload before they show.
- No Google Drive import and no PDF import yet. Word, text and Markdown files work.
- No offline app (PWA) yet. The page needs the network to load, though books open from the
  browser's copy.
- No balance or payments, only the monthly cap and the usage log.
- Two devices editing the same scene at the same moment: the last save wins.
- The cloud Worker's sign-in limits count every web sign-in as coming from this Worker.
- Reader links: pictures in the book don't show on the reader's page; anyone with the link can
  read and leave notes (there's no reader sign-in); one link per reader, so two readers need two
  links; and notes come in when the author picks Bring in notes, not live.
