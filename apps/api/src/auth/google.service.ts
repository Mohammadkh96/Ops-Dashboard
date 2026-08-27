import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { randomBytes } from 'node:crypto';

import { PrismaService } from '../prisma/prisma.service';

/**
 * Signing in with a company Google account.
 *
 * The authorisation-code flow, exchanged server to server. That choice decides
 * the security properties, so it is worth being explicit about them:
 *
 *   • THE ID TOKEN IS NOT SIGNATURE-VERIFIED, DELIBERATELY. It is fetched by
 *     this server directly from Google's token endpoint over TLS, in response
 *     to a code this server was given. It never passes through the browser, so
 *     there is nobody in between to forge it — which is exactly the case
 *     Google's own documentation says may skip verification. The claims are
 *     still checked, because a genuine token for the WRONG audience or the
 *     wrong domain is the real risk, not a forged one.
 *
 *   • THE HOSTED DOMAIN IS CHECKED HERE, not trusted from the `hd` parameter
 *     sent to Google. That parameter is a hint to the account chooser and
 *     nothing more: anybody can start this flow with it removed. The `hd`
 *     CLAIM, in a token Google issued, is the actual control.
 *
 *   • STATE IS A SIGNED TOKEN rather than a session value. There is no session
 *     to put it in — this runs on a serverless host where the callback may
 *     land on a different instance from the redirect — so it is signed with
 *     the same secret as everything else and expires in ten minutes.
 */
@Injectable()
export class GoogleAuthService {
  private readonly log = new Logger(GoogleAuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
  ) {}

  get configured(): boolean {
    return Boolean(
      process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET,
    );
  }

  /**
   * Domains whose accounts may sign in.
   *
   * There is no default and no empty-means-everyone: an unset list refuses
   * every sign-in rather than admitting every Google account on earth.
   */
  private get allowedDomains(): string[] {
    return (process.env.GOOGLE_ALLOWED_DOMAINS ?? '')
      .split(',')
      .map((d) => d.trim().toLowerCase())
      .filter(Boolean);
  }

  private get redirectUri(): string {
    const explicit = process.env.GOOGLE_REDIRECT_URI;
    if (explicit) return explicit;
    const base = (process.env.API_PUBLIC_URL ?? '').replace(/\/$/, '');
    return base ? `${base}/api/auth/google/callback` : '';
  }

  /** Where the browser is sent to sign in. */
  authorizeUrl(returnTo?: string): string {
    if (!this.configured) {
      throw new ServiceUnavailableException(
        'Google sign-in is not configured. Set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and GOOGLE_ALLOWED_DOMAINS in the API environment.',
      );
    }
    if (!this.redirectUri) {
      throw new ServiceUnavailableException(
        'Google sign-in has no redirect URI. Set API_PUBLIC_URL (or GOOGLE_REDIRECT_URI) so the callback address matches the one registered with Google.',
      );
    }

    const state = this.jwt.sign(
      { n: randomBytes(12).toString('hex'), returnTo: returnTo ?? '/' },
      { expiresIn: '10m' },
    );

    const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    url.searchParams.set('client_id', process.env.GOOGLE_CLIENT_ID as string);
    url.searchParams.set('redirect_uri', this.redirectUri);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('scope', 'openid email profile');
    url.searchParams.set('state', state);
    // A hint to the account chooser so people land on their work account, not
    // a security control — the claim is checked on the way back.
    const domains = this.allowedDomains;
    if (domains.length === 1) url.searchParams.set('hd', domains[0]);
    // Always ask, so somebody signed into a personal account is not silently
    // bounced with an error they cannot act on.
    url.searchParams.set('prompt', 'select_account');
    return url.toString();
  }

