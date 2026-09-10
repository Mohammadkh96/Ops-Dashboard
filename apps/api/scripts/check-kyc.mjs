// Verifications from the KYC provider, and the client standing derived.
//
// Every fixture is a real shape from one month of two live KYCAID forms,
// because the things that break an importer here are not the ones anybody
// invents:
//
//   • ONE ROW PER VERIFICATION, not per client. CU447 appears four times in an
//     afternoon — invalid, invalid, invalid, valid. Keyed on the client, three
//     of those vanish and the survivor is whichever was imported last.
//   • a verification with NO external applicant id. It cost a euro and carries
//     a decline reason, and dropping it silently is the one thing a compliance
//     record must not do.
//   • the provider's own two vocabularies: "VALID" in the export, "completed"
//     in the callback, from the same vendor on the same day.
//   • the two forms differ — one entity's checks include ADDRESS and the
//     other's do not, which is the only record that two clients were held to
//     different standards.
//
//   npm run build && node scripts/check-kyc.mjs
//
// In a throwaway database.

import 'dotenv/config';
import { createRequire } from 'node:module';

import { useScratchDb } from './scratch-db.mjs';

let failures = 0;
function ok(name, cond, detail) {
  if (cond) console.log(`ok    ${name}`);
  else {
    failures++;
    console.log(
      `FAIL  ${name} ${detail === undefined ? '' : JSON.stringify(detail)}`,
    );
  }
}
const section = (t) => console.log(`\n── ${t} ──`);

process.env.JWT_SECRET ??= 'kyc-check';
process.env.PAYMAXIS_POLL_ENABLED = '0';

const MAU = 'DEFAULT KYC Tradin MAU';
const OTHER = 'DEFAULT KYC';

/** A row as the browser hands it over, already stripped of everything else. */
const v = (n) => ({
  verificationId: n.id,
  applicantId: n.applicant ?? 'app-' + (n.ref ?? 'x'),
  externalApplicantId: n.ref ?? null,
  status: n.status,
  at: n.at ? new Date(n.at) : null,
  form: n.form ?? MAU,
  method: n.method ?? 'Manual check',
  declineReasons: n.reasons ?? [],
  priceEur: n.price ?? 1,
  processingMin: n.minutes ?? 4,
});

