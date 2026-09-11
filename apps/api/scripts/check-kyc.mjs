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
  const { KycService, defaultStatus, readDay, nextDay, readChecks } =
    require_('../dist/src/kyc/kyc.service');
  const {
    toVerificationRow,
    readDeclineReasons,
    readRows,
    readCountryNames,
    kycaidAccounts,
  } = require_('../dist/src/kyc/kycaid.client');
  const { ModulesService, codesFor } = require_(
    '../dist/src/modules/modules.service',
  );

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
    // one day at a time. These fixtures are that endpoint's documented shape.
    //
    // UNITS, AND A CORRECTION. The reference says `price` is euro CENTS and
    // `processing_time` SECONDS, and these checks asserted both conversions.
    // The live data refutes them: 30,444 rows read from this API averaged
    // €0.0074 against 7,983 export rows at €0.8625 — a 116-fold gap between
    // two populations of the same verifications — and every Mins column on
    // screen read 0, because a four-minute check divided by sixty rounds to
    // nothing. Both figures are taken as they come now, and these checks pin
    // that down so nobody reinstates the division from the documentation.

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
        processing_time: 4,
        price: 1.5,
        country_code: 'ph',
      }, new Map([['form-mau', MAU]]));

      ok('price is already euros — the documented /100 is wrong',
         row.priceEur === 1.5, row.priceEur);
      ok('processing time is already minutes — the documented /60 is wrong',
         row.processingMin === 4, row.processingMin);
      ok('the form id is resolved to its name', row.form === MAU, row.form);
      // Declared on the row type, documented as the one exception to reading
      // no personal data — and never actually assigned, so every verification
      // fetched from the API landed with an empty country while the console
      // showed Philippines and Albania.
      ok('the country code is read, and upper-cased',
         row.country === 'PH', row.country);
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

    section('what an approval actually covered, and what is never kept');
    {
      // The console's "Checks" column: Profile, Document, Liveness, Address,
      // Database Screening, Adverse Media. The two entities run two forms and
      // the forms do not include the same checks, so "Approved" means
      // different things on the two halves of the table — and nothing on the
      // screen said so.
      const full = toVerificationRow({
        verification_id: 'chk-1',
        external_applicant_id: 'CU7801',
        status: 'completed',
        decline_reasons: [],
        country_code: 'AL',
        verification_types: ['PROFILE', 'DOCUMENT', 'LIVENESS', 'ADDRESS'],
        // Everything this integration refuses to hold, sent by the provider in
        // the same row as everything it does.
        first_name: 'Julie Ann',
        last_name: 'Macaron',
        dob: '1990-04-02',
        email: 'someone@example.com',
        phone: '+639000000',
        tax_id_number: 'TIN-1',
        wallet_address: '0xdead',
        telegram_username: '@someone',
      });

      ok('the checks that ran are read', full.checks.length === 4, full.checks);
      ok('a comma-separated list is read too, since the vendor sends both',
         toVerificationRow({ verification_id: 'chk-2',
                             verification_types: 'PROFILE, DOCUMENT' }).checks.length === 2);

      // The rest of the row is kept so the column nobody has asked for yet
      // does not cost a year of re-fetching — but it is NOT a copy of the
      // person. This is the assertion that keeps that true.
      const kept = Object.keys(full.raw);
      const forbidden = ['first_name', 'last_name', 'dob', 'email', 'phone',
                         'tax_id_number', 'wallet_address', 'telegram_username'];
      ok('the rest of the row is kept for later',
         kept.includes('verification_types') && kept.includes('country_code'), kept);
      ok('but every identity field is stripped before it can be stored',
         forbidden.every((f) => !kept.includes(f)), kept);

      await kyc.importVerifications([full]);
      const stored = await prisma.kycCase.findFirst({
        where: { verificationId: 'chk-1' },
      });
      ok('the checks reach the table', stored.checks.length === 4, stored.checks);
      // The database is the thing that outlives every decision made above it.
      ok('and no name, date of birth, email or phone reaches the database',
         forbidden.every((f) => !(f in stored.raw)), Object.keys(stored.raw));
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
      ok('wrapped in countries', readRows({ countries: [{ a: 1 }] }).length === 1);
    }

    section('a country is a name, not two letters');
    {
      // The provider's documented shape: the names are a LIST of
      // {language_code, label}, not a field. A reader that expects `name`
      // finds nothing and reports an empty list — which is indistinguishable
      // from an account configured to verify nowhere.
      const body = [
        {
          country_code: 'PH',
          labels: [
            { language_code: 'EN', label: 'Philippines' },
            { language_code: 'RU', label: 'Филиппины' },
          ],
        },
        {
          country_code: 'al',
          labels: [{ language_code: 'EN', label: 'Albania' }],
        },
        // No English label at all. A country named in Russian is more use
        // than a country not named.
        { country_code: 'ZW', labels: [{ language_code: 'RU', label: 'Зимбабве' }] },
        // No code: nothing to key on, so nothing kept.
        { labels: [{ language_code: 'EN', label: 'Nowhere' }] },
      ];
      const names = readCountryNames(body);
      ok('the English label is the one taken', names.get('PH') === 'Philippines', names.get('PH'));
      ok('the code is upper-cased, as the stored column is', names.get('AL') === 'Albania', [...names.keys()]);
      ok('another language beats no name at all', names.get('ZW') === 'Зимбабве', names.get('ZW'));
      ok('a row with no code is dropped rather than keyed on ""', names.size === 3, names.size);
      ok('a language can be asked for', readCountryNames(body, 'RU').get('PH') === 'Филиппины');
      ok('an empty reply is an empty map, not a throw', readCountryNames(null).size === 0);
      ok('and so is a reply of the wrong shape', readCountryNames({ ok: true }).size === 0);
    }

    section('searching by the name the column shows');
    {
      const names = new Map([
        ['PH', 'Philippines'],
        ['GB', 'United Kingdom'],
        ['AE', 'United Arab Emirates'],
        ['AL', 'Albania'],
      ]);
      // The table reads "Philippines" and the database holds "PH". Without
      // this, typing what is on the screen empties the table.
      ok('a country name resolves to its code', codesFor('philip', names).join() === 'PH');
      ok('case does not matter', codesFor('PHILIPPINES', names).join() === 'PH');
      ok('a partial match can name several', codesFor('united', names).join() === 'GB,AE');
      ok('a name nobody uses matches nothing', codesFor('atlantis', names).length === 0);
      // Under three letters the plain `contains` match on the code column is
      // already doing the work, and every two-letter search would otherwise
      // drag forty codes into an IN clause.
      ok('two letters are left to the code match', codesFor('ph', names).length === 0);
      ok('no search text, no codes', codesFor('', names).length === 0);
      ok('no country list, no codes', codesFor('philippines', new Map()).length === 0);
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
        clients: [{ label: '', client: fake({
          '2026-10-01': [rep('s-1', 'CU6001', '2026-10-01')],
          '2026-10-02': [],
          '2026-10-03': [rep('s-2', 'CU6002', '2026-10-03'), rep('s-3', 'CU6003', '2026-10-03')],
        }) }],
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
        clients: [{ label: '', client: {
          forms: async () => new Map(),
          report: async () => [
            { created_at: '2026-10-03T10:00:00Z', verification_id: 's-2',
              external_applicant_id: 'CU6002', status: 'completed',
              decline_reasons: [], price: 100, processing_time: 60 },
          ],
        } }],
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
        clients: [{ label: '', client: {
          forms: async () => new Map(),
          report: async (_d, offset, count) => {
            offsets.push(offset);
            return many.slice(offset, offset + count);
          },
        } }],
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
        clients: [{ label: '', client: {
          forms: async () => new Map(),
          // A day that takes longer than the whole budget, so where it stops
          // is arithmetic rather than a race.
          report: async (date) => {
            seen.push(date);
            await new Promise((r) => setTimeout(r, 250));
            return [];
          },
        } }],
      });
      ok('it stopped after the first day', seen.length === 1, seen);
      ok('and says so', r.done === false, r);
      ok('naming the day to resume from', r.nextDate === '2026-08-02', r.nextDate);
      ok('the range it was given is echoed back',
         r.from === '2026-08-01' && r.to === '2026-08-31', r);
    }

    // ── The compliance table ──
    //
    // What this screen showed before: the first 500 rows of a 12,129-row
    // import, a "500 of 500" that was a truncation wearing the clothes of a
    // total, filters applied to whatever those 500 happened to be, and an
    // attempts count taken over the same window.

    section('minutes are whole, because the column is');
    {
      // Prisma refuses a fraction for an Int column, and the provider has no
      // obligation to send whole minutes. The reader passes the figure through
      // untouched — it is the provider's own number and nothing here is
      // entitled to round it — and the store rounds once, on the way in.
      const odd = toVerificationRow({
        verification_id: 'min-1', external_applicant_id: 'CU4001',
        status: 'completed', decline_reasons: [], processing_time: 2.28,
      });
      ok('the reader passes the provider figure through as it came',
         Math.abs(odd.processingMin - 2.28) < 1e-9, odd.processingMin);

      await kyc.importVerifications([odd]);
      const stored = await prisma.kycCase.findFirst({ where: { verificationId: 'min-1' } });
      ok('and the store rounds it to something the column can hold',
         stored.processingMin === 2, stored.processingMin);

      // The file export has the same trap from the other direction: a
      // spreadsheet will write 4.5 into a minutes column quite happily.
      await kyc.importVerifications([
        { ...v({ id: 'min-2', ref: 'CU4002', status: 'VALID' }), processingMin: 4.5 },
      ]);
      const half = await prisma.kycCase.findFirst({ where: { verificationId: 'min-2' } });
      ok('from the file path too', half.processingMin === 5, half.processingMin);
    }

    section('test-mode rows never reach the compliance table');
    {
      // KYCAID's own docs: test mode "is no different from the live mode
      // except the priority". Same columns, same prices, same statuses — which
      // is exactly why counting them would never look wrong on screen.
      const day = '2026-06-01';
      const r = await kyc.syncFromProvider({
        from: day, to: day,
        clients: [{ label: '', client: {
          forms: async () => new Map(),
          report: async () => [
            { created_at: `${day}T10:00:00Z`, verification_id: 'live-1',
              external_applicant_id: 'CU4101', status: 'completed',
              decline_reasons: [], price: 200, processing_time: 60, mode: 'LIVE' },
            { created_at: `${day}T10:05:00Z`, verification_id: 'test-1',
              external_applicant_id: 'CU4102', status: 'completed',
              decline_reasons: [], price: 200, processing_time: 60, mode: 'TEST' },
          ],
        } }],
      });
      ok('both were fetched', r.fetched === 2, r.fetched);
      ok('only the live one was stored', r.created === 1, r.created);
      ok('and the test one is counted, not silently dropped',
         r.testSkipped === 1, r.testSkipped);
      ok('the test verification is not in the table',
         (await prisma.kycCase.count({ where: { verificationId: 'test-1' } })) === 0);
      ok('the live one is',
         (await prisma.kycCase.count({ where: { verificationId: 'live-1' } })) === 1);
    }

    section('a paid lookup is not a person who failed to link');
    {
      // A SERVICE row has a price and no applicant. Unlabelled it reads as a
      // verification that could not be linked to an account — it inflates the
      // count, the spend per client, and appears under "no form recorded",
      // which the by-form panel reports as a gap in the import. The absence of
      // the label does not just lose information, it invents a finding.
      const day = '2026-06-02';
      await kyc.syncFromProvider({
        from: day, to: day,
        clients: [{ label: '', client: {
          forms: async () => new Map(),
          report: async () => [
            { created_at: `${day}T10:00:00Z`, verification_id: 'svc-1',
              status: 'completed', service: 'SERVICE', method: 'BR_CPF',
              decline_reasons: [], price: 30, processing_time: 2, mode: 'LIVE' },
          ],
        } }],
      });
      const svc = await prisma.kycCase.findFirst({ where: { verificationId: 'svc-1' } });
      ok('it is stored', Boolean(svc));
      ok('and labelled as a service, not a verification',
         svc.service === 'SERVICE', svc.service);
      ok('the file import leaves the label unknown rather than guessing',
         (await prisma.kycCase.findFirst({ where: { verificationId: 'min-2' } })).service === null);
    }

    section('two entities, two accounts, two tokens');
    {
      // Mauritius and Saint Lucia hold SEPARATE KYCAID accounts. A token reads
      // one of them and cannot see the other, so a sync that walks a single
      // client fetches one brand in full, reports "done", and leaves the other
      // invisible — which on screen is indistinguishable from a brand that
      // verifies fewer people.
      const asked = [];
      const acct = (label, rows) => ({
        label,
        client: {
          forms: async () => new Map([[`form-${label}`, `${label} form`]]),
          report: async (date, offset) => {
            asked.push(`${label}:${date}@${offset}`);
            return rows;
          },
        },
      });
      const day = '2026-05-04';
      const row = (id, ref, label) => ({
        created_at: `${day}T10:00:00Z`, verification_id: id,
        external_applicant_id: ref, form_id: `form-${label}`,
        status: 'completed', decline_reasons: [], price: 100,
        processing_time: 60, mode: 'LIVE',
      });

      const r = await kyc.syncFromProvider({
        from: day, to: day,
        clients: [
          acct('MU', [row('mu-1', 'CU9101', 'MU'), row('mu-2', 'CU9102', 'MU')]),
          acct('SL', [row('sl-1', 'CU9201', 'SL')]),
        ],
      });

      ok('both accounts were asked for the same day',
         asked.join(',') === `MU:${day}@0,SL:${day}@0`, asked);
      ok('and everything landed', r.created === 3, r.created);
      ok('the reply says what each entity returned',
         JSON.stringify(r.accounts) ===
           JSON.stringify([{ account: 'MU', rows: 2 }, { account: 'SL', rows: 1 }]),
         r.accounts);

      const mu = await prisma.kycCase.findFirst({ where: { verificationId: 'mu-1' } });
      const sl = await prisma.kycCase.findFirst({ where: { verificationId: 'sl-1' } });
      ok('each row carries the entity that paid for it',
         mu.account === 'MU' && sl.account === 'SL', { mu: mu.account, sl: sl.account });
      // Each account has its OWN forms. One shared map would name the other
      // entity's forms wrongly, which is worse than leaving them as ids.
      ok('and its own form names, resolved per account',
         mu.form === 'MU form' && sl.form === 'SL form', { mu: mu.form, sl: sl.form });

      // The finding a combined total hides: one entity came back empty.
      const quiet = await kyc.syncFromProvider({
        from: '2026-05-05', to: '2026-05-05',
        clients: [
          acct('MU', [row('mu-3', 'CU9103', 'MU')]),
          acct('SL', []),
        ],
      });
      ok('an account that returned nothing says so rather than averaging away',
         quiet.accounts.find((a) => a.account === 'SL').rows === 0, quiet.accounts);

      // A form lookup that fails leaves the Form column full of provider ids —
      // "12666" where the console says "DEFAULT KYC Tradin MAU". It used to do
      // that in silence, so the ids read as the best the provider offers.
      const broken = {
        label: 'MU',
        client: {
          formsFailed: 'GET /forms: 404 not_found',
          forms: async () => new Map(),
          report: async () => [row('mu-4', 'CU9104', 'MU')],
        },
      };
      const warned = await kyc.syncFromProvider({
        from: '2026-05-06', to: '2026-05-06', clients: [broken],
      });
      ok('a form lookup that failed is reported, not swallowed',
         warned.formNamesUnavailable.length === 1 &&
           /404/.test(warned.formNamesUnavailable[0].why),
         warned.formNamesUnavailable);
      ok('and the rows still land — a name is a decoration, the row is not',
         warned.created === 1, warned.created);
    }

    section('which accounts are configured, and what each holds');
    {
      const before = { ...process.env };
      delete process.env.KYCAID_API_TOKEN;
      process.env.KYCAID_API_TOKENMU = 'mu-token';
      process.env.KYCAID_API_TOKENSL = 'sl-token';

      const status = await kyc.providerStatus();
      ok('a token per entity is two accounts, not one',
         status.accounts.length === 2, status.accounts);
      ok('labelled from the variable name',
         status.accounts.map((a) => a.account).join(',') === 'MU,SL',
         status.accounts);
      ok('and each one names the variable it came from',
         status.accounts[0].variable === 'KYCAID_API_TOKENMU', status.accounts);
      ok('holdings are counted per entity, not just in total',
         status.accounts.find((a) => a.account === 'MU').verifications >= 2,
         status.accounts);
      // Everything loaded from a console export predates the account column.
      ok('rows from a file are named unattributed, not assigned to a brand',
         status.unattributed > 0, status.unattributed);

      for (const k of Object.keys(process.env))
        if (/^KYCAID_API_TOKEN/.test(k)) delete process.env[k];
      Object.assign(process.env, before);
      ok('an underscore in the variable name is not part of the label',
         kycaidAccounts({ KYCAID_API_TOKEN_SL: 'x' })[0].label === 'SL');
      ok('a bare token is the one unlabelled account',
         kycaidAccounts({ KYCAID_API_TOKEN: 'x' })[0].label === '');
      ok('an empty variable is not an account',
         kycaidAccounts({ KYCAID_API_TOKENMU: '  ' }).length === 0);
    }

    section('the two brands, split by their form');
    {
      // The two entities run separate forms and the checks are NOT the same —
      // one includes ADDRESS. A single total across both averages away the one
      // thing a compliance officer gets asked about.
      // Names of their own, so these assertions are about these five rows and
      // not about whatever the earlier sections happened to leave behind.
      const A = 'Brand A KYC (address)';
      const B = 'Brand B KYC';
      const noForm = {
        ...v({ id: 'bd-5', ref: 'CU9005', status: 'VALID', price: 1 }),
        form: null,
      };
      await kyc.importVerifications([
        v({ id: 'bd-1', ref: 'CU9001', status: 'VALID', form: A, price: 2 }),
        v({ id: 'bd-2', ref: 'CU9002', status: 'INVALID', form: A, price: 2,
            reasons: ['Wrong name'] }),
        v({ id: 'bd-3', ref: 'CU9003', status: 'VALID', form: B, price: 3 }),
        // No account reference: kept and counted under its brand, never dropped.
        v({ id: 'bd-4', ref: null, status: 'INVALID', form: B, price: 3,
            reasons: ['Other'] }),
        // No form at all — the shape a file import takes when the export was
        // missing that column.
        noForm,
      ]);

      const byForm = await kyc.byForm();
      const a = byForm.find((f) => f.form === A);
      const b = byForm.find((f) => f.form === B);
      const none = byForm.find((f) => f.form === null);

      ok('each form is its own line', Boolean(a && b), byForm.map((f) => f.form));
      ok('with its own verdicts',
         a.byStatus.APPROVED === 1 && a.byStatus.REJECTED === 1, a.byStatus);
      ok('and its own spend', Number(a.spentEur) === 4, a.spentEur);
      ok('a verification with no account is counted under its brand',
         b.unlinked === 1, b.unlinked);
      // The failure this prevents: a gap quietly added to one brand's total.
      ok('a verification with NO form is its own row, not folded into a brand',
         Boolean(none) && none.verifications >= 1, byForm.map((f) => f.form));
      ok('and neither brand absorbed it',
         a.verifications === 2 && b.verifications === 2,
         { a: a.verifications, b: b.verifications });
      // Every row lands in exactly one line, so the split cannot lose any.
      ok('so the lines still add up to the whole table',
         byForm.reduce((n, f) => n + f.verifications, 0)
           === (await prisma.kycCase.count()));
    }

    section('a page is a page, not a ceiling');
    {
      const modules = app.get(ModulesService);
      // 60 verifications for 30 clients — two each, so attempts is answerable
      // and pages can be made to straddle a client.
      const many = [];
      for (let i = 0; i < 30; i++) {
        for (let a = 0; a < 2; a++) {
          many.push(v({
            id: `pg-${i}-${a}`, ref: `CU8${String(i).padStart(3, '0')}`,
            applicant: `app-8${i}`, status: a ? 'VALID' : 'INVALID',
            at: `2026-07-${String((i % 27) + 1).padStart(2, '0')}T10:0${a}:00Z`,
          }));
        }
      }
      await kyc.importVerifications(many);

      const { total } = await modules.kycCaseCount();
      const first = await modules.kycCases({ limit: 10, offset: 0 });
      const second = await modules.kycCases({ limit: 10, offset: 10 });
      ok('the count is of the table, not of the page', total >= 60, total);
      ok('a page is the size asked for', first.length === 10, first.length);
      // The bug this replaces: row 501 was unreachable by any means the screen
      // offered, because take:500 was the only paging there was.
      ok('and the second page is different rows',
         first.every((r) => !second.some((s) => s.id === r.id)), {
           first: first.map((r) => r.id).slice(0, 3),
           second: second.map((r) => r.id).slice(0, 3),
         });
      ok('a page past the end is empty, not demo data',
         (await modules.kycCases({ limit: 10, offset: 100_000 })).length === 0);
    }

    section('attempts is counted over the table, not the page');
    {
      const modules = app.get(ModulesService);
      // A page of ONE. Counting over the rows in hand would say 1; the client
      // has been through it twice, and that is the finding the column exists
      // for.
      const page = await modules.kycCases({ limit: 1, offset: 0 });
      const row = page[0];
      const real = await prisma.kycCase.count({
        where: { client: { externalId: row.client } },
      });
      ok('a client whose attempts straddle the page still counts them all',
         row.attempts === real, { shown: row.attempts, real, client: row.client });
    }

    section('the filters run in the database');
    {
      const modules = app.get(ModulesService);
      // The failure this prevents: searching for a client who sits past the
      // page cutoff returned nothing, which looks exactly like a client nobody
      // ever verified — the worst answer a compliance screen can give.
      const hits = await modules.kycCases({ q: 'CU8029', limit: 500 });
      ok('a client past the first page is still findable',
         hits.length === 2 && hits.every((h) => h.client === 'CU8029'), hits.length);

      const rejected = await modules.kycCases({ status: 'rejected', limit: 500 });
      ok('a status filter returns only that status',
         rejected.length > 0 && rejected.every((r) => r.status === 'rejected'),
         rejected.length);

      // The dashboard's word for it is `approved_kyc`; the column says APPROVED.
      const approved = await modules.kycCases({ status: 'approved_kyc', limit: 500 });
      ok('and the screen’s word for APPROVED is understood',
         approved.length > 0 && approved.every((r) => r.status === 'approved_kyc'),
         approved.length);

      const counted = await modules.kycCaseCount({ status: 'rejected' });
      ok('the count agrees with the page it is a count of',
         counted.total === rejected.length, { counted: counted.total, page: rejected.length });

      const none = await modules.kycCases({ q: 'CU-nobody-has-this', limit: 500 });
      ok('and a search that matches nothing is empty, not demo data',
         none.length === 0, none.length);
    }

    section('one period and one entity, for every figure on the screen');
    {
      const modules = app.get(ModulesService);
      // The screen used to hold three answers to "which period is this": cards
      // totalling everything ever loaded, a fetch panel with its own pair of
      // dates, and a table with none. These are the rows that prove they now
      // agree — and that the last day of a range is included in it.
      const at = (d) => ({ at: d });
      await kyc.importVerifications([
        { ...v({ id: 'win-1', ref: 'CU7701', status: 'VALID', price: 5,
                 ...at('2026-03-10T09:00:00Z') }), account: 'MU', country: 'MU' },
        // 23:30 ON THE LAST DAY of the range. Written `lte: to` this row
        // disappears, which is the off-by-one that cost a month of payment
        // reconciliation on the other side of this dashboard.
        { ...v({ id: 'win-2', ref: 'CU7702', status: 'VALID', price: 7,
                 ...at('2026-03-31T23:30:00Z') }), account: 'SL', country: 'LC' },
        { ...v({ id: 'win-3', ref: 'CU7703', status: 'INVALID', price: 9,
                 reasons: ['Other'], ...at('2026-04-02T09:00:00Z') }),
          account: 'SL', country: 'LC' },
        // No account reference at all — the abandoned applications and the
        // paid lookups. Searchable by its own country, which it could not be
        // while the search reached only through the client relation.
        { ...v({ id: 'win-4', ref: null, status: 'VALID', price: 2,
                 ...at('2026-03-12T09:00:00Z') }), account: 'MU', country: 'ZW' },
      ]);

      const range = { from: '2026-03-01', to: '2026-03-31' };
      const march = await modules.kycCases({ ...range, limit: 500 });
      const ids = march.map((r) => r.verificationId);
      ok('a date range holds the days it names',
         ids.includes('win-1') && ids.includes('win-4'), ids.slice(0, 8));
      ok('including the whole of the last day, not just its midnight',
         ids.includes('win-2'), ids.slice(0, 8));
      ok('and nothing from the day after it',
         !ids.includes('win-3'), ids.slice(0, 8));

      const marchCount = await modules.kycCaseCount(range);
      ok('the count is of the same period as the page',
         marchCount.total === march.length,
         { counted: marchCount.total, page: march.length });

      const sl = await modules.kycCases({ ...range, account: 'SL', limit: 500 });
      ok('an entity filter returns only that entity',
         sl.length === 1 && sl[0].verificationId === 'win-2',
         sl.map((r) => r.verificationId));

      const byId = await modules.kycCases({ q: 'win-3', limit: 10 });
      ok('a verification id is searchable — it is how a row is found in their console',
         byId.length === 1 && byId[0].verificationId === 'win-3', byId.length);

      const byCountry = await modules.kycCases({ q: 'ZW', limit: 500 });
      ok('and a verification with no account is findable by its own country',
         byCountry.some((r) => r.verificationId === 'win-4'),
         byCountry.map((r) => r.verificationId));

      // The cards and the tiles read this, so it has to answer to the same
      // window the table does.
      const summary = await kyc.summary(range);
      ok('the summary counts the period, not the whole table',
         summary.verifications === march.length,
         { summary: summary.verifications, table: march.length });
      // Against the rows themselves rather than a hard-coded 14: earlier
      // sections put their own verifications in this month, and a number
      // written here would be asserting what those sections do.
      const spent = march.reduce((n, r) => n + (r.priceEur ?? 0), 0);
      ok('and its spend is that period’s spend',
         Math.abs(Number(summary.spentEur) - spent) < 1e-9,
         { summary: summary.spentEur, rows: spent });

      const slSummary = await kyc.summary({
        from: '2026-03-01', to: '2026-04-30', account: 'SL',
      });
      ok('one entity’s summary is that entity’s alone',
         slSummary.verifications === 2, slSummary.verifications);

      // THE THIRD CARD. Rows loaded before the account column existed have no
      // entity, and a card headed "Unattributed" beside Mauritius and Saint
      // Lucia read as a third brand. The count still exists — providerStatus
      // reports it — but it is not an entity.
      const accounts = await kyc.byAccount();
      ok('the entity cards are entities only, with no unattributed third',
         accounts.length > 0 && accounts.every((a) => a.form), accounts.map((a) => a.form));
      ok('while the fetch panel still reports what is unattributed',
         (await kyc.providerStatus()).unattributed > 0);
    }

    section('looking one applicant up, and the two ways it must refuse');
    {
      // The live lookup is the only call in this integration that returns a
      // named person, and nothing about it is stored. These are its refusals —
      // the network is never reached in either.
      const lookup = await prisma.kycCase.findFirst({
        where: { verificationId: 'chk-1' },
      });
      let msg = '';
      try { await kyc.applicantDetail(lookup.id); } catch (e) { msg = e.message; }
      // A SERVICE row is a paid database lookup, not a person. A 404 from the
      // provider would read as a deleted applicant instead of as a row that
      // never had one.
      ok('a verification with no applicant says why, rather than 404ing',
         /no applicant/i.test(msg), msg);

      const before = { ...process.env };
      process.env.KYCAID_API_TOKENMU = 'mu-token';
      process.env.KYCAID_API_TOKENSL = 'sl-token';
      delete process.env.KYCAID_API_TOKEN;

      const mu = await prisma.kycCase.findFirst({ where: { verificationId: 'mu-1' } });
      ok('a row records the account whose token can see it', mu.account === 'MU');

      await prisma.kycCase.update({
        where: { id: mu.id }, data: { account: 'ZZ', applicantId: 'app-mu-1' },
      });
      msg = '';
      try { await kyc.applicantDetail(mu.id); } catch (e) { msg = e.message; }
      // Asking the wrong entity's token returns 404 — which reads as a deleted
      // applicant rather than as the wrong credential. So it is refused here
      // instead, naming the variable to set.
      ok('an account with no token is refused before the provider is asked',
         /KYCAID_API_TOKENZZ/.test(msg), msg);
      await prisma.kycCase.update({
        where: { id: mu.id }, data: { account: 'MU' },
      });

      for (const k of Object.keys(process.env))
        if (/^KYCAID_API_TOKEN/.test(k)) delete process.env[k];
      Object.assign(process.env, before);
    }

    section('which checks passed, not merely which ones ran');
    {
      // `GET /verifications/{id}` is the only thing that answers this. The
      // stored row holds the list of checks and, separately, a decline reason
      // in the provider's vocabulary, with nothing joining them — so a rejected
      // application reads as five checks and one word, and nobody can say
      // whether the face matched.
      const parsed = readChecks({
        status: 'completed',
        verified: false,
        verifications: {
          profile: { verified: true },
          document: { verified: false, comment: 'Document has expired' },
          facial: { verified: true, comment: null },
          address: {},
        },
      });
      const by = Object.fromEntries(parsed.map((c) => [c.type, c]));
      ok('every check the provider named comes back', parsed.length === 4,
         parsed.map((c) => c.type));
      ok('a failed check carries the provider\'s own words',
         by.document.verified === false && /expired/i.test(by.document.comment),
         by.document);
      ok('a passed check is a pass with nothing said',
         by.profile.verified === true && by.profile.comment === null, by.profile);

      // THREE STATES, NOT TWO. A check with no verdict yet is not a failure,
      // and rendering it as one turns every half-finished verification on the
      // screen into a rejection.
      ok('a check with no verdict yet is neither a pass nor a failure',
         by.address.verified === null, by.address);

      // The shape is the form's, not a fixed list of five: an account that runs
      // a check this file has never seen must still show it.
      const novel = readChecks({ verifications: { crypto_screening: { verified: true } } });
      ok('a check nobody here has heard of is still reported',
         novel.length === 1 && novel[0].type === 'crypto_screening', novel);

      // A reply without the object at all — a pending verification, or a shape
      // change — is no checks, not a crash in a drawer.
      ok('a reply with no verdicts at all is empty rather than a throw',
         readChecks({ status: 'pending' }).length === 0);

      const before = { ...process.env };
      process.env.KYCAID_API_TOKENMU = 'mu-token';
      process.env.KYCAID_API_TOKENSL = 'sl-token';
      delete process.env.KYCAID_API_TOKEN;
      const mu = await prisma.kycCase.findFirst({ where: { verificationId: 'mu-1' } });
      await prisma.kycCase.update({ where: { id: mu.id }, data: { account: 'ZZ' } });
      let msg = '';
      try { await kyc.verificationChecks(mu.id); } catch (e) { msg = e.message; }
      // Same refusal as the applicant lookup, for the same reason: asking Saint
      // Lucia's token about a Mauritius verification returns 404, which reads
      // as a deleted record rather than as the wrong credential.
      ok('the checks lookup picks the row\'s own account, and names what is missing',
         /KYCAID_API_TOKENZZ/.test(msg), msg);
      await prisma.kycCase.update({ where: { id: mu.id }, data: { account: 'MU' } });

      msg = '';
      try { await kyc.verificationChecks('no-such-row'); } catch (e) { msg = e.message; }
      ok('a row that does not exist says so', /No such verification/i.test(msg), msg);

      for (const k of Object.keys(process.env))
        if (/^KYCAID_API_TOKEN/.test(k)) delete process.env[k];
      Object.assign(process.env, before);
    }

    section('what the direct reader refuses');
    {
      let msg = '';
      try {
        await kyc.syncFromProvider({ from: '2026-10-05', to: '2026-10-01',
                                     clients: [{ label: '', client: { forms: async () => new Map(), report: async () => [] } }] });
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
