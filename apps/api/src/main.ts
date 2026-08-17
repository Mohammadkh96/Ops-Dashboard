import { createApp } from './bootstrap';

/**
 * Long-running entry point (local dev, Docker, any always-on host).
 *
 * On Vercel the app is served by `api/index.ts` instead, which calls `init()`
 * rather than `listen()`. Both share `createApp` so the two runtimes cannot
 * drift apart.
 */
async function bootstrap() {
  const app = await createApp();
  await app.listen(process.env.PORT ?? 4000);
}
void bootstrap();
