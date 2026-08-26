// Lightweight API client for the OpsOS backend.
//
// When NEXT_PUBLIC_API_URL is unset the app runs in "demo mode": no requests
// are made and callers fall back to bundled demo data. This lets the frontend
// be deployed standalone (e.g. to get a live preview URL) with zero backend.

export const API_URL = process.env.NEXT_PUBLIC_API_URL?.replace(/\/$/, "") ?? "";
export const isDemoMode = API_URL === "";

const TOKEN_KEY = "opsos.token";

export function getToken(): string | null {
  if (typeof window === "undefined") return null;
  return window.localStorage.getItem(TOKEN_KEY);
}

export function setToken(token: string) {
  if (typeof window !== "undefined") window.localStorage.setItem(TOKEN_KEY, token);
}

export function clearToken() {
  if (typeof window !== "undefined") window.localStorage.removeItem(TOKEN_KEY);
}

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    /**
     * The request failed for a reason that may not repeat — a cold start, a
     * sleeping database, a dropped connection. Distinct from a refusal (401,
     * 404, a validation error), which will fail identically however many times
     * it is sent, and which is the only kind that should end a session.
     */
    public transient = false,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/**
 * Statuses worth sending again.
 *
 * 500 is included deliberately. This API runs as a serverless function against
 * a serverless database: the first request after an idle period pays a cold
 * start AND may have to wake Postgres, and that combination surfaces as a 500
 * from a handler whose database call timed out. It is the single most common
 * failure this dashboard sees, and it disappears on the next attempt.
 */
const TRANSIENT_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

/** Per attempt. Long enough for a cold start, short enough to retry within a
 *  human's patience. */
const TIMEOUT_MS = 20_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function attempt<T>(path: string, init?: RequestInit): Promise<T> {
  const token = getToken();
  let res: Response;
  try {
    res = await fetch(`${API_URL}${path}`, {
      ...init,
      // Without this a hung function leaves the request open indefinitely, and
      // the page sits on a spinner with nothing to retry and nothing to say.
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(init?.headers ?? {}),
      },
    });
  } catch (e) {
    // A network-level failure: DNS, TLS, the tab going offline, the timeout
    // above, or a blocked cross-origin request. None of them reached a
    // handler, so nothing happened server-side and sending it again is safe.
    const timedOut = e instanceof DOMException && e.name === "TimeoutError";
    throw new ApiError(
      0,
      timedOut
        ? `The API did not answer within ${TIMEOUT_MS / 1000}s.`
        : e instanceof Error
          ? e.message
          : String(e),
      true,
    );
  }

  if (!res.ok) {
    let message = res.statusText;
    try {
      const body = (await res.json()) as { message?: string | string[] };
      if (body?.message) message = Array.isArray(body.message) ? body.message.join(", ") : body.message;
    } catch {
      /* non-JSON error body */
    }
    throw new ApiError(res.status, message, TRANSIENT_STATUS.has(res.status));
  }

  return res.json() as Promise<T>;
}

/**
 * A request to the API, retried when the failure looks temporary.
 *
 * Everything here runs against serverless infrastructure that sleeps: the API
 * is a function that cold-starts and the database suspends when idle. The first
 * request after a quiet period therefore fails often — and it used to fail all
 * the way to the screen, which is why the dashboard had to be reloaded several
 * times before it would come up, and why signing in took more than one press.
 * The second attempt almost always succeeds, so the code makes it rather than
 * asking a person to.
 *
 * Retries are only for requests where sending again cannot do anything twice:
 * GET and HEAD by default, and whatever a caller explicitly marks (a rejected
 * sign-in creates nothing). A write is never retried on its own, because a 500
 * does not prove the write did not land.
 */
export async function apiFetch<T>(
  path: string,
  init?: RequestInit,
  opts: { retries?: number } = {},
): Promise<T> {
  if (isDemoMode) {
    throw new ApiError(0, "Demo mode: no API configured");
  }
  const method = (init?.method ?? "GET").toUpperCase();
  const idempotent = method === "GET" || method === "HEAD";
  const retries = opts.retries ?? (idempotent ? 2 : 0);

  let last: unknown;
  for (let i = 0; i <= retries; i++) {
    try {
      return await attempt<T>(path, init);
    } catch (e) {
      last = e;
      const transient = e instanceof ApiError && e.transient;
      if (!transient || i === retries) throw e;
      // Backing off rather than hammering: a cold start needs a moment, and a
      // 429 needs more than a moment.
      await sleep(500 * Math.pow(3, i));
    }
  }
  throw last;
}
