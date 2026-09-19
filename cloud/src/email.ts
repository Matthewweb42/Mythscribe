/**
 * Sending the sign-in email (F-15.2). Resend over plain HTTPS in production (no SDK); the `log`
 * transport prints the link for local runs. The mailer never sees anything but an address and a
 * one-time link.
 */

export interface MailMessage {
  to: string
  subject: string
  text: string
  html: string
}

export interface Mailer {
  send(message: MailMessage): Promise<void>
}

/** The verified Resend sender for mythscribe.app. */
export const MAIL_FROM = 'MythScribe <sign-in@mythscribe.app>'

const SUBJECT = 'Your MythScribe sign-in link'

/** The one sign-in email: the link, how long it lasts, and what to do if it was not requested. */
export function signInEmail(to: string, link: string): MailMessage {
  const text = [
    'Open this link to sign in to MythScribe:',
    '',
    link,
    '',
    'The link works for 15 minutes and can be used once.',
    'If you did not ask to sign in, ignore this email; nothing happens.'
  ].join('\n')
  const html = [
    '<p>Open this link to sign in to MythScribe:</p>',
    `<p><a href="${link}">Sign in to MythScribe</a></p>`,
    '<p>The link works for 15 minutes and can be used once.</p>',
    '<p>If you did not ask to sign in, ignore this email; nothing happens.</p>'
  ].join('\n')
  return { to, subject: SUBJECT, text, html }
}

/** Production transport: POST the message to Resend; the key is a Worker secret. */
export function resendMailer(apiKey: string): Mailer {
  return {
    async send(message: MailMessage): Promise<void> {
      const response = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          from: MAIL_FROM,
          to: message.to,
          subject: message.subject,
          text: message.text,
          html: message.html
        })
      })
      // The body can quote the address back; keep the status only out of the logs.
      if (!response.ok)
        throw new Error(`Resend rejected the sign-in email (HTTP ${response.status})`)
    }
  }
}

/** Local transport (`EMAIL_TRANSPORT=log`): the link goes to the console and back to the app. */
export function logMailer(): Mailer {
  return {
    send(message: MailMessage): Promise<void> {
      console.warn(`[mail:log] to=${message.to} subject=${message.subject}\n${message.text}`)
      return Promise.resolve()
    }
  }
}
