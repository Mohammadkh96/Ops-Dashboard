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
// Enough for `configured` to be true. Every provider call in this file goes to
// a stand-in passed in by the check, so nothing here can reach the real
// account even if a real token is sitting in .env.
process.env.KYCAID_API_TOKEN = 'kyc-check-token';

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
  const { KycService, defaultStatus, readDay, nextDay } =
    require_('../dist/src/kyc/kyc.service');
  const { toVerificationRow, readDeclineReasons, readRows } =
    require_('../dist/src/kyc/kycaid.client');

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

    // ── Reading the provider directly ──
    //
    // The import screen was built on a finding that turned out to be false:
    // that KYCAID will not enumerate. It does — GET /verifications/report,
    // one day at a time. These fixtures are that endpoint's documented shape,
    // and the two that matter most are units: it reports money in euro CENTS
    // and duration in SECONDS, where the console export writes euros and
    // minutes into the same two columns.

    section('a report row, in their units');
    {
      const row = toVerificationRow({
        created_at: '2026-11-13T11:24:00Z',
        verification_id: 'rep-1',
        applicant_id: 'app-1',
        external_applicant_id: 'CU5001',
        form_id: 'form-mau',
        status: 'completed',
        method: 'Manual check',
        decline_reasons: [],
        processing_time: 240,
        price: 150,
      }, new Map([['form-mau', MAU]]));

      ok('price is euro cents, not euros', row.priceEur === 1.5, row.priceEur);
      ok('processing time is seconds, not minutes',
         row.processingMin === 4, row.processingMin);
      ok('the form id is resolved to its name', row.form === MAU, row.form);
      ok('the account reference survives', row.externalApplicantId === 'CU5001');
      ok('their status word is kept verbatim', row.status === 'completed');
      ok('a completed check with no reason to decline passed',
         row.verdict === 'PASS', row.verdict);

      const unnamed = toVerificationRow({ verification_id: 'x', form_id: 'form-9' }, new Map());
      ok('an unknown form keeps its id rather than becoming null',
         unnamed.form === 'form-9', unnamed.form);
      ok('a row with no verification id is dropped, not half-built',
         toVerificationRow({ status: 'completed' }) === null);
    }

    section('"completed" is not "passed"');
    {
      // The trap this endpoint sets. The same verification the console export
      // calls INVALID is `completed` here — a processing state, not a verdict.
      // Read the word alone and every decline of the last year is an approval.
      const declined = toVerificationRow({
        verification_id: 'rep-2',
        external_applicant_id: 'CU5002',
        status: 'completed',
        decline_reasons: ['EXPIRED_DOCUMENT', 'WRONG_NAME'],
      });
      ok('a completed check WITH decline reasons failed',
         declined.verdict === 'FAIL', declined.verdict);
      ok('and the word "completed" would have said the opposite',
         defaultStatus('completed') === 'APPROVED');

      const r = await kyc.importVerifications([declined]);
      const stored = await prisma.kycCase.findFirst({ where: { verificationId: 'rep-2' } });
      ok('so it is stored REJECTED', stored.status === 'REJECTED', stored.status);
      ok('with their own word still readable beside it',
         stored.providerStatus === 'completed', stored.providerStatus);
      ok('and the client reads REJECTED', r.clientsUpdated >= 1, r);

      // Undecided is undecided. A pending check has no verdict, and giving it
      // one because no reason has been recorded YET is how a half-finished
      // check becomes an approval.
      const pending = toVerificationRow({
        verification_id: 'rep-3', status: 'pending', decline_reasons: [],
      });
      ok('a pending check gets no verdict at all', pending.verdict === null);
      ok('a form nobody opened is NOT_STARTED, not PENDING',
         defaultStatus('unused') === 'NOT_STARTED');
    }

    section('a mapping typed on the screen still wins over the verdict');
    {
      const row = toVerificationRow({
        verification_id: 'rep-4', external_applicant_id: 'CU5004',
        status: 'completed', decline_reasons: ['OTHER'],
      });
      await kyc.importVerifications([row], { mapping: { completed: 'IN_REVIEW' } });
      const stored = await prisma.kycCase.findFirst({ where: { verificationId: 'rep-4' } });
      ok('a person looking at the vocabulary outranks a derived verdict',
         stored.status === 'IN_REVIEW', stored.status);
    }

    section('decline reasons, in all three shapes the vendor sends');
    {
      ok('a list of strings',
         readDeclineReasons(['Wrong name', 'Other']).join('|') === 'Wrong name|Other');
      ok('a list of objects, as the callback sends',
         readDeclineReasons([{ code: 'EXPIRED' }, { reason: 'Wrong name' }]).join('|')
           === 'EXPIRED|Wrong name');
      ok('one comma-joined string, as the export writes',
         readDeclineReasons('Wrong name, Other').join('|') === 'Wrong name|Other');
      ok('nothing is an empty list, never [""]', readDeclineReasons(null).length === 0);
      ok('and so is an empty string', readDeclineReasons('').length === 0);
    }

    section('the array, wherever they put it');
    {
      ok('a bare array', readRows([{ a: 1 }]).length === 1);
      ok('wrapped in data', readRows({ data: [{ a: 1 }, { a: 2 }] }).length === 2);
      ok('wrapped in verifications', readRows({ verifications: [{ a: 1 }] }).length === 1);
      // The failure this prevents is silent: an unrecognised wrapper reads as
      // "no verifications that day" for a day that had four hundred.
      ok('an object with no array is empty, not a crash', readRows({ ok: true }).length === 0);
      ok('and so is nothing at all', readRows(null).length === 0);
    }

    section('a day is a day');
    {
      ok('a real date passes', readDay('2026-11-13') === '2026-11-13');
      // The provider answers a malformed date with an EMPTY report rather than
      // an error, so a slip in the format reads as a quiet month.
      ok('the 31st of February is refused', readDay('2026-02-31') === null);
      ok('an unpadded date is refused', readDay('2026-2-3') === null);
      ok('a timestamp is refused', readDay('2026-11-13T00:00:00Z') === null);
      ok('nothing is refused', readDay('') === null && readDay(undefined) === null);
      ok('the next day crosses a month', nextDay('2026-11-30') === '2026-12-01');
      ok('and a year', nextDay('2026-12-31') === '2027-01-01');
      ok('and a leap day', nextDay('2028-02-28') === '2028-02-29');
    }

    section('walking the days');
    {
      // A stand-in provider. Nothing here touches the live account, and the
      // call log is what proves the walk asked for each day exactly once.
      const asked = [];
      const fake = (byDay) => ({
        forms: async () => new Map([['form-mau', MAU]]),
        report: async (date, offset, count) => {
          asked.push(`${date}@${offset}`);
          return (byDay[date] ?? []).slice(offset, offset + count);
        },
      });
      const rep = (id, ref, day) => ({
        created_at: `${day}T10:00:00Z`, verification_id: id,
        external_applicant_id: ref, form_id: 'form-mau',
        status: 'completed', decline_reasons: [], price: 100, processing_time: 60,
      });

      const r = await kyc.syncFromProvider({
        from: '2026-10-01', to: '2026-10-03',
        client: fake({
          '2026-10-01': [rep('s-1', 'CU6001', '2026-10-01')],
          '2026-10-02': [],
          '2026-10-03': [rep('s-2', 'CU6002', '2026-10-03'), rep('s-3', 'CU6003', '2026-10-03')],
        }),
      });
      ok('every day in the range was asked for',
         asked.join(',') === '2026-10-01@0,2026-10-02@0,2026-10-03@0', asked);
      ok('three days read', r.days === 3, r);
      ok('three verifications fetched', r.fetched === 3, r);
      ok('and three stored', r.created === 3, r);
      ok('a day with nothing in it is not an error', r.done === true, r);
      ok('the range is finished, so there is no cursor', r.nextDate === null, r);
      ok('the clients came with them', r.clientsCreated === 3, r);
    }

    section('re-reading a day changes nothing');
    {
      // What makes resuming from a half-done date safe.
      const again = await kyc.syncFromProvider({
        from: '2026-10-03', to: '2026-10-03',
        client: {
          forms: async () => new Map(),
          report: async () => [
            { created_at: '2026-10-03T10:00:00Z', verification_id: 's-2',
              external_applicant_id: 'CU6002', status: 'completed',
              decline_reasons: [], price: 100, processing_time: 60 },
          ],
        },
      });
      ok('the same verification updates rather than duplicating',
         again.updated === 1 && again.created === 0, again);
      const n = await prisma.kycCase.count({ where: { verificationId: 's-2' } });
      ok('still one row', n === 1, n);
    }

    section('a day bigger than one page');
    {
      const day = '2026-09-15';
      const many = Array.from({ length: 1400 }, (_, i) => ({
        created_at: `${day}T10:00:00Z`,
        verification_id: `big-${i}`,
        external_applicant_id: `CU7${String(i).padStart(4, '0')}`,
        status: 'completed', decline_reasons: [], price: 100, processing_time: 60,
      }));
      const offsets = [];
      const r = await kyc.syncFromProvider({
        from: day, to: day,
        client: {
          forms: async () => new Map(),
          report: async (_d, offset, count) => {
            offsets.push(offset);
            return many.slice(offset, offset + count);
          },
        },
      });
      // 1000 is the provider's maximum AND its default, so a short page is the
      // only signal that a day is finished.
      ok('it pages until a short one comes back',
         offsets.join(',') === '0,1000', offsets);
      ok('all 1,400 are stored', r.created === 1400, r.created);
      ok('and nothing was marked incomplete', r.truncated.length === 0, r.truncated);
    }

    section('a budget that runs out hands back where to resume');
    {
      // The reason this returns a cursor instead of finishing: a sixty-second
      // function cannot read a year, and one that dies trying reports nothing
      // — not even the eleven months it had already written.
      const seen = [];
      const r = await kyc.syncFromProvider({
        from: '2026-08-01', to: '2026-08-31',
        budgetMs: 100,
        client: {
          forms: async () => new Map(),
          // A day that takes longer than the whole budget, so where it stops
          // is arithmetic rather than a race.
          report: async (date) => {
            seen.push(date);
            await new Promise((r) => setTimeout(r, 250));
            return [];
          },
        },
      });
      ok('it stopped after the first day', seen.length === 1, seen);
      ok('and says so', r.done === false, r);
      ok('naming the day to resume from', r.nextDate === '2026-08-02', r.nextDate);
      ok('the range it was given is echoed back',
         r.from === '2026-08-01' && r.to === '2026-08-31', r);
    }

    section('what the direct reader refuses');
    {
      let msg = '';
      try {
        await kyc.syncFromProvider({ from: '2026-10-05', to: '2026-10-01',
                                     client: { forms: async () => new Map(), report: async () => [] } });
      } catch (e) { msg = e.message; }
      ok('a range that runs backwards', /runs backwards/i.test(msg), msg);

      const token = process.env.KYCAID_API_TOKEN;
      delete process.env.KYCAID_API_TOKEN;
      msg = '';
      try { await kyc.syncFromProvider({}); } catch (e) { msg = e.message; }
      // Naming the variable is the difference between a dead button and a
      // one-line fix, and the file import still works meanwhile.
      ok('no token, and it names the variable to set',
         /KYCAID_API_TOKEN/.test(msg), msg);
      if (token !== undefined) process.env.KYCAID_API_TOKEN = token;
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
