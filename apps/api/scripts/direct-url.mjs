/**
 * The connection a MIGRATION must use, which is not the one the API uses.
 *
 * `prisma migrate deploy` takes a postgres advisory lock so two concurrent
 * builds cannot apply the same migration twice. An advisory lock belongs to a
 * SESSION — and a connection pooler in transaction mode hands the next
 * statement to whichever backend is free, so the lock is taken on one
 * connection and looked for on another. It is never found, and the deploy dies
 * after ten seconds with P1002 "the database server was reached but timed out".
 *
 * The runtime is right to use the pooler: this API runs as serverless
 * functions, where a direct connection per invocation exhausts the database's
 * connection limit. So the two needs genuinely differ, and only the migration
 * is moved.
 *
 * Set DIRECT_URL to be explicit. Failing that, Neon's direct host is its pooled
 * host without the `-pooler` suffix, and deriving it means this works without
 * anybody having to add a second environment variable to a deploy that is
 * already failing.
 */

/**
 * @param {NodeJS.ProcessEnv} env
 * @returns {{ url: string | undefined, host: string, why: string }}
 */
export function migrationUrl(env = process.env) {
  const explicit = env.DIRECT_URL || env.MIGRATE_DATABASE_URL;
  if (explicit) {
    return { url: explicit, host: hostOf(explicit), why: 'DIRECT_URL' };
  }

  const pooled = env.DATABASE_URL;
  if (!pooled) return { url: undefined, host: '', why: 'nothing configured' };

  let parsed;
  try {
    parsed = new URL(pooled);
  } catch {
    // Not something we can rewrite. Hand it back untouched rather than
    // guessing — a mangled connection string fails far more confusingly than
    // the advisory-lock timeout it would be trying to avoid.
    return { url: pooled, host: 'the configured database', why: 'unparseable' };
  }

  // Only the `-pooler` suffix, and only where it is actually there. Any other
  // host is left exactly as it is: this rewrite is a Neon convention, not a
  // general rule about connection strings.
  if (!parsed.hostname.includes('-pooler.')) {
    return { url: pooled, host: parsed.host, why: 'not a pooled host' };
  }
  parsed.hostname = parsed.hostname.replace('-pooler.', '.');
  // PgBouncer flags mean nothing to a direct connection and one of them —
  // pgbouncer=true — is what tells Prisma to behave as though the lock cannot
  // be held.
  parsed.searchParams.delete('pgbouncer');
  parsed.searchParams.delete('connection_limit');
  parsed.searchParams.delete('pool_timeout');
  return {
    url: parsed.toString(),
    host: parsed.host,
    why: 'derived from DATABASE_URL by dropping -pooler',
  };
}

function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return 'the configured database';
  }
}
