/**
 * Reading the fields of a provider's own record, whatever shape it arrived in.
 *
 * Its own file rather than a corner of the sync service because two things now
 * need it and they already point at each other: the sync lists the fields a
 * provider sends so somebody can map a column, and the balance searches those
 * same fields for the one that explains a gap. A shared import in a third file
 * is the alternative to a cycle.
 */

/**
 * Every leaf in a record, as a dotted path.
 *
 * Depth-limited and array-summarised: a provider's record can nest, but a
 * column mapped twelve levels into the third element of an array is not a
 * column anybody is going to configure, and listing them all would bury the
 * dozen that matter.
 */
export function flatten(
  value: unknown,
  prefix = '',
  depth = 0,
): [string, unknown][] {
  if (depth > 2 || value === null || typeof value !== 'object') {
    return prefix ? [[prefix, value]] : [];
  }
  if (Array.isArray(value)) {
    // The first element stands for the array: the shape repeats, and the path
    // that is useful is the one into element zero.
    return value.length ? flatten(value[0], `${prefix}.0`, depth + 1) : [];
  }
  return Object.entries(value as Record<string, unknown>).flatMap(([k, v]) =>
    flatten(v, prefix ? `${prefix}.${k}` : k, depth + 1),
  );
}

/**
 * A field's value as a number, or null when it is not one.
 *
 * Stricter than the connector's parser on purpose. That one strips separators
 * so a provider's "1,234.56" reads as a number, which is right when a person
 * has SAID this field is the amount. Here nothing has been said: the whole
 * point is to try every field, and a lenient parser turns "USD-2024-11" into a
 * number and puts it in a list of candidate fee columns.
 */
export function asNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string') return null;
  const t = value.trim();
  if (!t || !/^-?\d+(\.\d+)?$/.test(t)) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

/** One field summed across a set of records. */
export type FieldTotal = {
  path: string;
  /** The sum over every record where the field parsed as a number. */
  total: number;
  /** How many records had a number in it. */
  rows: number;
  /** How many of those were not zero — a field of zeros explains nothing. */
  nonZero: number;
};

/**
 * Every numeric field in a set of records, summed.
 *
 * The search space for "what is this gap made of". A provider that deducts a
 * fee reports it, somewhere, on the record of the payment it was deducted
 * from — so if the ledger is complete then the missing money is already in the
 * database under a field name nobody has mapped, and the sum of the right field
 * equals the gap. That turns a question with no evidence into one with an
 * answer that can be checked.
 */
export function numericTotals(records: unknown[]): FieldTotal[] {
  const seen = new Map<
    string,
    { total: number; rows: number; nonZero: number }
  >();

  for (const record of records) {
    for (const [path, raw] of flatten(record)) {
      const n = asNumber(raw);
      if (n === null) continue;
      const at = seen.get(path) ?? { total: 0, rows: 0, nonZero: 0 };
      at.total += n;
      at.rows++;
      if (n !== 0) at.nonZero++;
      seen.set(path, at);
    }
  }

  return [...seen.entries()]
    .map(([path, v]) => ({
      path,
      total: v.total,
      rows: v.rows,
      nonZero: v.nonZero,
    }))
    .sort((a, b) => a.path.localeCompare(b.path));
}
