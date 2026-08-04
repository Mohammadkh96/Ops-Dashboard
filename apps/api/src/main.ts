import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';

import { AppModule } from './app.module';

async function bootstrap() {
  // rawBody keeps the exact received bytes on req.rawBody. Webhook signatures
  // are an HMAC over those bytes; re-serialising parsed JSON reorders keys and
  // changes whitespace, which breaks verification.
  const app = await NestFactory.create(AppModule, { rawBody: true });

  // The dashboard is a static export served from a different host (Vercel), so
  // every call it makes is cross-origin. WEB_ORIGIN accepts a comma-separated
  // list because there is a production domain AND a distinct preview URL per
  // deployment; a single value silently breaks every preview with a CORS error.
  //
  // A leading "*." allows a subdomain wildcard (e.g. "*.vercel.app") for those
  // previews. Prefer exact origins in production: with credentials enabled, a
  // wildcard lets any site on that domain make credentialed requests.
  const allowed = (process.env.WEB_ORIGIN ?? 'http://localhost:3000')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  app.enableCors({
    origin: (origin: string | undefined, cb: (e: Error | null, ok?: boolean) => void) => {
      // No Origin header: curl, health checks and server-to-server callers,
      // which CORS is not designed to police.
      if (!origin) return cb(null, true);
      const ok = allowed.some((a) =>
        a.startsWith('*.') ? origin.endsWith(a.slice(1)) : a === origin,
      );
      cb(null, ok);
    },
    credentials: true,
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
  const document = SwaggerModule.createDocument(app, swaggerConfig);
  SwaggerModule.setup('api/docs', app, document);

  await app.listen(process.env.PORT ?? 4000);
}
void bootstrap();
