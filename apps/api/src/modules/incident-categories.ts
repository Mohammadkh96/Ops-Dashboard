/**
 * What kind of thing an incident is.
 *
 * The desk finds out what its categories are by running the desk. A list
 * written today is one somebody has to file a real incident under wrongly next
 * month, and "Other" is where the pattern that would have been worth naming
 * goes to be lost — so agents add their own, and the list grows out of what
 * actually happened.
 *
 * The whole thing turns on ONE rule: uniqueness is judged on a normalised form,
 * never on what was typed. "PSP outage", "PSP Outage" and "psp  outage" are one
 * category. Without that, a list meant to make incidents countable is the thing
 * that makes them uncountable, and it happens within a week because two people
 * type the same words differently.
 */

/** The tones a category may wear — names from the dashboard's palette. */
export const CATEGORY_TONES = [
  'blue',
  'green',
  'orange',
  'red',
  'magenta',
  'purple',
] as const;

export type CategoryTone = (typeof CATEGORY_TONES)[number];

/**
 * The key a category's identity is judged on.
 *
 * Case folded, punctuation dropped, runs of whitespace squashed to one hyphen.
 * Deliberately lossy: it exists to make near-identical names collide, which is
 * the opposite of what an id normally wants.
 */
export function categorySlug(name: string): string {
  return (
    name
      .normalize('NFKD')
      // Strip combining marks, so "Réseau" and "Reseau" do not become two
      // categories. Written as an escape rather than the characters themselves,
      // which are invisible in an editor and get lost in a copy-paste.
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
  );
}

/**
 * A name as it will be stored and shown.
 *
 * Trimmed and inner whitespace squashed — nothing else. The capitalisation
 * somebody chose is theirs: "MT5" title-cased to "Mt5" is a product name
 * spelled wrong on every incident from then on.
 */
export function tidyCategoryName(name: string): string {
  return name.trim().replace(/\s+/g, ' ');
}

/** How long a category name may be. Long enough to be clear, short enough for a chip. */
export const MAX_CATEGORY_NAME = 40;

export type CategoryProblem = 'empty' | 'too-long' | 'unusable';

/**
 * Whether a proposed name can become a category.
 *
 * Refuses a name whose slug is empty — "???" and "———" pass a length check and
 * then collide with every other punctuation-only name ever typed.
 */
export function checkCategoryName(
  raw: string,
):
  | { ok: true; name: string; slug: string }
  | { ok: false; why: CategoryProblem } {
  const name = tidyCategoryName(raw ?? '');
  if (!name) return { ok: false, why: 'empty' };
  if (name.length > MAX_CATEGORY_NAME) return { ok: false, why: 'too-long' };
  const slug = categorySlug(name);
  if (!slug) return { ok: false, why: 'unusable' };
  return { ok: true, name, slug };
}

/** Why a name was refused, in words the person who typed it can act on. */
export function categoryProblemMessage(why: CategoryProblem): string {
  switch (why) {
    case 'empty':
      return 'A category needs a name.';
    case 'too-long':
      return `Keep it under ${MAX_CATEGORY_NAME} characters — it has to fit on a chip beside the incident.`;
    case 'unusable':
      return 'That name is only punctuation. Use some letters or numbers so it can be told apart from the others.';
  }
}

/**
 * A tone for a new category, from its own name.
 *
 * Derived rather than random, so the same category always looks the same, and
 * so two people adding "MT5" on different machines get the same chip. Nobody is
 * asked to pick a colour: a colour picker on this form is how a category ends
 * up unreadable in one of the two themes.
 */
export function toneFor(slug: string): CategoryTone {
  let hash = 0;
  for (let i = 0; i < slug.length; i++) {
    hash = (hash * 31 + slug.charCodeAt(i)) >>> 0;
  }
  return CATEGORY_TONES[hash % CATEGORY_TONES.length];
}

/**
 * The categories a brokerage payments desk starts with.
 *
 * A starting point, not a schema: every one of these can be retired, and the
 * list is expected to be outgrown. They exist so the first person to declare an
 * incident is choosing from something rather than inventing a vocabulary at the
 * moment they are least able to — during an incident.
 */
export const STARTER_CATEGORIES = [
  'PSP outage',
  'Deposits',
  'Withdrawals',
  'Card declines',
  'Chargeback / dispute',
  'KYC / compliance',
  'MT5 / trading platform',
  'CRM',
  'Reconciliation',
  'Suspected fraud',
  'Vendor / third party',
  'Internal error',
] as const;
