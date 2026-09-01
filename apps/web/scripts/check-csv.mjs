// Reading a CSV a payment provider's portal produced.
//
// Every case here is one a real export contains, and every one of them turns
// a naive split(",") into silently wrong data rather than an error — which is
// the dangerous kind, because the import "succeeds".
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Resolved from this file, so the check runs the same from apps/web or from
// the repo root.
const SRC = join(fileURLToPath(new URL('.', import.meta.url)), '../src/lib/csv.ts');

// Compiled by the real compiler rather than stripped by hand — a check that
// tests a mangled copy of the source is testing the mangling.
const dir = mkdtempSync(join(tmpdir(), 'csv-'));
execSync(
  `npx tsc ${SRC} --outDir ${dir} --target es2022 --module esnext --moduleResolution bundler`,
  { stdio: 'pipe' },
);
const compiled = join(dir, 'csv.js');
writeFileSync(compiled.replace(/\.js$/, '.mjs'), readFileSync(compiled, 'utf8'));
const { parseCsv } = await import(compiled.replace(/\.js$/, '.mjs'));

let failures = 0;
const ok = (n, c, d) => {
  if (c) console.log(`ok    ${n}`);
  else { failures++; console.log(`FAIL  ${n} ${d === undefined ? '' : JSON.stringify(d)}`); }
};
const section = (t) => console.log(`\n── ${t} ──`);

section('an ordinary export');
{
  const rows = parseCsv(
    'Payment ID,Type,Final amount,Final currency\n' +
    'a5c740a6,DEPOSIT,100,USD\n' +
    'd1bb25c7,WITHDRAW,10,USD\n',
  );
  ok('both records are read', rows.length === 2, rows);
  ok('by heading', rows[0]['Payment ID'] === 'a5c740a6');
  ok('and the last column too', rows[1]['Final currency'] === 'USD');
}

section('the things that break a naive split');
{
  // A customer name with a comma. Without quote handling every column after
  // it shifts by one — and the import succeeds, with the amount in the
  // currency column.
  const rows = parseCsv(
    'id,name,amount\n1,"Arivalagan, Ananthan",9.99\n',
  );
  ok('a comma inside quotes is not a separator', rows[0].name === 'Arivalagan, Ananthan', rows[0]);
  ok('and the column after it is intact', rows[0].amount === '9.99', rows[0]);

  const q = parseCsv('id,note\n1,"he said ""yes"""\n');
  ok('a doubled quote is one quote', q[0].note === 'he said "yes"', q[0]);

  // An address field with a line break in it. Without this the row splits in
  // two and half a transaction is imported as a whole one.
  const nl = parseCsv('id,address\n1,"KARUVAN STREET\nKulamangalam South"\n');
  ok('a newline inside quotes stays in the field', nl.length === 1, nl);
  ok('with both lines', /KARUVAN STREET\nKulamangalam/.test(nl[0].address), nl[0]);
}

section('what every Windows export has');
{
  const crlf = parseCsv('id,amount\r\n1,10\r\n2,20\r\n');
  ok('CRLF ends a row once', crlf.length === 2, crlf);
  ok('and leaves no stray carriage return', crlf[0].amount === '10', crlf[0]);

  // Excel writes a BOM. Without stripping it the first column is named
  // "﻿id", every mapping onto "id" misses, and the id comes out null —
  // which the importer then rejects as a row with no identity.
  const bom = parseCsv('﻿id,amount\n1,10\n');
  ok('a byte order mark is not part of the first heading', bom[0].id === '1', Object.keys(bom[0]));
}

section('edges that must not become phantom rows');
{
  ok('a trailing blank line is not a record', parseCsv('id\n1\n\n').length === 1);
  ok('a file of only headings has no records', parseCsv('id,amount\n').length === 0);
  ok('an empty file has none', parseCsv('').length === 0);
  const missing = parseCsv('id,amount,currency\n1,10\n');
  ok('a short row fills the rest empty', missing[0].currency === '', missing[0]);
}

console.log(failures ? `\n${failures} check(s) failed.` : '\nAll CSV checks passed.');
process.exit(failures ? 1 : 0);
