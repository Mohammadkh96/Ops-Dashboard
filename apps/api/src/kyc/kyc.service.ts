import { BadRequestException, Injectable } from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service';

/**
 * Verifications from the KYC provider, and the client standing derived from
 * them.
 *
 * WHY AN IMPORT RATHER THAN AN API CALL.
 *
 * KYCAID reads back one record at a time and will not enumerate. Proven, not
 * assumed — `GET /applicants/{id}` answers in 237ms with the whole applicant,
 * while `/applicants`, `/verifications` and `/applicants/{id}/verifications`
 * all return `404 not_found`, and `/forms/{id}` returns the form's country-name
 * translations rather than its verifications. So the API is a reader with no
 * index: perfectly good once you know an applicant id, and useless for finding
 * out which ids exist.
 *
 * The index has to come from somewhere else, and the provider's own console
 * exports it. That is what this reads. Afterwards the by-id API can refresh any
 * client on demand, because by then we know their applicant id.
 *
 * THE JOIN. `external_applicant_id` is the CRM's own account reference —
 * `CU65081`, `CU447` — the same identifier carried by every payment in the
 * ledger. That is the whole reason this integration is worth having: it is the
 * first thing that connects a person to their money.
 */

/** What the export calls a decided verification. Their words, not ours. */
const SETTLED_OK = ['valid', 'approved', 'completed', 'verified', 'success'];
const SETTLED_BAD = ['invalid', 'declined', 'rejected', 'failed'];

/**
 * A row of the provider's export, once the columns have been read.
 *
 * Deliberately narrow. The export carries names, dates of birth, passport
 * numbers, tax ids, phone numbers and full addresses; none of that is needed to
 * know who is verified, and a KYC record should not travel further than the job
 * requires. The browser drops those columns before anything is sent, so they
 * never reach this process at all.
 */
export type VerificationRow = {
  verificationId: string;
  applicantId: string | null;
  externalApplicantId: string | null;
  status: string;
  at: Date | null;
  form: string | null;
  method: string | null;
  declineReasons: string[];
  priceEur: number | null;
  processingMin: number | null;
};

export type ImportResult = {
  read: number;
  created: number;
  updated: number;
  /** Rows with no verification id — nothing to key on, so nothing stored. */
  unusable: number;
  /**
   * Verifications the provider settled against no account of ours.
   *
   * Counted and kept, never dropped. An application abandoned before it reached
   * an account still cost money and still carries a decline reason.
   */
  unlinked: number;
  clientsCreated: number;
  clientsUpdated: number;
  /** Every distinct status seen, with a count. The vocabulary to map. */
  statuses: { status: string; rows: number }[];
  /** Every distinct form seen. One entity's checks differ from the other's. */
  forms: { form: string; rows: number }[];
};

const KYC_STATUS = [
  'NOT_STARTED',
  'PENDING',
  'IN_REVIEW',
  'APPROVED',
  'REJECTED',
  'EDD_REQUIRED',
] as const;
export type KycStatusName = (typeof KYC_STATUS)[number];

/**
 * The provider's word, mapped onto ours.
 *
 * A default, not a decision. The same vendor says "VALID" in its export and
 * "completed" in its callback, so anything hard-coded here is wrong for half
 * its own output — which is why the import reports every distinct status it
 * saw, and a mapping typed on the screen overrides this.
 */
export function defaultStatus(word: string | null): KycStatusName {
  const w = (word ?? '').trim().toLowerCase();
  if (!w) return 'PENDING';
  if (SETTLED_OK.includes(w)) return 'APPROVED';
  if (SETTLED_BAD.includes(w)) return 'REJECTED';
  if (w.includes('review') || w.includes('manual')) return 'IN_REVIEW';
  return 'PENDING';
}

function isStatusName(v: string): v is KycStatusName {
  return (KYC_STATUS as readonly string[]).includes(v);
}