  /** Reads the state back, or refuses. */
  verifyState(state?: string): { returnTo: string } {
    if (!state) throw new BadRequestException('Missing sign-in state.');
    try {
      const payload = this.jwt.verify<{ returnTo?: string }>(state);
      const returnTo = payload.returnTo ?? '/';
      // Only a path, never an absolute URL: a state token is attacker-supplied
      // if they can get somebody to start the flow, and an open redirect on the
      // end of a sign-in is how a session token gets handed to a stranger.
      return {
        returnTo:
          returnTo.startsWith('/') && !returnTo.startsWith('//')
            ? returnTo
            : '/',
      };
    } catch {
      throw new BadRequestException(
        'This sign-in link has expired or was not issued here. Start again.',
      );
    }
  }

  /**
   * Exchanges the code, checks the claims, and returns our own session token.
   */
  async completeSignIn(code: string): Promise<{
    accessToken: string;
    user: { id: string; email: string; role: string };
  }> {
    const res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: process.env.GOOGLE_CLIENT_ID as string,
        client_secret: process.env.GOOGLE_CLIENT_SECRET as string,
        redirect_uri: this.redirectUri,
        grant_type: 'authorization_code',
      }),
      signal: AbortSignal.timeout(15_000),
    }).catch((e: unknown) => {
      throw new ServiceUnavailableException(
        `Could not reach Google: ${e instanceof Error ? e.message : String(e)}`,
      );
    });

    if (!res.ok) {
      const body = await res.text();
      this.log.error(
        `Google token exchange failed: ${res.status} ${body.slice(0, 300)}`,
      );
      throw new BadRequestException(
        'Google refused the sign-in. If this keeps happening, check that the redirect URI registered with Google matches this API exactly.',
      );
    }

    const tokens = (await res.json()) as { id_token?: string };
    if (!tokens.id_token) {
      throw new BadRequestException('Google returned no identity token.');
    }

    const claims = decodeIdToken(tokens.id_token);
    checkGoogleClaims(claims, {
      clientId: process.env.GOOGLE_CLIENT_ID,
      domains: this.allowedDomains,
    });

    const email = (claims.email ?? '').toLowerCase();
    const user = await this.findOrCreate(email, claims);

    return {
      accessToken: await this.jwt.signAsync({
        sub: user.id,
        email: user.email,
        role: user.role,
      }),
      user: { id: user.id, email: user.email, role: user.role },
    };
  }

  /**
   * Finds the person, or creates them.
   *
   * An EXISTING account keeps its role — signing in with Google is a new door
   * into the same account, not a new account, and it must never quietly demote
   * an administrator to whatever the default is.
   *
   * A NEW one is created at GOOGLE_DEFAULT_ROLE, which defaults to READ_ONLY.
   * Everyone in the company can reach this door, so the default has to be the
   * one that grants nothing; an administrator promotes them deliberately.
   */
  private async findOrCreate(email: string, claims: GoogleClaims) {
    const existing = await this.prisma.user.findUnique({ where: { email } });
    if (existing) {
      if (!existing.isActive) {
        throw new ForbiddenException(
          'That account is deactivated here. Ask an administrator to re-enable it.',
        );
      }
      // Record the link on first Google sign-in, so it is visible later which
      // accounts can use this door.
      if (!existing.googleId && claims.sub) {
        await this.prisma.user
          .update({
            where: { id: existing.id },
            data: { googleId: claims.sub },
          })
          .catch(() => undefined);
      }
      return existing;
    }

    const role = process.env.GOOGLE_DEFAULT_ROLE ?? 'READ_ONLY';
    const [first, ...rest] = (claims.name ?? email.split('@')[0]).split(' ');
    const created = await this.prisma.user.create({
      data: {
        email,
        firstName: claims.given_name || first || email.split('@')[0],
        lastName: claims.family_name || rest.join(' ') || '',
        // No password, and none that can ever match: bcrypt.compare against
        // random text fails for every input, so this account can only be
        // reached through Google.
        passwordHash: `google-only:${randomBytes(24).toString('hex')}`,
        googleId: claims.sub ?? null,
        role: role as never,
      },
    });
    this.log.log(`Created ${email} from Google sign-in as ${role}`);
    return created;
  }
}

