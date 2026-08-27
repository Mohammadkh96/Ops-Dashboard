/**
 * Sending an email from a serverless function.
 *
 * Over HTTP, not SMTP. A serverless function gets a few seconds and no
 * long-lived socket, and every managed host blocks outbound port 25 anyway —
 * an SMTP client here would work on a laptop and fail silently in production,
 * which is the worst of both.
 *
 * Three providers, chosen by what is configured, and a fourth state that
 * matters as much as any of them: NOT CONFIGURED. A dashboard that quietly does
 * nothing when it says it sent a handover is worse than one that cannot send
 * at all, so an unconfigured mailer says so in the result and the caller shows
 * it. The handover is still recorded and still readable in the app either way
 * — the email is a delivery mechanism, not the record.
 *
 * GMAIL FIRST, when it is set up. The desk already signs in with company Google
 * accounts, so the handover going out from ops@yourcompany.com is both the
 * address people recognise and one that does not have to earn a sending
 * reputation from scratch — a first send from a vendor domain lands in spam.
 * The sent copy is also in the mailbox's Sent folder, which is where somebody
 * looks when they ask whether it went.
 */

import { gmailMode, sendViaGmail } from './gmail';

export type MailResult = {
  sent: boolean;
  provider: 'gmail' | 'resend' | 'sendgrid' | 'none';
  to: string[];
  /** Why it did not send, in words a person can act on. */
  reason?: string;
};

export type Mail = {
  to: string[];
  subject: string;
  html: string;
};

const FROM = process.env.MAIL_FROM ?? 'OpsOS <onboarding@resend.dev>';

function provider(): MailResult['provider'] {
  if (gmailMode()) return 'gmail';
  if (process.env.RESEND_API_KEY) return 'resend';
  if (process.env.SENDGRID_API_KEY) return 'sendgrid';
  return 'none';
}

export function mailerConfigured(): boolean {
  return provider() !== 'none';
}

/**
 * Which provider a send would use right now.
 *
 * Reported by /health/connectivity, because the alternative way to find out is
 * to close a shift and see whether anybody got the handover.
 */
export function mailProvider(): MailResult['provider'] {
  return provider();
}

export async function sendMail(mail: Mail): Promise<MailResult> {
  const to = mail.to.filter((a) => a && a.includes('@'));
  const p = provider();

  if (!to.length) {
    return {
      sent: false,
      provider: p,
      to,
      reason:
        'Nobody to send to — no active user has an email address on their account.',
    };
  }
  if (p === 'none') {
    return {
      sent: false,
      provider: 'none',
      to,
      reason:
        'No mail provider configured. Either connect the company Gmail (GMAIL_REFRESH_TOKEN, via `node scripts/gmail-authorize.mjs`) or set RESEND_API_KEY / SENDGRID_API_KEY, plus MAIL_FROM. The handover is recorded either way and can be read in the dashboard.',
    };
  }

  // A hard timeout, because a hung provider must not take the shift-close
  // request down with it: the shift is already closed by this point, and
  // failing the request would tell the agent their handover had not been saved
  // when it had.
  const signal = AbortSignal.timeout(15_000);

  try {
    if (p === 'gmail') {
      // `to`, not `mail.to`: the addresses have already been filtered above and
      // an empty or malformed one in the header is refused by Gmail outright.
      const sent = await sendViaGmail({ ...mail, to });
      return sent.ok
        ? { sent: true, provider: p, to }
        : { sent: false, provider: p, to, reason: sent.reason };
    }

    if (p === 'resend') {
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${process.env.RESEND_API_KEY}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          from: FROM,
          to,
          subject: mail.subject,
          html: mail.html,
        }),
        signal,
      });
      if (!res.ok) {
        const body = await res.text();
        return {
          sent: false,
          provider: p,
          to,
          reason: `Resend refused it: HTTP ${res.status} ${body.slice(0, 200)}`,
        };
      }
      return { sent: true, provider: p, to };
    }

    const res = await fetch('https://api.sendgrid.com/v3/mail/send', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${process.env.SENDGRID_API_KEY}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        personalizations: [{ to: to.map((email) => ({ email })) }],
        from: { email: FROM.replace(/^.*<|>$/g, '') },
        subject: mail.subject,
        content: [{ type: 'text/html', value: mail.html }],
      }),
      signal,
    });
    if (!res.ok) {
      const body = await res.text();
      return {
        sent: false,
        provider: p,
        to,
        reason: `SendGrid refused it: HTTP ${res.status} ${body.slice(0, 200)}`,
      };
    }
    return { sent: true, provider: p, to };
  } catch (e) {
    return {
      sent: false,
      provider: p,
      to,
      reason: `Could not reach the mail provider: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}