@Injectable()
export class KycService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Loads an export, keyed on the provider's verification id.
   *
   * Re-importing the same file updates rather than duplicates, which matters
   * because the honest way to keep this current is to export again and re-run
   * it — and a compliance table that doubles every month is worse than one that
   * is a week stale.
   */
  async importVerifications(
    rows: VerificationRow[],
    opts: { provider?: string; mapping?: Record<string, string> } = {},
  ): Promise<ImportResult> {
    if (!rows.length) {
      throw new BadRequestException(
        'That file had no verifications in it. Export again from the provider and upload the file it produced.',
      );
    }
    const provider = opts.provider?.trim() || 'kycaid';

    // A mapping typed on screen wins over the default. Validated here rather
    // than trusted: a status name that is not one of ours would be written
    // straight into an enum column and fail at the database with a message
    // about a type, not about a mapping.
    const mapping = new Map<string, KycStatusName>();
    for (const [word, name] of Object.entries(opts.mapping ?? {})) {
      const clean = name.trim().toUpperCase();
      if (!isStatusName(clean)) {
        throw new BadRequestException(
          `"${name}" is not a status this dashboard has. Use one of: ${KYC_STATUS.join(', ')}.`,
        );
      }
      mapping.set(word.trim().toLowerCase(), clean);
    }
    const statusFor = (word: string | null) =>
      mapping.get((word ?? '').trim().toLowerCase()) ?? defaultStatus(word);

    const statuses = new Map<string, number>();
    const forms = new Map<string, number>();
    let created = 0;
    let updated = 0;
    let unusable = 0;
    let unlinked = 0;
    let clientsCreated = 0;
    let clientsUpdated = 0;

    // The clients this file mentions, resolved once rather than per row: an
    // applicant verified four times is four rows and one person.
    const references = [
      ...new Set(
        rows
          .map((r) => r.externalApplicantId?.trim())
          .filter((r): r is string => Boolean(r)),
      ),
    ];
    const clientIds = new Map<string, string>();
    for (const externalId of references) {
      const existing = await this.prisma.client.findUnique({
        where: { externalId },
        select: { id: true },
      });
      if (existing) {
        clientIds.set(externalId, existing.id);
        continue;
      }
      // Created from the reference alone. The name is deliberately NOT taken
      // from the export: this row exists to hang verifications and payments off
      // a single account id, and a KYC file is not the place a dashboard should
      // be learning people's names from.
      const made = await this.prisma.client.create({
        data: { externalId, fullName: externalId },
        select: { id: true },
      });
      clientIds.set(externalId, made.id);
      clientsCreated++;
    }

    for (const row of rows) {
      const word = row.status?.trim() ?? '';
      statuses.set(
        word || '(blank)',
        (statuses.get(word || '(blank)') ?? 0) + 1,
      );
      if (row.form) forms.set(row.form, (forms.get(row.form) ?? 0) + 1);

      if (!row.verificationId?.trim()) {
        unusable++;
        continue;
      }
      const externalId = row.externalApplicantId?.trim();
      const clientId = externalId ? (clientIds.get(externalId) ?? null) : null;
      if (!clientId) unlinked++;

      const data = {
        provider,
        clientId,
        applicantId: row.applicantId?.trim() || null,
        providerStatus: word || null,
        status: statusFor(word),
        form: row.form?.trim() || null,
        method: row.method?.trim() || null,
        declineReasons: row.declineReasons.filter(Boolean),
        priceEur: row.priceEur,
        processingMin: row.processingMin,
        submittedAt: row.at ?? new Date(),
        reviewedAt: row.at,
      };

      const existing = await this.prisma.kycCase.findUnique({
        where: {
          provider_verificationId: {
            provider,
            verificationId: row.verificationId.trim(),
          },
        },
        select: { id: true },
      });
      if (existing) {
        await this.prisma.kycCase.update({ where: { id: existing.id }, data });
        updated++;
      } else {
        await this.prisma.kycCase.create({
          data: { ...data, verificationId: row.verificationId.trim() },
        });
        created++;
      }
    }

    clientsUpdated = await this.refreshClientStatus([...clientIds.values()]);

    return {
      read: rows.length,
      created,
      updated,
      unusable,
      unlinked,
      clientsCreated,
      clientsUpdated,
      statuses: [...statuses.entries()]
        .map(([status, rows]) => ({ status, rows }))
        .sort((a, b) => b.rows - a.rows),
      forms: [...forms.entries()]
        .map(([form, rows]) => ({ form, rows }))
        .sort((a, b) => b.rows - a.rows),
    };
  }

  /**
   * A client's standing, recomputed from their verifications.
   *
   * THE LATEST, not the best. A client who passed in March and was declined in
   * September is declined — taking the most favourable attempt would let a
   * revoked verification stand for ever, which is the failure mode a compliance
   * table exists to prevent.
   */
  async refreshClientStatus(clientIds: string[]): Promise<number> {
    let touched = 0;
    for (const clientId of clientIds) {
      const latest = await this.prisma.kycCase.findFirst({
        where: { clientId },
        orderBy: [{ submittedAt: 'desc' }],
        select: { status: true },
      });
      if (!latest) continue;
      await this.prisma.client.update({
        where: { id: clientId },
        data: { kycStatus: latest.status },
      });
      touched++;
    }
    return touched;
  }

  /**
   * How much of the trading book is actually verified.
   *
   * The question a KYC table exists to answer and the one that needed the join:
   * every payment carries a `CU…` reference, so the clients who have moved money
   * and the clients who have been verified can finally be compared. A client
   * trading without a verification is the finding; the rest is bookkeeping.
   */
  async coverage() {
    const [verified, payers] = await Promise.all([
      this.prisma.client.findMany({
        where: { externalId: { not: null } },
        select: { externalId: true, kycStatus: true },
      }),
      // Distinct customers seen in the payment ledger, in their own words.
      this.prisma.paymentEvent.groupBy({
        by: ['customer'],
        where: { customer: { not: null } },
        _count: { _all: true },
      }),
    ]);

    const byRef = new Map(
      verified.map((c) => [c.externalId as string, c.kycStatus]),
    );
    const traded = payers
      .map((p) => p.customer)
      .filter((c): c is string => Boolean(c));

    const missing: string[] = [];
    const counts = new Map<string, number>();
    for (const ref of traded) {
      const status = byRef.get(ref);
      if (!status) {
        missing.push(ref);
        continue;
      }
      counts.set(status, (counts.get(status) ?? 0) + 1);
    }

    return {
      tradingClients: traded.length,
      verifiedClients: byRef.size,
      /** Clients who have moved money and have no verification on record. */
      tradingWithoutKyc: missing.length,
      examples: missing.slice(0, 25),
      byStatus: [...counts.entries()]
        .map(([status, clients]) => ({ status, clients }))
        .sort((a, b) => b.clients - a.clients),
    };
  }

  /** Verifications, newest first, for the compliance screen. */
  async cases(limit = 200) {
    const rows = await this.prisma.kycCase.findMany({
      orderBy: { submittedAt: 'desc' },
      take: Math.min(Math.max(limit, 1), 1000),
      include: { client: { select: { externalId: true, country: true } } },
    });
    return rows.map((c) => ({
      id: c.id,
      verificationId: c.verificationId,
      applicantId: c.applicantId,
      reference: c.client?.externalId ?? null,
      country: c.client?.country ?? null,
      status: c.status,
      providerStatus: c.providerStatus,
      form: c.form,
      method: c.method,
      declineReasons: c.declineReasons,
      priceEur: c.priceEur === null ? null : Number(c.priceEur),
      processingMin: c.processingMin,
      submittedAt: c.submittedAt.toISOString(),
    }));
  }

  /**
   * What the file said, summarised — attempts, cost, and why they failed.
   *
   * Re-verification is the expensive part and nothing was counting it. One
   * client in the sample export was verified four times in an afternoon and
   * billed for all four, and the reasons are in the data: wrong name, expired
   * document, document not visible. Those are fixable at the form, not at the
   * desk.
   */
  async summary() {
    const [total, byStatus, byReason, cost, repeats] = await Promise.all([
      this.prisma.kycCase.count(),
      this.prisma.kycCase.groupBy({ by: ['status'], _count: { _all: true } }),
      this.prisma.kycCase.findMany({
        where: { NOT: { declineReasons: { isEmpty: true } } },
        select: { declineReasons: true },
      }),
      this.prisma.kycCase.aggregate({
        _sum: { priceEur: true },
        _avg: { processingMin: true },
      }),
      this.prisma.kycCase.groupBy({
        by: ['clientId'],
        where: { clientId: { not: null } },
        _count: { _all: true },
      }),
    ]);

    const reasons = new Map<string, number>();
    for (const r of byReason)
      for (const reason of r.declineReasons)
        reasons.set(reason, (reasons.get(reason) ?? 0) + 1);

    const retried = repeats.filter((r) => r._count._all > 1);
    return {
      verifications: total,
      byStatus: byStatus.map((s) => ({
        status: s.status,
        count: s._count._all,
      })),
      declineReasons: [...reasons.entries()]
        .map(([reason, count]) => ({ reason, count }))
        .sort((a, b) => b.count - a.count),
      spentEur: cost._sum.priceEur === null ? 0 : Number(cost._sum.priceEur),
      averageMinutes:
        cost._avg.processingMin === null
          ? null
          : Math.round(cost._avg.processingMin * 10) / 10,
      /** Clients who needed more than one attempt, and the worst case. */
      clientsRetried: retried.length,
      mostAttempts: retried.reduce((m, r) => Math.max(m, r._count._all), 0),
    };
  }
}
