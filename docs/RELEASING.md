# Releasing MythScribe (F-15.7)

A release is a git tag. `.github/workflows/release.yml` builds Windows, macOS, and Linux, signs
Windows and macOS, uploads everything into one draft GitHub release, and publishes the draft only
when every platform built and its signature verified. The published release is the update feed:
installed apps read it through `electron-updater` (`src/main/updates/updateService.ts`).

A release is never published unsigned. If a secret is missing or a signature does not verify, the
workflow stops and leaves the draft unpublished; delete the draft and the tag, fix, and tag again.

## One-time setup

### Windows: Azure Trusted Signing

1. In the Azure portal create a **Trusted Signing account** and, inside it, complete **identity
   validation** (individual or organization; this is the slow step, allow days) and create a
   **certificate profile** of type Public Trust.
2. Create an **app registration** (Microsoft Entra ID), add a client secret, and give the app the
   role **Trusted Signing Certificate Profile Signer** on the signing account.
3. In the GitHub repository settings add
   - secrets: `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`
   - variables: `WIN_PUBLISHER_NAME` (the certificate's subject common name, exactly),
     `AZURE_SIGNING_ENDPOINT` (for example `https://eus.codesigning.azure.net`),
     `AZURE_CERTIFICATE_PROFILE`, `AZURE_SIGNING_ACCOUNT`.

The publisher name is written into the installed app, and the updater refuses an update whose
signature names a different publisher. Changing it later strands installed copies on their version.

### macOS: Developer ID and notarization

1. Join the Apple Developer Program. Create a **Developer ID Application** certificate, export it
   with its private key as a `.p12`, and base64-encode it.
2. In App Store Connect create an **API key** (Users and Access → Integrations) with the Developer
   role; download the `.p8` once and base64-encode it.
3. Add the secrets `MAC_CSC_LINK` (the base64 `.p12`), `MAC_CSC_KEY_PASSWORD`,
   `APPLE_API_KEY_BASE64`, `APPLE_API_KEY_ID`, `APPLE_API_ISSUER`.

Until the Apple account exists, remove the `macos` entry from the workflow's matrix rather than
shipping an unsigned Mac build: the updater cannot update an unsigned Mac app at all.

### Linux

The AppImage is unsigned and updates itself. Other Linux packages are not built.

## Cutting a release

1. Set `version` in `package.json`: `0.2.0` for stable, `0.2.0-beta.1` for beta. Run the gates.
2. Write `docs/release-notes/v<version>.md`. This is what authors read inside the app (Settings →
   Updates, shown as plain text: short paragraphs and `-` bullet lines work; links, images, and
   tables do not). Write for authors, not developers. The workflow refuses a tag without it.
3. Commit, then `git tag v<version>` and `git push origin main v<version>`.
4. Watch the Release workflow. When it finishes, the release is public and installed apps find it
   within six hours, or at once through Help → Check for updates.

## Channels

- **Stable** reads `latest.yml` from the newest full release. **Beta** reads the newest release
  including pre-releases, so beta users also receive every stable release.
- A beta tag (`-beta.N`) is published as a GitHub pre-release; stable users never see it.
- There is no downgrade. An author who switches from Beta back to Stable keeps the installed beta
  until a newer stable version ships.

## Local builds

`npm run build:win`, `build:mac`, and `build:linux` still produce unsigned development builds in
`dist/` and never publish. An unpackaged or development build reports updates as unavailable.

## After the first release

Point the website's download buttons (`site/public/index.html`) at the release assets and drop the
pre-release copy, then `npm run site:deploy`.
