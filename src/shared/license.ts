import { z } from 'zod'
import { CreditPack } from './cloudApi'

/**
 * The Supporter license (F-15.9): a one-time purchase that unlocks cosmetic extras for authors
 * who bring their own key. The Worker signs a short token for a licensed account; the app
 * verifies it against the public key embedded here, caches it, and refreshes it in the
 * background, so the extras work offline and nothing ever blocks on the network.
 *
 * Shared by the Worker (`cloud/src/license.ts`), main (`src/main/account/`), and the renderer.
 * Nothing here is secret: the private half of the key lives only in the Worker's
 * `LICENSE_SIGNING_KEY` secret.
 */

/** How long a token stays valid without the Worker confirming it again (PLAN.md §4.3). */
export const LICENSE_GRACE_DAYS = 14
export const LICENSE_GRACE_MS = LICENSE_GRACE_DAYS * 24 * 60 * 60_000
/** How often a signed-in app asks the Worker for a fresh token; a failure is silent. */
export const LICENSE_REFRESH_INTERVAL_MS = 24 * 60 * 60_000

/**
 * The public half of the Worker's Ed25519 signing key, as a JWK. Replaced by the operator's
 * key after `npm run cloud:license-keygen` (the recipe is in `cloud/README.md`);
 * `MYTHSCRIBE_LICENSE_PUBLIC_KEY` (a JSON JWK) overrides it for dev and e2e. The placeholder
 * verifies nothing, so an app built without a real key simply never shows the extras.
 */
export const LICENSE_PUBLIC_KEY_JWK: LicensePublicKeyJwk = {
  kty: 'OKP',
  crv: 'Ed25519',
  x: 'REPLACE_WITH_THE_OPERATOR_PUBLIC_KEY_FROM_cloud_license-keygen'
}

/** An Ed25519 public key in JWK form, the only shape the verifier accepts. */
export const LicensePublicKeyJwk = z.object({
  kty: z.literal('OKP'),
  crv: z.literal('Ed25519'),
  x: z.string().min(1)
})
export type LicensePublicKeyJwk = z.infer<typeof LicensePublicKeyJwk>

/** The public key to verify with: the env override when set and readable, else the embedded one. */
export function licensePublicKey(env: Record<string, string | undefined>): LicensePublicKeyJwk {
  const raw = env.MYTHSCRIBE_LICENSE_PUBLIC_KEY?.trim()
  if (raw === undefined || raw === '') return LICENSE_PUBLIC_KEY_JWK
  try {
    const parsed = LicensePublicKeyJwk.safeParse(JSON.parse(raw))
    if (parsed.success) return parsed.data
  } catch {
    // Fall through: an unreadable override is treated as absent.
  }
  return LICENSE_PUBLIC_KEY_JWK
}

/**
 * What the Worker signs. Epoch milliseconds; `exp` is `iat + LICENSE_GRACE_MS`, so a token that
 * was refreshed yesterday is good for thirteen more days without the network.
 */
export const LicenseClaims = z.object({
  v: z.literal(1),
  /** The account's user id; the app checks it matches the signed-in account. */
  sub: z.string().min(1),
  iat: z.number().int().nonnegative(),
  exp: z.number().int().nonnegative()
})
export type LicenseClaims = z.infer<typeof LicenseClaims>

/** The token on the wire and on disk: `base64url(JSON claims) + '.' + base64url(signature)`. */
export interface ParsedLicenseToken {
  claims: LicenseClaims
  /** The exact bytes the signature covers (the first segment, decoded). */
  payload: Uint8Array
  signature: Uint8Array
}

const BASE64URL = /^[A-Za-z0-9_-]+$/

/** URL-safe base64 without padding; plain JS so the Worker, main, and tests share it. */
export function base64urlEncode(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function base64urlDecode(text: string): Uint8Array | null {
  if (text === '' || !BASE64URL.test(text)) return null
  const padded = text.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (text.length % 4)) % 4)
  try {
    const binary = atob(padded)
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
    return bytes
  } catch {
    return null
  }
}

