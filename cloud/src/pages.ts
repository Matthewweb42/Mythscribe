/**
 * The two HTML pages the browser sees after clicking a sign-in link (F-15.2). No scripts, no
 * external assets, no token on the page: the desktop app collects the session by polling.
 */

/** Matches the pages below: inline styles only, nothing else may load. */
const PAGE_CSP = "default-src 'none'; style-src 'unsafe-inline'"

function page(title: string, heading: string, body: string): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${title}</title>
    <style>
      body {
        margin: 0;
        min-height: 100vh;
        display: flex;
        align-items: center;
        justify-content: center;
        background: #14121a;
        color: #efeaf7;
        font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, sans-serif;
      }
      main { max-width: 26rem; padding: 2rem; text-align: center; }
      h1 { font-size: 1.5rem; margin: 0 0 0.75rem; }
      p { margin: 0 0 0.5rem; line-height: 1.6; color: #c9c1db; }
    </style>
  </head>
  <body>
    <main>
      <h1>${heading}</h1>
      ${body}
    </main>
  </body>
</html>
`
}

export const SIGNED_IN_PAGE = page(
  'Signed in — MythScribe',
  "You're signed in.",
  '<p>Return to MythScribe; the app signs itself in within a few seconds.</p>\n      <p>You can close this tab.</p>'
)

export const LINK_EXPIRED_PAGE = page(
  'Link expired — MythScribe',
  'This link has expired.',
  '<p>Sign-in links work once and for 15 minutes.</p>\n      <p>Open MythScribe, go to Settings &rarr; Account, and send yourself a new one.</p>'
)

/** An HTML page response with the page content-security policy; `no-store` is added by the router. */
export function pageResponse(html: string, status: number): Response {
  return new Response(html, {
    status,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': PAGE_CSP
    }
  })
}
