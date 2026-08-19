/**
 * Which browser origins may call this API.
 *
 * Shared rather than inlined in the bootstrap: the health endpoint reports the
 * same verdict back to the caller, and a second copy of the matching rule would
 * eventually disagree with the one actually enforcing it — which is the worst
 * possible outcome for a diagnostic.
 */

/**
 * Used when WEB_ORIGIN is unset.
 *
 * An unset variable previously meant "http://localhost:3000 only", so a deployed
 * API refused every browser on earth while looking perfectly healthy to curl and
 * to its own health check. That is a configuration mistake worth surviving: the
 * dashboard is a Vercel static export, so admitting Vercel-hosted origins gets a
 * fresh deployment working, and the boot log says loudly that this is a
 * fallback. Set WEB_ORIGIN to the real dashboard URL and this list is ignored.
 */
export const FALLBACK_ORIGINS = ['http://localhost:3000', '*.vercel.app'];

export function configuredOrigins(): string[] {
  return (process.env.WEB_ORIGIN ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

export function allowedOrigins(): string[] {
  const configured = configuredOrigins();
  return configured.length ? configured : FALLBACK_ORIGINS;
}

/**
 * A leading "*" matches by suffix, which lets an entry be scoped to one Vercel
 * team rather than the whole platform. Preview URLs are shaped
 * "<project>-<hash>-<team>.vercel.app", so "*-yourteam.vercel.app" admits your
 * own previews while "*.vercel.app" admits everybody's.
 */
export function isOriginAllowed(origin: string, allowed = allowedOrigins()): boolean {
  return allowed.some((a) =>
    a.startsWith('*') ? origin.endsWith(a.slice(1)) : a === origin,
  );
}
