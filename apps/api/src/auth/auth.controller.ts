import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpException,
  Param,
  Post,
  Query,
  Request,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiExcludeEndpoint, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';

import { AdminLockService } from './admin-lock.service';
import { AuthService } from './auth.service';
import { GoogleAuthService } from './google.service';
import { LoginDto } from './dto/login.dto';
import { AdminUnlockGuard } from './guards/admin-unlock.guard';
import { JwtAuthGuard } from './guards/jwt-auth.guard';

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly google: GoogleAuthService,
    private readonly adminLock: AdminLockService,
  ) {}

  @Post('login')
  login(@Body() dto: LoginDto) {
    return this.authService.login(dto.email, dto.password);
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @Get('me')
  me(
    @Request() req: { user: { userId: string; email: string; role: string } },
  ) {
    return req.user;
  }

  // ── the admin lock ────────────────────────────────────────────────────
  //
  // A second password in front of the Admin tab. Being signed in and being able
  // to change roles, read the audit trail or touch provider credentials are
  // deliberately not the same state — see AdminLockService for why it is a
  // separate passphrase rather than the sign-in one.

  /** Set a passphrase, type one, or wait out a lockout — which of the three. */
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @Get('admin/lock')
  adminLockStatus(@Request() req: { user: { userId: string } }) {
    return this.adminLock.status(req.user.userId);
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @Post('admin/lock')
  setAdminPassphrase(
    @Request() req: { user: { userId: string } },
    @Body() body: { current?: string; next?: string },
  ) {
    return this.adminLock.setPassphrase(req.user.userId, body ?? {});
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @Post('admin/unlock')
  adminUnlock(
    @Request() req: { user: { userId: string } },
    @Body() body: { passphrase?: string },
  ) {
    return this.adminLock.unlock(req.user.userId, body?.passphrase ?? '');
  }

  /**
   * Clears somebody else's passphrase so they can set a new one.
   *
   * Behind the unlock itself: it takes an administrator who is already through
   * the door to let another one back in. There is deliberately no master key.
   */
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, AdminUnlockGuard)
  @Post('admin/lock/reset/:userId')
  resetAdminPassphrase(
    @Request() req: { user: { userId: string } },
    @Param('userId') userId: string,
  ) {
    return this.adminLock.resetFor(req.user.userId, userId);
  }

  /**
   * Whether Google sign-in is available.
   *
   * The login page asks before drawing the button: an unconfigured deployment
   * showing "Continue with Google" sends people down a road that ends in an
   * error they cannot act on.
   */
  @Get('providers')
  providers() {
    return { google: this.google.configured };
  }

  /** Starts the flow. The browser is sent here, not fetched. */
  @ApiExcludeEndpoint()
  @Get('google')
  googleStart(
    @Query('returnTo') returnTo: string | undefined,
    @Res() res: Response,
  ) {
    res.redirect(this.google.authorizeUrl(returnTo));
  }

  /**
   * Where Google sends the browser back.
   *
   * Ends in a redirect to the dashboard carrying the session token in the URL
   * FRAGMENT. A fragment is never sent to a server, never appears in an access
   * log and never leaks in a Referer header — a query parameter would do all
   * three, and this is a credential.
   *
   * Failures redirect too, with a message rather than a stack: the person is
   * in a browser mid-sign-in, and a JSON error page is a dead end for them.
   */
  @ApiExcludeEndpoint()
  @Get('google/callback')
  async googleCallback(
    @Query('code') code: string | undefined,
    @Query('state') state: string | undefined,
    @Query('error') error: string | undefined,
    @Res() res: Response,
  ) {
    const web = webOrigin();
    try {
      if (error) throw new BadRequestException(`Google reported: ${error}`);
      if (!code) throw new BadRequestException('Google returned no code.');
      const { returnTo } = this.google.verifyState(state);
      const { accessToken } = await this.google.completeSignIn(code);
      res.redirect(
        `${web}/auth/callback#token=${encodeURIComponent(accessToken)}&next=${encodeURIComponent(returnTo)}`,
      );
    } catch (e) {
      const message =
        e instanceof HttpException
          ? ((e.getResponse() as { message?: string })?.message ?? e.message)
          : 'Sign-in failed.';
      res.redirect(`${web}/login?error=${encodeURIComponent(String(message))}`);
    }
  }
}

/** Where the dashboard lives, for the redirect back out of the flow. */
function webOrigin(): string {
  const first = (process.env.WEB_ORIGIN ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s && !s.includes('*'))[0];
  return (first ?? 'http://localhost:3000').replace(/\/$/, '');
}
