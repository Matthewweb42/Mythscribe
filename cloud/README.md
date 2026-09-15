# MythScribe Cloud proxy (`cloud/`)

The Worker behind `api.mythscribe.app` (F-15.4). The app calls it when a project uses
MythScribe's key (F-15.11) instead of the author's own; it never sees the author's key and never
stores manuscript text. The code lands with F-15.4; this folder exists now so the operator's
secret has one right place.

## Where the secret key goes

The operator's OpenAI key is a **Worker secret**, never a file in the repo and never inside the
desktop app (anything in the app can be extracted).

Production (run from this folder, once per key rotation; wrangler prompts for the value):

```
cd cloud
npx wrangler secret put OPENAI_API_KEY
```

Local development (`wrangler dev`): copy `.dev.vars.example` to `.dev.vars` and paste the key
there. `.dev.vars` is git-ignored.

Rotating: run the same `secret put` with the new key; there is no need to redeploy.
