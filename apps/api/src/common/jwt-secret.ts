/**
 * The key session tokens are signed with.
 *
 * This used to fall back to a constant in the source — `dev-only-change-me` —
 * whenever JWT_SECRET was unset. That is comfortable locally and indefensible
 * anywhere else: the fallback is readable by anyone with the repository, so a
 * deployment missing the variable will happily accept a token that a stranger
 * signed for themselves, against live payment records, and look completely
 * normal while doing it. A missing secret is not a small configuration gap, so
 * it now stops the API instead of being papered over.
 *
 * Outside production the fallback stays, because requiring a secret to run the
 * test suite buys nothing.
 */
export function jwtSecret(): string {
  const configured = process.env.JWT_SECRET?.trim();
  if (configured) return configured;

  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      'JWT_SECRET is not set. Set it to a long random string in the API environment — ' +
        'without it, session tokens would be signed with a value published in the source.',
    );
  }
  return 'dev-only-change-me';
}
