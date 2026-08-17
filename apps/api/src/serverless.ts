import type { IncomingMessage, ServerResponse } from 'node:http';

import { createApp } from './bootstrap';

type NodeHandler = (req: IncomingMessage, res: ServerResponse) => void;

/**
 * The whole NestJS app behind a single serverless handler (Vercel).
 *
 * `vercel.json` rewrites every path here, so routing stays inside Nest rather
 * than being spread across a directory of function files. One function also means
 * one cold start and one database pool per instance instead of one per route.
 */

/**
 * Cached across warm invocations — a single instance serves many requests, and
 * re-bootstrapping Nest on each one would add hundreds of milliseconds and open
 * a fresh connection pool every time.
 *
 * The *promise* is cached rather than the resolved app: two requests can arrive
 * before the first boot finishes, and caching the promise makes the second wait
 * for the first instead of starting a second Nest app.
 */
let cached: Promise<NodeHandler> | undefined;

async function boot(): Promise<NodeHandler> {
  const app = await createApp();
  // init() wires up middleware, pipes and routes without binding a port. There
  // is no port to bind here — the platform owns the socket.
  await app.init();
  return app.getHttpAdapter().getInstance() as NodeHandler;
}

export async function handler(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  // The platform runtime parses the request body for known content types. When
  // it hands over the untouched bytes we keep them, because a webhook signature
  // is an HMAC over exactly those bytes — re-serialising the parsed object
  // reorders keys and changes whitespace, and verification then fails.
  //
  // Stored under its own property rather than `rawBody`: the body parser Nest
  // installs runs afterwards and would overwrite `rawBody` with an empty buffer
  // if the stream had already been drained.
  const pre: unknown = (req as { body?: unknown }).body;
  if (Buffer.isBuffer(pre)) {
    (req as { platformRawBody?: Buffer }).platformRawBody = pre;
  } else if (typeof pre === 'string') {
    (req as { platformRawBody?: Buffer }).platformRawBody = Buffer.from(pre);
  }

  cached ??= boot();
  const app = await cached;
  app(req, res);
}

export default handler;
