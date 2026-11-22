# Mythscribe Desk on the web

Mythscribe Desk (the claude.ai artifact) as a normal web app: the same page, running in any
browser, with Ms Scribe on the Anthropic API and books kept in the browser and synced to the
server. Week 1 of the plan: a simple MVP.

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
  - `/api/auth/*`: sign-in with the MythScribe account the cloud Worker already has. It's passed
    through unchanged, and the cloud Worker itself isn't changed.

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
  restored on a second device, sync between two devices, and Ms Scribe's tool loop.

## What you create before it goes live

Nothing in your Cloudflare account was created or changed for this.

1. The database: `npx wrangler d1 create mythscribe-web`. Put the id it prints in `wrangler.toml`
   in place of the zeros.
2. Its tables: `npx wrangler d1 migrations apply mythscribe-web --remote`.
3. The AI key: `npx wrangler secret put ANTHROPIC_API_KEY`.
4. An address. The Worker has no route and `workers_dev = false`, so a deploy reaches nobody until
   you add one, for example a `routes` entry for `desk.mythscribe.app`. The live mythscribe.app
   site isn't touched.
5. Then `npx wrangler deploy`.

Sign-in uses `CLOUD_API` (`https://api.mythscribe.app`), so the cloud Worker must be deployed
for sign-in to work.

## Known gaps (on purpose, for week 1)

- Pictures stay on the device they were added on. They aren't synced yet, and the first visit may
  need one reload before they show.
- No Google Drive import and no PDF import yet. Word, text and Markdown files work.
- No offline app (PWA) yet. The page needs the network to load, though books open from the
  browser's copy.
- No balance or payments, only the monthly cap and the usage log.
- Two devices editing the same scene at the same moment: the last save wins.
- The cloud Worker's sign-in limits count every web sign-in as coming from this Worker.
