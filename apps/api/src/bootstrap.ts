import { INestApplication, Logger, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { ExpressAdapter } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';

import { AppModule } from './app.module';
import { allowedOrigins, configuredOrigins, isOriginAllowed } from './common/cors';

/**
 * Builds and configures the application without starting a listener.
 *
 * Two runtimes need the identical app: `main.ts` (a long-running process that
 * calls listen) and `api/index.ts` (a Vercel Function that calls init and hands
 * the Express instance to the platform). Configuring in one place is the point —
 * when CORS or the global prefix drifted between the two, the deployed API
 * behaved differently from every local test of it.
 */
export async function createApp(
  adapter?: ExpressAdapter,
): Promise<INestApplication> {
  // rawBody keeps the exact received bytes on req.rawBody. Webhook signatures
  // are an HMAC over those bytes; re-serialising parsed JSON reorders keys and
  // changes whitespace, which breaks verification.
  const app = adapter
    ? await NestFactory.create(AppModule, adapter, { rawBody: true })
    : await NestFactory.create(AppModule, { rawBody: true });

  // The dashboard is a static export served from a different host (Vercel), so
  // every call it makes is cross-origin. WEB_ORIGIN accepts a comma-separated
  // list because there is a production domain AND a distinct preview URL per
  // deployment; a single value silently breaks every preview with a CORS error.
  const allowed = allowedOrigins();
  if (!configuredOrigins().length) {
    // Said at boot, not on the first refusal, because the refusal is what you
    // are trying to explain and by then you are reading the browser console
    // rather than the server log.
    Logger.warn(
      `WEB_ORIGIN is not set — falling back to ${allowed.join(', ')}. Set it to the dashboard's exact origin.`,
      'Bootstrap',
    );
  }

  app.enableCors({
    origin: (
      origin: string | undefined,
      cb: (e: Error | null, ok?: boolean) => void,
    ) => {
      // No Origin header: curl, health checks and server-to-server callers,
      // which CORS is not designed to police.
      if (!origin) return cb(null, true);
      const ok = isOriginAllowed(origin, allowed);
      // A refusal is otherwise invisible from the server side: the browser
      // reports only "No Access-Control-Allow-Origin", and the origin it
      // actually sent is the one thing needed to fix the configuration.
      if (!ok) {
        Logger.warn(
          `CORS refused origin "${origin}". WEB_ORIGIN allows: ${allowed.join(', ')}`,
          'Bootstrap',
        );
      }
      cb(null, ok);
    },
    // The dashboard authenticates with a bearer token it holds itself; it never
    // sends a cookie, so nothing here needs credentialed requests. Leaving them
    // on would mean any origin the list admits — including a whole wildcard —
    // could make requests carrying the browser's ambient credentials.
    credentials: false,
  });

  app.setGlobalPrefix('api');
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: true,
    }),
  );

  const swaggerConfig = new DocumentBuilder()
    .setTitle('OpsOS API')
    .setDescription('Operations OS — real-time operational command center API')
    .setVersion('0.1.0')
    .addBearerAuth()
    .build();
  SwaggerModule.setup(
    'api/docs',
    app,
    SwaggerModule.createDocument(app, swaggerConfig),
  );

  return app;
}
