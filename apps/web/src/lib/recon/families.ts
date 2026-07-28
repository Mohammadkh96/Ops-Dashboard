// Identifier families (union-find).
//
// A single payment can be referenced by several different identifiers: the CRM
// knows it by Psp Transaction ID / Order No / Merchant Trn Ref, the cashier by
// Reference ID / ID. Retries, underpayments and overpayments add more aliases
// that only overlap partially. Matching key-by-key misses those chains.
//
// Instead we union every identifier that appears together on any one row. The
// transitive closure is a "family" — one real-world payment attempt chain — so
// a CRM row and a cashier row land in the same family even when they share no
// single identifier directly, as long as something links them.

/** Normalises an identifier and rejects the usual junk placeholders. */
export function normKey(value: unknown): string {
  const key = String(value ?? "")
    .replace(/^['"]+|['"]+$/g, "")
    .trim()
    .toUpperCase()
    .replace(/\s+/g, "");
  if (!key) return "";
  const invalid = new Set(["NULL", "UNDEFINED", "NAN", "N/A", "NA", "NONE", "-", "0"]);
  return invalid.has(key) ? "" : key;
}

export function uniqueKeys(values: unknown[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  (values || []).forEach((v) => {
    const k = normKey(v);
    if (!k || seen.has(k)) return;
    seen.add(k);
    out.push(k);
  });
  return out;
}

export type Families = {
  /** Stable id of the family a set of keys belongs to ("" when none). */
  idForKeys: (keys: string[]) => string;
  /** Every alias known for the family reachable from these keys. */
  keysFor: (keys: string[]) => string[];
};

/**
 * Builds families from several key-groups. Each group is the set of
 * identifiers observed together on one source row.
 */
export function buildFamilies(keyGroups: string[][]): Families {
  const parent = new Map<string, string>();
  const rank = new Map<string, number>();

  const add = (k: string) => {
    if (!parent.has(k)) {
      parent.set(k, k);
      rank.set(k, 0);
    }
  };
  const find = (k: string): string => {
    add(k);
    let root = k;
    while (parent.get(root) !== root) root = parent.get(root)!;
    // path compression
    let cur = k;
    while (parent.get(cur) !== root) {
      const next = parent.get(cur)!;
      parent.set(cur, root);
      cur = next;
    }
    return root;
  };
  const union = (a: string, b: string) => {
    if (!a || !b) return;
    const ra = find(a);
    const rb = find(b);
    if (ra === rb) return;
    const nra = rank.get(ra)!;
    const nrb = rank.get(rb)!;
    if (nra < nrb) parent.set(ra, rb);
    else if (nra > nrb) parent.set(rb, ra);
    else {
      parent.set(rb, ra);
      rank.set(ra, nra + 1);
    }
  };

  keyGroups.forEach((group) => {
    const keys = uniqueKeys(group);
    if (!keys.length) return;
    keys.forEach(add);
    for (let i = 1; i < keys.length; i++) union(keys[0], keys[i]);
  });

  let membersByRoot: Map<string, string[]> | null = null;
  const members = () => {
    if (membersByRoot) return membersByRoot;
    const m = new Map<string, string[]>();
    parent.forEach((_v, k) => {
      const root = find(k);
      const arr = m.get(root) ?? [];
      arr.push(k);
      m.set(root, arr);
    });
    membersByRoot = m;
    return m;
  };

  return {
    idForKeys(keys: string[]) {
      const ks = uniqueKeys(keys);
      for (const k of ks) if (parent.has(k)) return find(k);
      return ks.length ? ks[0] : "";
    },
    keysFor(keys: string[]) {
      const ks = uniqueKeys(keys);
      const found = new Set<string>();
      const m = members();
      ks.forEach((k) => {
        if (parent.has(k)) (m.get(find(k)) ?? []).forEach((x) => found.add(x));
        else found.add(k);
      });
      return [...found];
    },
  };
}
