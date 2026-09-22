/**
 * F-15.9: generate the Supporter license signing key pair. `npm run cloud:license-keygen` prints
 * both halves of a fresh Ed25519 key:
 *
 *   - the private JWK, for `npx wrangler secret put LICENSE_SIGNING_KEY` (run from `cloud/`)
 *   - the public JWK, to paste into `LICENSE_PUBLIC_KEY_JWK` in `src/shared/license.ts`
 *
 * Run it once, before the first signed build. The private half must never be committed and never
 * leave the Worker secret; the public half is meant to be in the app. Rotating the key invalidates
 * every token in the wild: apps re-fetch one on their next refresh, so rotate only when the secret
 * has leaked, and ship the new public half in the same release.
 *
 * The recipe, in order, is in `cloud/README.md` under "Setting up the Supporter license".
 */
import { webcrypto } from 'node:crypto'
import process from 'node:process'

const pair = await webcrypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])
const privateJwk = await webcrypto.subtle.exportKey('jwk', pair.privateKey)
const publicJwk = await webcrypto.subtle.exportKey('jwk', pair.publicKey)

/** The Worker parses the secret with `LicenseSigningJwk`; the app with `LicensePublicKeyJwk`. */
const secret = { kty: privateJwk.kty, crv: privateJwk.crv, d: privateJwk.d, x: privateJwk.x }

process.stdout.write(
  [
    '',
    'LICENSE_SIGNING_KEY (private — paste into `npx wrangler secret put LICENSE_SIGNING_KEY`):',
    '',
    JSON.stringify(secret),
    '',
    'LICENSE_PUBLIC_KEY_JWK (public — replace the constant in src/shared/license.ts):',
    '',
    'export const LICENSE_PUBLIC_KEY_JWK: LicensePublicKeyJwk = {',
    `  kty: '${publicJwk.kty}',`,
    `  crv: '${publicJwk.crv}',`,
    `  x: '${publicJwk.x}'`,
    '}',
    '',
    'Keep the private half out of the repo and out of any log.',
    ''
  ].join('\n')
)
