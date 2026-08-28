// How incident categories are told apart — pinned.
//
// A category list exists to make incidents countable. The way it stops doing
// that is not dramatic: two people type the same words slightly differently,
// both spellings get their own row, and every count computed over categories is
// quietly wrong from that day on. Nobody notices, because both rows look right.
//
// So the normalisation is the feature, and this is where it is held down.
//
//   npx tsx scripts/check-incident-categories.ts

import {
  categorySlug,
  checkCategoryName,
  MAX_CATEGORY_NAME,
  STARTER_CATEGORIES,
  tidyCategoryName,
  toneFor,
  CATEGORY_TONES,
} from '../src/modules/incident-categories';

let failures = 0;
function ok(name: string, cond: boolean, detail?: unknown) {
  if (cond) console.log(`ok    ${name}`);
  else {
    failures++;
    console.log(
      `FAIL  ${name} ${detail === undefined ? '' : JSON.stringify(detail)}`,
    );
  }
}
const section = (t: string) => console.log(`\n── ${t} ──`);

/** Whether two names would land on the same category. */
const same = (a: string, b: string) => categorySlug(a) === categorySlug(b);

section('the same category, typed differently');
{
  // The real one. Three people, one outage, one category.
  ok('case does not matter', same('PSP outage', 'psp outage'));
  ok('title case does not matter', same('PSP outage', 'PSP Outage'));
  ok('double spaces do not matter', same('PSP  outage', 'PSP outage'));
  ok('leading and trailing space does not matter', same('  PSP outage  ', 'PSP outage'));
  ok('a hyphen reads as a space', same('PSP-outage', 'PSP outage'));
  ok('a slash reads as a space', same('KYC / compliance', 'KYC compliance'));
  ok('an ampersand does not split it', same('Vendor & third party', 'Vendor third party'));
  // Somebody typing with an Arabic or French keyboard layout should not create
  // a second "Reseau".
  ok('accents fold away', same('Réseau', 'Reseau'));
  ok('a trailing full stop does not matter', same('MT5.', 'MT5'));
}

section('genuinely different categories stay different');
{
  // The opposite failure: normalising so hard that two real categories merge.
  ok('deposits and withdrawals are not the same', !same('Deposits', 'Withdrawals'));
  ok('MT5 and MT4 are not the same', !same('MT5', 'MT4'));
  ok('numbers are kept', categorySlug('SEV1 escalation').includes('1'));
  ok(
    'a word that only differs by a number survives',
    !same('PSP outage 1', 'PSP outage 2'),
  );
}

section('what a name is stored as');
{
  // The slug is lossy on purpose. The NAME is not — it is what people read.
  ok('the typed capitalisation is kept', tidyCategoryName('MT5 / trading') === 'MT5 / trading');
  // Title-casing here would spell a product name wrong on every incident from
  // then on: "MT5" becomes "Mt5" and stays that way.
  ok('nothing is title-cased', tidyCategoryName('MT5') === 'MT5');
  ok('outer space is trimmed', tidyCategoryName('  Deposits ') === 'Deposits');
  ok('inner runs are squashed', tidyCategoryName('Card   declines') === 'Card declines');
}

section('names that cannot become a category');
{
  const bad = (s: string) => {
    const r = checkCategoryName(s);
    return r.ok ? null : r.why;
  };
  ok('empty is refused', bad('') === 'empty');
  ok('whitespace only is refused', bad('   ') === 'empty');
  // These pass a length check and then collide with every other
  // punctuation-only name ever typed — one category called "???" and "———".
  ok('punctuation only is refused', bad('???') === 'unusable');
  ok('dashes only are refused', bad('---') === 'unusable');
  ok('emoji only are refused', bad('🔥🔥') === 'unusable');
  ok(
    'over-long is refused',
    bad('x'.repeat(MAX_CATEGORY_NAME + 1)) === 'too-long',
  );
  ok('exactly at the limit is allowed', bad('x'.repeat(MAX_CATEGORY_NAME)) === null);
  // An emoji beside real words is fine — it is the name being ONLY unusable
  // characters that is the problem.
  ok('an emoji beside words is allowed', bad('🔥 PSP outage') === null);
}

section('tones');
{
  ok(
    'every category gets one from the palette',
    STARTER_CATEGORIES.every((n) =>
      (CATEGORY_TONES as readonly string[]).includes(toneFor(categorySlug(n))),
    ),
  );
  // Derived, not random: two people adding "MT5" on different machines, or the
  // same category re-seeded, must not produce a chip that changes colour.
  ok('the same name always gets the same tone', toneFor('mt5') === toneFor('mt5'));
  ok(
    'and it does not depend on when it was made',
    toneFor(categorySlug('PSP outage')) === toneFor(categorySlug('psp  OUTAGE')),
  );
  const used = new Set(
    STARTER_CATEGORIES.map((n) => toneFor(categorySlug(n))),
  );
  // Not a correctness requirement, but a picker where everything is one colour
  // is a picker where the colour tells you nothing.
  ok('the starter set spreads across several tones', used.size >= 4, [...used]);
}

section('the starter set itself');
{
  const slugs = STARTER_CATEGORIES.map(categorySlug);
  ok('every one has a usable slug', slugs.every(Boolean));
  ok(
    'no two collide with each other',
    new Set(slugs).size === slugs.length,
    slugs.filter((s, i) => slugs.indexOf(s) !== i),
  );
  ok(
    'every one fits on a chip',
    STARTER_CATEGORIES.every((n) => n.length <= MAX_CATEGORY_NAME),
    STARTER_CATEGORIES.filter((n) => n.length > MAX_CATEGORY_NAME),
  );
}

console.log(
  failures ? `\n${failures} check(s) failed.` : '\nAll category checks passed.',
);
process.exit(failures ? 1 : 0);
