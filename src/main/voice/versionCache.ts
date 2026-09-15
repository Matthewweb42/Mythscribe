/**
 * The voice profile's invalidation counter (F-14.1). The exemplar store bumps it after every
 * write and `document:save` after every save; `buildVoiceProfile` keeps a computed profile only
 * while the counter it was built under is current. It sits in its own module so the exemplar
 * store and the profile builder do not import each other. The ghost-text context hash carries
 * the counter too, so a stale local cache entry can never answer for a changed profile.
 */
let version = 0

export function bumpVoiceVersion(): void {
  version += 1
}

/** Called on every project change (open, create, close) so a profile never leaks across projects. */
export function resetVoiceProfileCache(): void {
  version += 1
}

export function currentVoiceVersion(): number {
  return version
}