export type GoogleClaims = {
  iss?: string;
  aud?: string;
  sub?: string;
  exp?: number;
  email?: string;
  email_verified?: boolean;
  hd?: string;
  name?: string;
  given_name?: string;
  family_name?: string;
};

/**
 * Everything that decides whether a genuine Google token may sign somebody in.
 *
 * A free function, not a method, because this is the whole security boundary of
 * Google sign-in and it should be checkable on its own — see
 * `scripts/check-google-claims.ts`. Nothing here reads the environment or the
 * database, so a test can state the case and read the answer.
 *
 * Every one of these refusals is a token Google really did issue. Forgery is
 * not the risk here (the token came straight from Google's token endpoint over
 * TLS); the risk is a real token that belongs to somebody else's application,
 * or somebody else's company, being spent here.
 */
export function checkGoogleClaims(
  c: GoogleClaims,
  cfg: { clientId?: string; domains: string[]; now?: number },
): void {
  const now = cfg.now ?? Math.floor(Date.now() / 1000);

  if (!cfg.clientId || c.aud !== cfg.clientId) {
    // A perfectly genuine Google token issued for a DIFFERENT application.
    // Without this check, anyone who can run a Google app could hand this API a
    // real, valid, correctly-signed token and be let in.
    throw new ForbiddenException(
      'That identity token was issued for another application.',
    );
  }
  if (
    !['accounts.google.com', 'https://accounts.google.com'].includes(
      c.iss ?? '',
    )
  ) {
    throw new ForbiddenException('Unexpected token issuer.');
  }
  if (!c.exp || c.exp < now) {
    throw new BadRequestException('That sign-in has expired. Try again.');
  }
  if (!c.email) {
    throw new ForbiddenException('Google did not return an email address.');
  }
  if (c.email_verified === false) {
    throw new ForbiddenException(
      'That Google account has an unverified email address.',
    );
  }

  if (!cfg.domains.length) {
    // Refusing everybody is the safe half of a half-configuration. An empty
    // list must never read as "no restriction", which would admit every Google
    // account in existence.
    throw new ServiceUnavailableException(
      'Google sign-in is half-configured: GOOGLE_ALLOWED_DOMAINS is empty, so every account would be refused. Set it to your company domain.',
    );
  }
  // The hd CLAIM, not the hd parameter sent to Google — that one is a hint to
  // the account chooser and anybody can start the flow without it. A personal
  // gmail.com account carries no hd at all, which is exactly how it is refused.
  //
  // Both halves are checked: hd says which Workspace issued the account, the
  // address says who it belongs to, and a Workspace can hold addresses at
  // domains it does not own.
  const hd = (c.hd ?? '').toLowerCase();
  const emailDomain = c.email.split('@')[1]?.toLowerCase() ?? '';
  if (!cfg.domains.includes(hd) || !cfg.domains.includes(emailDomain)) {
    throw new ForbiddenException(
      `${c.email} is not a ${cfg.domains.join(' or ')} account. Sign in with your work account.`,
    );
  }
}

/**
 * Reads the claims out of an ID token.
 *
 * No signature check — see the note at the top of this file. This token came
 * straight from Google's token endpoint over TLS in response to our own code
 * exchange, so there is no untrusted party between us and the issuer. Every
 * claim that matters is checked in checkClaims.
 */
export function decodeIdToken(idToken: string): GoogleClaims {
  const part = idToken.split('.')[1];
  if (!part) throw new BadRequestException('Malformed identity token.');
  try {
    return JSON.parse(
      Buffer.from(
        part.replace(/-/g, '+').replace(/_/g, '/'),
        'base64',
      ).toString('utf8'),
    ) as GoogleClaims;
  } catch {
    throw new BadRequestException('Unreadable identity token.');
  }
}
