import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';

import { jwtSecret } from '../common/jwt-secret';
import { UsersModule } from '../users/users.module';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { AdminLockService } from './admin-lock.service';
import { AdminUnlockGuard } from './guards/admin-unlock.guard';
import { GoogleAuthService } from './google.service';
import { PrismaModule } from '../prisma/prisma.module';
import { JwtStrategy } from './strategies/jwt.strategy';

@Module({
  imports: [
    UsersModule,
    PrismaModule,
    PassportModule,
    // registerAsync, not register: the object passed to `register` is built
    // while this file is being IMPORTED, which happens before
    // ConfigModule.forRoot() has read the .env file. The strategy that verifies
    // tokens is constructed later, once the file is loaded — so the signer used
    // the fallback secret while the verifier used the configured one, and every
    // token a successful login issued was rejected by the next request. Login
    // worked, the dashboard then said Unauthorized to everything, and nothing
    // in either half looked broken on its own.
    //
    // A factory runs at instantiation instead, by which time the environment is
    // whole, so both halves read the same value. It never showed on Vercel,
    // where the variables are real process environment and both readings agree;
    // it is every .env-based deployment — Docker, a self-host, a laptop — that
    // could not stay signed in.
    JwtModule.registerAsync({
      useFactory: () => ({
        secret: jwtSecret(),
        signOptions: {
          // A day, not a shift, and it slides. Eight hours is exactly one
          // shift, so a session minted at the start of one expired in the
          // middle of the next — and the desk's experience of that was a
          // dashboard that had to be reloaded to work again.
          //
          // The browser renews this while a tab is in use (see /auth/refresh),
          // so somebody working is never signed out; a day is what covers the
          // gap between finishing one evening and starting the next morning.
          // Longer than that on a token held in a browser buys nothing anyone
          // asked for and costs something if a laptop is lost.
          expiresIn: (process.env.JWT_EXPIRES_IN ??
            '24h') as `${number}${'s' | 'm' | 'h' | 'd'}`,
        },
      }),
    }),
  ],
  controllers: [AuthController],
  providers: [
    AuthService,
    GoogleAuthService,
    AdminLockService,
    AdminUnlockGuard,
    JwtStrategy,
  ],
  // Exported so the modules controller can put the same lock in front of the
  // routes the Admin tab actually calls. One guard, one definition of unlocked.
  exports: [AdminLockService, AdminUnlockGuard],
})
export class AuthModule {}
