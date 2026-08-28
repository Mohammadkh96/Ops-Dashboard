import { Injectable } from '@nestjs/common';

import { gmailMode } from '../common/gmail';
import { mailProvider } from '../common/mailer';
import { PrismaService } from '../prisma/prisma.service';

/**
 * What this dashboard is actually wired up to.
 *
 * The screen this feeds used to be a mock-up. It listed three API keys with
 * plausible-looking tokens and reported "Stripe — connected — sk_live_••••4821"
 * and "MT5 Manager API — connected" on a deployment connected to neither. On an
 * admin screen that is not a placeholder, it is a false statement: somebody
 * reading it would believe reconciliation was running against Stripe.
 *
 * So this reports the truth and nothing else.
 *
 * NO SECRETS LEAVE HERE, not even masked ones. A mask is a promise about a
 * value the reader cannot check, and the last four characters of a live key are
 * enough to confirm a guess. What is reported is whether something is
 * configured, when it last worked, and what to set if it is not — which is
 * everything the question "is the desk wired up?" actually needs.
 *
 * CREDENTIALS ARE NOT EDITABLE HERE, deliberately. They live in the host's
 * environment, which is where a deployment platform can hold them encrypted and
 * out of the database. A form that wrote provider keys into a table would move
 * live payment credentials into the blast radius of every SQL injection and
 * every backup, to save a redeploy.
 */

export type IntegrationState = {
  key: string;
  name: string;
  what: string;
  /** Configured, working, or not set up. */
  status: 'ok' | 'degraded' | 'off';
  detail: string;
  /** The environment variables that switch it on, for one that is off. */
  needs?: string[];
};

@Injectable()
export class IntegrationsService {
  constructor(private readonly prisma: PrismaService) {}

  async list(): Promise<IntegrationState[]> {
    return [
      await this.paymaxis(),
      this.webhook(),
      this.googleSignIn(),
      this.mail(),
      await this.database(),
    ];
  }

  /** The one that matters: the payment data the whole dashboard is about. */
  private async paymaxis(): Promise<IntegrationState> {
    const shops = (process.env.PAYMAXIS_SHOPS ?? '').trim();
    const shopIds = shops.startsWith('[')
      ? safeJsonShopIds(shops)
      : shops
          .split(',')
          .map((p) => p.split(':')[0]?.trim())
          .filter(Boolean);

    if (!shopIds.length) {
      return {
        key: 'paymaxis',
        name: 'Paymaxis',
        what: 'The payment data every figure on this dashboard is read from.',
        status: 'off',
        detail:
          'No shops configured. Imported history still reads, but nothing new arrives.',
        needs: ['PAYMAXIS_SHOPS'],
      };
    }

    const marks: { key: string; since: string }[] =
      await this.prisma.pollWatermark
        .findMany({
          // The same keys the poller writes — see paymaxis.service.ts. Reading
          // invented ones here would report "no successful pull recorded yet"
          // forever on a perfectly healthy deployment.
          where: {
            key: {
              in: ['paymaxis:lastRun', 'paymaxis:lastOk', 'paymaxis:lastError'],
            },
          },
          select: { key: true, since: true },
        })
        .catch(() => []);
    const at = new Map(marks.map((m) => [m.key, m.since] as const));
    const lastOk = at.get('paymaxis:lastOk');
    const error = at.get('paymaxis:lastError');
    const polling = process.env.PAYMAXIS_POLL_ENABLED === '1';

    // Shop IDS, not keys. An id identifies which account a figure came from and
    // is on every invoice already; the key beside it is the credential.
    const which = `Shop${shopIds.length === 1 ? '' : 's'} ${shopIds.join(', ')}`;

    if (error) {
      return {
        key: 'paymaxis',
        name: 'Paymaxis',
        what: 'The payment data every figure on this dashboard is read from.',
        status: 'degraded',
        detail: `${which}. The last pull failed: ${trim(error, 240)}`,
      };
    }
    if (!polling) {
      return {
        key: 'paymaxis',
        name: 'Paymaxis',
        what: 'The payment data every figure on this dashboard is read from.',
        status: 'degraded',
        detail: `${which} are configured, but polling is switched off — new payments only arrive by webhook or import.`,
        needs: ['PAYMAXIS_POLL_ENABLED=1'],
      };
    }
    return {
      key: 'paymaxis',
      name: 'Paymaxis',
      what: 'The payment data every figure on this dashboard is read from.',
      status: 'ok',
      detail: lastOk
        ? `${which}. Last successful pull ${ago(lastOk)}.`
        : `${which}. Configured, but no successful pull recorded yet.`,
    };
  }

