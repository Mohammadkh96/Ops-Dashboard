import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';

import { AdminLockService } from '../admin-lock.service';

/**
 * Requires the Admin tab to be unlocked, not merely signed in.
 *
 * ENFORCED HERE, on the server, which is the only place it counts. Hiding the
 * tab in the browser until a passphrase is typed is a decoration: the routes
 * underneath answer to anybody who can type a URL, and a dashboard that looks
 * locked while its API is open is worse than one that never claimed to be
 * locked at all.
 *
 * The elevated token travels in its own header rather than replacing the
 * session in Authorization. Both are needed — the session says who you are, the
 * unlock says you took the extra step just now — and sending only the second
 * one must never be a way to skip the first.
 */
@Injectable()
export class AdminUnlockGuard implements CanActivate {
  constructor(private readonly lock: AdminLockService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<{
      headers: Record<string, string | string[] | undefined>;
      user?: { userId?: string };
      adminUnlock?: { userId: string; email: string };
    }>();

    const raw = req.headers['x-admin-token'];
    const token = Array.isArray(raw) ? raw[0] : raw;
    const elevated = await this.lock.verifyElevated(token);

    // The unlock has to belong to the person holding the session. Otherwise an
    // administrator's elevated token, copied out of one browser, would raise
    // anybody else's session — the two halves have to be the same person.
    if (req.user?.userId && req.user.userId !== elevated.userId) {
      throw new ForbiddenException(
        'That admin unlock belongs to a different account. Unlock again with this one.',
      );
    }

    req.adminUnlock = elevated;
    return true;
  }
}
