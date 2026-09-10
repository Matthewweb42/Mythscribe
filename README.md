# MythScribe

A local-first desktop app for writing novels: Scrivener-style manuscript organizer, distraction-free
editor, story tagging, and AI assistance that keeps your voice.

**Status:** rebuilding from a clean specification. Milestone M0 (foundation) is built. The previous
prototype lives at git tag `v0-legacy`.

- What it does and will do: [`FEATURES.md`](FEATURES.md)
- Why the AI and the business are shaped the way they are: [`PLAN.md`](PLAN.md)
- How the project is built with Claude Code: [`CLAUDE.md`](CLAUDE.md)

## Develop

```
npm install
npm run dev
npm run test
npm run test:e2e
```

Electron on Linux/WSL needs `libnss3 libnspr4 libasound2t64` installed once.