async function run() {
  const drop = await useScratchDb('opsos_kyc_check');
  const require_ = createRequire(import.meta.url);
  const { createApp } = require_('../dist/src/bootstrap');
  const { PrismaService } = require_('../dist/src/prisma/prisma.service');
  const { KycService, defaultStatus } = require_('../dist/src/kyc/kyc.service');

  const app = await createApp();
  await app.init();
  const prisma = app.get(PrismaService);
  const kyc = app.get(KycService);

  try {
    section("the provider's word, mapped onto ours");
    {
      // The export's vocabulary...
      ok('VALID approves', defaultStatus('VALID') === 'APPROVED');
      ok('INVALID rejects', defaultStatus('INVALID') === 'REJECTED');
      // ...and the callback's, from the same vendor.
      ok('completed approves too', defaultStatus('completed') === 'APPROVED');
      ok('case does not matter', defaultStatus('valid') === 'APPROVED');
      ok('a word nobody has seen is PENDING, not APPROVED',
         defaultStatus('under_consideration') === 'PENDING');
      ok('and neither is blank', defaultStatus('') === 'PENDING');
      ok('nor null', defaultStatus(null) === 'PENDING');
    }

    section('one client, four attempts');
    {
      // CU447, as exported: three failures then a pass, all within an hour.
      const r = await kyc.importVerifications([
        v({ id: 'ver-1', ref: 'CU447', applicant: 'app-447', status: 'INVALID',
            at: '2026-11-13T11:24:00Z', reasons: ['Wrong name', 'Expired document', 'Other'] }),
        v({ id: 'ver-2', ref: 'CU447', applicant: 'app-447', status: 'INVALID',
            at: '2026-11-13T11:31:00Z', reasons: ['Wrong name', 'Other', 'Expired document'] }),
        v({ id: 'ver-3', ref: 'CU447', applicant: 'app-447', status: 'INVALID',
            at: '2026-11-13T11:40:00Z', reasons: ['Wrong name', 'Other', 'Expired document'] }),
        v({ id: 'ver-4', ref: 'CU447', applicant: 'app-447', status: 'VALID',
            at: '2026-11-13T11:50:00Z' }),
      ]);
      ok('all four are kept', r.created === 4, r);
      ok('as one client', r.clientsCreated === 1, r);

      const cases = await prisma.kycCase.count();
      ok('four rows in the table', cases === 4, cases);

      // The whole point of keying on the verification rather than the client.
      const client = await prisma.client.findUnique({ where: { externalId: 'CU447' } });
      ok('and the client reads APPROVED from the LATEST', client.kycStatus === 'APPROVED', client.kycStatus);

      // The history survives, which is what a compliance officer is asked for.
      const failed = await prisma.kycCase.count({ where: { status: 'REJECTED' } });
      ok('the three failures are still on record', failed === 3, failed);
    }

    section('the latest, not the most favourable');
    {
      // Passed in March, declined in September. Taking the best attempt would
      // let a revoked verification stand for ever.
      await kyc.importVerifications([
        v({ id: 'rev-1', ref: 'CU900', applicant: 'app-900', status: 'VALID',
            at: '2026-03-01T09:00:00Z' }),
        v({ id: 'rev-2', ref: 'CU900', applicant: 'app-900', status: 'INVALID',
            at: '2026-09-01T09:00:00Z', reasons: ['Duplicate'] }),
      ]);
      const c = await prisma.client.findUnique({ where: { externalId: 'CU900' } });
      ok('a client declined after passing reads REJECTED', c.kycStatus === 'REJECTED', c.kycStatus);
    }

    section('a verification that belongs to nobody');
    {
      // Erkan Yilmaz in the real export: INVALID, Duplicate, and no external
      // applicant id at all.
      const r = await kyc.importVerifications([
        v({ id: 'orphan-1', ref: null, applicant: 'app-orphan', status: 'INVALID',
            reasons: ['Duplicate'], at: '2026-11-13T08:30:00Z' }),
      ]);
      ok('it is stored, not dropped', r.created === 1, r);
      ok('and counted as unlinked', r.unlinked === 1, r);
      const row = await prisma.kycCase.findFirst({ where: { verificationId: 'orphan-1' } });
      ok('with no client', row.clientId === null, row?.clientId);
      ok('and its reason kept', row.declineReasons.includes('Duplicate'), row?.declineReasons);
    }

    section('importing the same file twice');
    {
      const before = await prisma.kycCase.count();
      const again = await kyc.importVerifications([
        v({ id: 'ver-4', ref: 'CU447', applicant: 'app-447', status: 'VALID',
            at: '2026-11-13T11:50:00Z' }),
      ]);
      const after = await prisma.kycCase.count();
      ok('updates rather than duplicates', again.updated === 1 && again.created === 0, again);
      ok('so the count does not move', before === after, { before, after });
      ok('and no second client appears', again.clientsCreated === 0, again);
    }

    section('what the file tells you about itself');
    {
      const r = await kyc.importVerifications([
        v({ id: 'f-1', ref: 'CU1', status: 'VALID', form: MAU, method: 'Automation check',
            price: 0.5, minutes: 0, at: '2026-11-14T09:00:00Z' }),
        v({ id: 'f-2', ref: 'CU2', status: 'VALID', form: OTHER, method: 'Manual check',
            price: 0.25, minutes: 5, at: '2026-11-14T09:05:00Z' }),
        v({ id: 'f-3', ref: 'CU3', status: 'INVALID', form: OTHER, reasons: ['Faces are different'],
            price: 0.75, minutes: 3, at: '2026-11-14T09:10:00Z' }),
      ]);
      // Discovered, never assumed — the step skipped twice this week on
      // payment providers, each time wrongly.
      ok('every status it saw is reported',
         r.statuses.some((s) => s.status === 'VALID') && r.statuses.some((s) => s.status === 'INVALID'),
         r.statuses);
      ok('and every form', r.forms.length === 2, r.forms);
      ok('the two entities are distinguishable',
         r.forms.some((f) => f.form === MAU) && r.forms.some((f) => f.form === OTHER), r.forms);

      const s = await kyc.summary();
      ok('re-verification is counted', s.clientsRetried >= 1, s.clientsRetried);
      ok('and the worst case named', s.mostAttempts === 4, s.mostAttempts);
      ok('the bill is added up', s.spentEur > 0, s.spentEur);
      ok('and the reasons ranked',
         s.declineReasons[0]?.reason === 'Wrong name', s.declineReasons.slice(0, 3));
    }

    section('a mapping typed on the screen wins');
    {
      await kyc.importVerifications(
        [v({ id: 'map-1', ref: 'CU777', status: 'VALID', at: '2026-11-15T09:00:00Z' })],
        { mapping: { VALID: 'IN_REVIEW' } },
      );
      const row = await prisma.kycCase.findFirst({ where: { verificationId: 'map-1' } });
      ok('the override is applied', row.status === 'IN_REVIEW', row?.status);
      ok('and their word is still on the row', row.providerStatus === 'VALID', row?.providerStatus);

      // An enum column would otherwise refuse it with a message about a type.
      let msg = '';
      try {
        await kyc.importVerifications(
          [v({ id: 'map-2', ref: 'CU778', status: 'VALID' })],
          { mapping: { VALID: 'DEFINITELY_FINE' } },
        );
      } catch (e) { msg = e.message; }
      ok('a status this dashboard does not have is refused', /not a status/i.test(msg), msg);
      ok('and the refusal lists the real ones', /EDD_REQUIRED/.test(msg), msg);
    }

    section('who is trading without a verification');
    {
      // Two payers. One has been verified, one never has.
      for (const [customer, id] of [['CU447', 'p1'], ['CU4242', 'p2']]) {
        await prisma.paymentEvent.create({
          data: { provider: 'paymaxis', terminal: 'T', paymentId: id, customer,
                  type: 'DEPOSIT', state: 'COMPLETED', amount: 100, currency: 'USD',
                  occurredAt: new Date('2026-11-14T10:00:00Z'), headers: {}, payload: {} },
        });
      }
      const c = await kyc.coverage();
      ok('the unverified payer is found', c.tradingWithoutKyc === 1, c);
      ok('and named', c.examples.includes('CU4242'), c.examples);
      ok('the verified one is not', !c.examples.includes('CU447'), c.examples);
      ok('and is counted under its status',
         c.byStatus.some((s) => s.status === 'APPROVED' && s.clients === 1), c.byStatus);
    }

    section('what it refuses');
    {
      let msg = '';
      try { await kyc.importVerifications([]); } catch (e) { msg = e.message; }
      ok('an empty file is refused with something to do about it',
         /export again from the provider/i.test(msg), msg);

      const r = await kyc.importVerifications([
        v({ id: '', ref: 'CU999', status: 'VALID' }),
      ]);
      ok('a row with no verification id is counted, not stored',
         r.unusable === 1 && r.created === 0, r);
    }
  } finally {
    await app.close();
    await drop();
  }

  return failures;
}

void run()
  .then((n) => {
    console.log(n ? `\n${n} check(s) failed.` : '\nAll KYC checks passed.');
    process.exit(n ? 1 : 0);
  })
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
