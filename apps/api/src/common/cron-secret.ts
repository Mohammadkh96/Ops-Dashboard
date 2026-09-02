import { timingSafeEqual } from 'node:crypto';

import { UnauthorizedException } from '@nestjs/common';

/**
 * The guard on endpoints a scheduler calls.
 *
 * Vercel Cron issues a plain GET and cannot carry a session, so these routes
 * sit outside the JWT guard entirely — which makes them the only unauthenticated
 * way to reach code that spends live payment credentials. The secret is the
 * whole of their protection.
 *
 * Shared rather than written per controller: this is a security primitive, and
 * two copies of one is how the two copies drift apart.
 */

/** Constant-time compare, so a wrong secret cannot be discovered byte by byte. */
export function secretMatches(presented: string, expected: string): boolean {
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  // timingSafeEqual throws on a length mismatch, which would itself leak length.
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Refuses unless the caller presented CRON_SECRET.
 *
 * REFUSES OUTRIGHT when the variable is unset, rather than defaulting to open.
 * An unset secret on a route that makes outbound calls with live payment keys
 * would be an unauthenticated endpoint that anybody who guessed the path could
 * fire, and "we forgot to set it" is the most likely way that happens.
 */
export function assertCronSecret(auth?: string): void {
  const expected = process.env.CRON_SECRET;
  if (!expected) {
    throw new UnauthorizedException('CRON_SECRET is not configured');
  }
  // Vercel presents it as `Authorization: Bearer <secret>`.
  const presented = (auth ?? '').replace(/^Bearer\s+/i, '');
  if (!presented || !secretMatches(presented, expected)) {
    throw new UnauthorizedException('invalid cron secret');
  }
}