/** The first segment of a token for these claims; the Worker signs exactly these bytes. */
export function encodeLicensePayload(claims: LicenseClaims): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(claims))
}

export function formatLicenseToken(payload: Uint8Array, signature: Uint8Array): string {
  return `${base64urlEncode(payload)}.${base64urlEncode(signature)}`
}

/**
 * Splits and decodes a token without verifying it. Null for anything that is not two base64url
 * segments whose first decodes to well-formed claims; the signature check is the verifier's job.
 */
export function parseLicenseToken(token: string): ParsedLicenseToken | null {
  const [first, second, ...rest] = token.split('.')
  if (first === undefined || second === undefined || rest.length > 0) return null
  const payload = base64urlDecode(first)
  const signature = base64urlDecode(second)
  if (payload === null || signature === null) return null
  let json: unknown
  try {
    json = JSON.parse(new TextDecoder().decode(payload))
  } catch {
    return null
  }
  const claims = LicenseClaims.safeParse(json)
  if (!claims.success) return null
  return { claims: claims.data, payload, signature }
}

/**
 * The cosmetic extras (decided 2026-09-21): an accent colour for the whole UI. `default` is the
 * green every install has; the rest need the license. F-7.8 (themes) gates on the same flag.
 */
export const ACCENT_IDS = ['default', 'ember', 'sky', 'rose', 'gold', 'violet'] as const
export const AccentId = z.enum(ACCENT_IDS)
export type AccentId = z.infer<typeof AccentId>

export interface AccentPreset {
  id: AccentId
  label: string
  /** `--ms-accent`, `--ms-accent-hover`, `--ms-accent-fg`; the default's values live in tokens.css. */
  accent: string
  hover: string
  fg: string
}

export const ACCENTS: readonly AccentPreset[] = [
  { id: 'default', label: 'Moss', accent: '#6cc38f', hover: '#83d1a3', fg: '#0f1a13' },
  { id: 'ember', label: 'Ember', accent: '#f0885a', hover: '#f5a27e', fg: '#1f110b' },
  { id: 'sky', label: 'Sky', accent: '#6db3f2', hover: '#8cc4f6', fg: '#0b1620' },
  { id: 'rose', label: 'Rose', accent: '#e88aa8', hover: '#efa7be', fg: '#20101a' },
  { id: 'gold', label: 'Gold', accent: '#e2b84a', hover: '#ead07a', fg: '#1f1908' },
  { id: 'violet', label: 'Violet', accent: '#a78bfa', hover: '#bda8fb', fg: '#15102a' }
]

/** What the app keeps in app-state.json: the last verified token and the chosen accent. */
export const SupporterSettings = z.object({
  /** The Worker's token, verified before it is stored; null when there is no license. */
  token: z.string().nullable(),
  /** Epoch ms of the last refresh that reached the Worker, so `offline` can be reported. */
  refreshedAt: z.number().int().nullable(),
  accent: AccentId
})
export type SupporterSettings = z.infer<typeof SupporterSettings>

export const defaultSupporterSettings = (): SupporterSettings => ({
  token: null,
  refreshedAt: null,
  accent: 'default'
})

/**
 * The license as the renderer sees it (F-15.9). `licensed` is what gates the extras; the rest
 * is for the Account tab. The token itself never crosses IPC.
 */
export const SupporterStatus = z.object({
  licensed: z.boolean(),
  /** ISO timestamp of the token's `iat`: when the Worker last confirmed the license; null when none. */
  since: z.string().nullable(),
  /** ISO timestamp of the token's `exp`: the extras stay on until then without the Worker. */
  validUntil: z.string().nullable(),
  /** The last refresh did not reach the Worker (or none has run yet) and the token is being trusted from the cache. */
  offline: z.boolean(),
  /** The product on sale, for the Buy button; null until the operator configures it, or when licensed. */
  product: CreditPack.nullable(),
  /** The chosen accent; always `default` when not licensed. */
  accent: AccentId
})
export type SupporterStatus = z.infer<typeof SupporterStatus>
