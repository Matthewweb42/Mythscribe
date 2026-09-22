/**
 * The Supporter license (F-15.9): one route, `GET /license`, that hands a signed token to an
 * account which bought the one-time Supporter product. The token is the whole mechanism — the app
 * verifies it against the public key it ships with, caches it, and trusts it until `exp` — so the
 * cosmetic extras keep working offline and nothing in the app blocks on this route.
 *
 * The Worker keeps no token of its own: the license is a row the billing webhook wrote
 * (`grantSupporter` / `revokeSupporter`, driven from `credits.ts`), and every call mints a fresh
 * token from it. A refund therefore takes effect on the app's next refresh, and at the latest when
 * the cached token's grace period runs out.
 *
 * The claims, the token format, and the grace period are shared with the app in
 * `src/shared/license.ts`; the private half of the key exists only as the `LICENSE_SIGNING_KEY`
 * secret and never leaves the Worker.
 */
import { z } from 'zod'
import type { CreditPack, LicenseResult } from '../../src/shared/cloudApi'
import {
  encodeLicensePayload,
  formatLicenseToken,
  LICENSE_GRACE_MS,
  type LicenseClaims
} from '../../src/shared/license'
import { type AuthDeps, authenticate, jsonError, jsonResponse, UNAUTHORIZED_MESSAGE } from './auth'
import type { ConfiguredPack } from './credits'
import { signEd25519 } from './crypto'

/**
 * The `LICENSE_SIGNING_KEY` secret: the private half of the Ed25519 pair printed by
 * `npm run cloud:license-keygen`, as JSON. Validated like the pack config, so a mistyped secret is
 * a logged 503 on this one route rather than a 500 anywhere.
 */
export const LicenseSigningJwk = z.object({
  kty: z.literal('OKP'),
  crv: z.literal('Ed25519'),
  d: z.string().min(1),
  x: z.string().min(1)
})
export type LicenseSigningJwk = z.infer<typeof LicenseSigningJwk>

/**
 * How the route reaches the signing key. A function rather than the `CryptoKey` itself, because
 * the dependencies are built synchronously per request while importing a key is asynchronous:
 * nothing is imported until a license actually has to be signed.
 */
export type LicenseSigner = () => Promise<CryptoKey>

export interface LicenseDeps extends AuthDeps {
  /** F-15.9: the Supporter product on sale; null until the operator configures it. */
  supporter: ConfiguredPack | null
  /** Built from `LICENSE_SIGNING_KEY`; absent → a licensed account gets 503 NOT_CONFIGURED. */
  signingKey: LicenseSigner | null
}

const NOT_CONFIGURED = 'The Supporter license is not configured on the server yet.'

/**
 * `GET /license`: the account's Supporter token, or `null` when it has none, plus the product to
 * offer. A revoked license answers exactly like no license — the app clears its cache either way.
 *
 * The missing signing key is a 503 only for an account that has a license: everyone else gets a
 * plain `{ token: null }`, so an unconfigured Worker looks the same as an unlicensed account.
 */
export async function handleLicense(request: Request, deps: LicenseDeps): Promise<Response> {
  const caller = await authenticate(request, deps)
  if (!caller) return jsonError('UNAUTHORIZED', UNAUTHORIZED_MESSAGE)

  // The checkout URL stays on the Worker, as in `GET /credits`: the app only names a variant.
  const product: CreditPack | null = deps.supporter
    ? { variantId: deps.supporter.variantId, priceCents: deps.supporter.priceCents }
    : null

  // No license, or one a refund revoked: the app hears the same thing and clears its cache.
  const license = await deps.store.findSupporter(caller.user.id)
  if (license?.revokedAt !== null) {
    return jsonResponse({ token: null, product } satisfies LicenseResult)
  }

  const signer = deps.signingKey
  if (!signer) return jsonError('NOT_CONFIGURED', NOT_CONFIGURED)

  const iat = deps.now().getTime()
  const claims: LicenseClaims = { v: 1, sub: caller.user.id, iat, exp: iat + LICENSE_GRACE_MS }
  const payload = encodeLicensePayload(claims)
  let signature: Uint8Array
  try {
    signature = await signEd25519(await signer(), payload)
  } catch (error) {
    // The secret parsed but is not usable key material; only the operator can fix it.
    console.error('LICENSE_SIGNING_KEY could not sign a Supporter token', error)
    return jsonError('NOT_CONFIGURED', NOT_CONFIGURED)
  }
  const token = formatLicenseToken(payload, signature)
  return jsonResponse({ token, product } satisfies LicenseResult)
}
