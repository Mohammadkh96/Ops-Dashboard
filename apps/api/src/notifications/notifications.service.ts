import { Injectable, Logger } from '@nestjs/common';

import { sendMail } from '../common/mailer';
import type { Detection } from '../modules/incident-detect';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Telling the desk that something happened, once.
 *
 * THE HARD PART IS NOT SENDING, IT IS NOT SENDING AGAIN. The detectors run on
 * every cron and every time somebody has the dashboard open, and a PSP that has
 * been failing since Tuesday is one thing that happened — not four hundred. An
 * alerting layer that mails on every pass is one the desk filters into a folder
 * within a week, which is worse than no alerting at all because everybody
 * believes it is working.
 *
 * So a condition still true updates the notification it already has, and only
 * one nobody has been told about within the cool-off makes a new one and sends
 * mail. Same signatures the incident screen uses, so "declared as an incident"
 * and "notified about" are the same event seen twice rather than two events.
 *
 * WHAT GETS AN EMAIL IS NARROWER THAN WHAT GETS A ROW. Everything lands in the
 * feed; only critical and high leave the building. A medium-severity condition
 * that emails a whole desk at 03:00 is how people learn to ignore the ones that
 * matter — and the floor is an environment variable because where it belongs is
 * a business decision, not a technical one.
 */
@Injectable()
export class NotificationsService {
  private readonly log = new Logger(NotificationsService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * How long a condition stays "already reported".
   *
   * Twelve hours: long enough that a day-long outage is one email rather than
   * a stream, short enough that something still broken tomorrow morning says so
   * to whoever came on shift overnight.
   */
  private coolOffMs(): number {
    const hours = Number(process.env.NOTIFY_COOLOFF_HOURS ?? 12);
    return (Number.isFinite(hours) && hours > 0 ? hours : 12) * 3_600_000;
  }

  /** Which severities are worth an email. The rest go to the feed only. */
  private mailFloor(): string[] {
    const raw = (process.env.NOTIFY_EMAIL_SEVERITY ?? 'critical,high')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
    return raw.length ? raw : ['critical', 'high'];
  }

  /**
   * Record what is true now, and mail what is new.
   *
   * Takes the detections rather than fetching them: the caller already has
   * them for the screen it is drawing, and asking twice would mean the feed
   * could disagree with the incident list it is meant to mirror.
   *
   * NEVER THROWS. It runs inside a cron that has already done the useful work
   * and inside a page load; a mailer outage must not lose a sync or blank a
   * dashboard.
   */
  async record(
    detections: Detection[],
    recipients: string[],
  ): Promise<{
    considered: number;
    created: number;
    refreshed: number;
    emailed: number;
    emailError: string | null;
  }> {
    const now = new Date();
    const since = new Date(now.getTime() - this.coolOffMs());
    const floor = this.mailFloor();
    let created = 0;
    let refreshed = 0;
    let emailed = 0;
    let emailError: string | null = null;

    for (const d of detections) {
      try {
        const recent = await this.prisma.notification.findFirst({
          where: { signature: d.signature, lastSeenAt: { gte: since } },
          orderBy: { lastSeenAt: 'desc' },
        });
        if (recent) {
          // Still true, already told. Move the clock, say nothing.
          await this.prisma.notification.update({
            where: { id: recent.id },
            data: { lastSeenAt: now },
          });
          refreshed++;
          continue;
        }

        const row = await this.prisma.notification.create({
          data: {
            signature: d.signature,
            kind: d.kind,
            severity: d.severity,
            title: d.title,
            body: [d.impact, ...d.evidence].filter(Boolean),
            source: d.kind.startsWith('kyc-') ? 'kyc' : 'payments',
          },
        });
        created++;

        if (!floor.includes(d.severity) || !recipients.length) continue;

        const result = await sendMail({
          to: recipients,
          subject: `[${d.severity.toUpperCase()}] ${d.title}`,
          html: this.html(d),
        });
        await this.prisma.notification.update({
          where: { id: row.id },
          data: {
            emailedAt: result.sent ? now : null,
            emailTo: result.to,
            // The unconfigured case is a reason, not a silence: a dashboard
            // that says it notified and did not is worse than one that cannot.
            emailError: result.sent ? null : (result.reason ?? 'not sent'),
          },
        });
        if (result.sent) emailed++;
        else emailError ??= result.reason ?? 'not sent';
      } catch (e) {
        // One bad detection must not cost the others their notification.
        this.log.warn(
          `Notification for ${d.signature} failed: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }

    return {
      considered: detections.length,
      created,
      refreshed,
      emailed,
      emailError,
    };
  }

  /** The feed, newest first. Unread only when asked. */
  async list(opts: { unread?: boolean; limit?: number } = {}) {
    const rows = await this.prisma.notification.findMany({
      where: opts.unread ? { readAt: null } : {},
      orderBy: { lastSeenAt: 'desc' },
      take: Math.min(Math.max(opts.limit ?? 50, 1), 200),
    });
    const unread = await this.prisma.notification.count({
      where: { readAt: null },
    });
    return {
      unread,
      notifications: rows.map((n) => ({
        id: n.id,
        signature: n.signature,
        kind: n.kind,
        severity: n.severity,
        title: n.title,
        body: n.body,
        source: n.source,
        createdAt: n.createdAt.toISOString(),
        /** Still true as of this moment — not when it was first raised. */
        lastSeenAt: n.lastSeenAt.toISOString(),
        emailed: Boolean(n.emailedAt),
        /**
         * Shown on the row rather than logged away.
         *
         * "The mailer is not configured" is something the desk has to know
         * about their own alerting, and a notification that quietly never
         * leaves the building is exactly the failure this whole layer exists
         * to avoid.
         */
        emailError: n.emailError,
        readAt: n.readAt?.toISOString() ?? null,
      })),
    };
  }

  async markRead(ids: string[], by: string) {
    if (!ids.length) return { read: 0 };
    const r = await this.prisma.notification.updateMany({
      where: { id: { in: ids }, readAt: null },
      data: { readAt: new Date(), readBy: by },
    });
    return { read: r.count };
  }

  async markAllRead(by: string) {
    const r = await this.prisma.notification.updateMany({
      where: { readAt: null },
      data: { readAt: new Date(), readBy: by },
    });
    return { read: r.count };
  }

  /**
   * The email body.
   *
   * Deliberately plain: an alert is read on a phone at three in the morning,
   * and the only things that matter are what broke, what it means, and the
   * evidence in the order somebody would check it.
   */
  private html(d: Detection): string {
    const esc = (s: string) =>
      s.replace(/[<>&]/g, (c) =>
        c === '<' ? '&lt;' : c === '>' ? '&gt;' : '&amp;',
      );
    return [
      `<h2 style="margin:0 0 8px;font:600 16px system-ui">${esc(d.title)}</h2>`,
      `<p style="margin:0 0 12px;font:14px system-ui;color:#444">${esc(d.impact)}</p>`,
      '<ul style="margin:0 0 12px;padding-left:18px;font:13px system-ui;color:#444">',
      ...d.evidence.map((e) => `<li>${esc(e)}</li>`),
      '</ul>',
      `<p style="margin:0;font:12px system-ui;color:#888">Raised automatically by OpsOS · ${esc(d.signature)}</p>`,
    ].join('');
  }
}