  /**
   * The webhook is reported, never configured from here.
   *
   * Its URL is registered inside Paymaxis and points at the CRM as well as at
   * this API. Repointing it from a dashboard button is how somebody stops
   * payments reaching the system that actually books them, so this says whether
   * the signature can be verified and stops there.
   */
  private webhook(): IntegrationState {
    const configured = Boolean(
      (process.env.PAYMAXIS_SIGNING_KEYS ?? '').trim() ||
      (process.env.PAYMAXIS_SIGNING_KEY ?? '').trim(),
    );
    return {
      key: 'webhook',
      name: 'Paymaxis webhook',
      what: 'Payment updates pushed to this API as they happen.',
      status: configured ? 'ok' : 'degraded',
      detail: configured
        ? 'A signing key is set, so pushed updates are verified before they are trusted.'
        : 'No signing key set. Updates cannot be verified, so they are refused — polling and import still work.',
      ...(configured ? {} : { needs: ['PAYMAXIS_SIGNING_KEYS'] }),
    };
  }

  private googleSignIn(): IntegrationState {
    const configured = Boolean(
      process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET,
    );
    const domains = (process.env.GOOGLE_ALLOWED_DOMAINS ?? '')
      .split(',')
      .map((d) => d.trim())
      .filter(Boolean);

    if (!configured) {
      return {
        key: 'google',
        name: 'Google sign-in',
        what: 'Signing in with a company Google account.',
        status: 'off',
        detail: 'Not set up — the login page shows the password form only.',
        needs: [
          'GOOGLE_CLIENT_ID',
          'GOOGLE_CLIENT_SECRET',
          'GOOGLE_ALLOWED_DOMAINS',
        ],
      };
    }
    if (!domains.length) {
      // The half-configuration that refuses everybody, and looks like a bug
      // rather than a setting.
      return {
        key: 'google',
        name: 'Google sign-in',
        what: 'Signing in with a company Google account.',
        status: 'degraded',
        detail:
          'Half configured: no allowed domains, so every Google sign-in is refused.',
        needs: ['GOOGLE_ALLOWED_DOMAINS'],
      };
    }
    return {
      key: 'google',
      name: 'Google sign-in',
      what: 'Signing in with a company Google account.',
      status: 'ok',
      detail: `Accounts at ${domains.join(' and ')} can sign in. New ones start at ${
        process.env.GOOGLE_DEFAULT_ROLE ?? 'READ_ONLY'
      }.`,
    };
  }

  private mail(): IntegrationState {
    const provider = mailProvider();
    if (provider === 'none') {
      return {
        key: 'mail',
        name: 'Handover email',
        what: 'The shift handover, sent when a shift closes.',
        status: 'off',
        detail:
          'No provider configured. Handovers are still recorded and readable here — they are simply not emailed.',
        needs: ['GMAIL_REFRESH_TOKEN', 'or RESEND_API_KEY'],
      };
    }
    if (provider === 'gmail') {
      const how =
        gmailMode() === 'refresh-token'
          ? 'a mailbox that granted consent'
          : 'a service account with domain-wide delegation';
      return {
        key: 'mail',
        name: 'Handover email',
        what: 'The shift handover, sent when a shift closes.',
        status: 'ok',
        detail: `Sent from ${process.env.GMAIL_SENDER ?? 'the configured mailbox'} through Gmail, via ${how}.`,
      };
    }
    return {
      key: 'mail',
      name: 'Handover email',
      what: 'The shift handover, sent when a shift closes.',
      status: 'ok',
      detail: `Sent through ${provider === 'resend' ? 'Resend' : 'SendGrid'} as ${
        process.env.MAIL_FROM ?? '(no MAIL_FROM set)'
      }.`,
    };
  }

  private async database(): Promise<IntegrationState> {
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      // PaymentEvent, not "payment": every state a payment has passed through
      // is a row, and that table is the one every figure on this dashboard is
      // computed from.
      const events = await this.prisma.paymentEvent.count();
      return {
        key: 'database',
        name: 'Database',
        what: 'Where every payment, shift and incident is kept.',
        status: 'ok',
        detail: `Reachable, holding ${events.toLocaleString()} payment records.`,
      };
    } catch (e) {
      return {
        key: 'database',
        name: 'Database',
        what: 'Where every payment, shift and incident is kept.',
        status: 'degraded',
        detail: e instanceof Error ? e.message.slice(0, 200) : String(e),
      };
    }
  }
}

function safeJsonShopIds(raw: string): string[] {
  try {
    // Narrowed to a primitive before String(): a shopId that arrived as an
    // object would otherwise render as "[object Object]" in the one field this
    // screen exists to state precisely.
    return (JSON.parse(raw) as { shopId?: unknown }[])
      .map((s) =>
        typeof s?.shopId === 'string' || typeof s?.shopId === 'number'
          ? String(s.shopId)
          : '',
      )
      .filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Long provider errors, cut at a word.
 *
 * A hard slice ends them mid-word ("…Add t"), which reads as a rendering bug
 * and hides whether there was more to say. These messages routinely name the
 * setting to change in their last few words.
 */
function trim(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const space = cut.lastIndexOf(' ');
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/** A timestamp as "4m ago". */
function ago(iso: string): string {
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms)) return 'at an unknown time';
  const mins = Math.round(ms / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}
