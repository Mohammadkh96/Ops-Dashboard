// Lightweight API client for the OpsOS backend.
//
// When NEXT_PUBLIC_API_URL is unset the app runs in "demo mode": no requests
// are made and callers fall back to bundled demo data. This lets the frontend
// be deployed standalone (e.g. to get a live preview URL) with zero backend.

export const API_URL =
  process.env.NEXT_PUBLIC_API_URL?.replace(/\/$/, "") ?? "";
export const isDemoMode = API_URL === "";

const TOKEN_KEY = "opsos.token";

export function getToken(): string | null {
  if (typeof window === "undefined") return null;
  return window.localStorage.getItem(TOKEN_KEY);
}

export function setToken(token: string) {
  if (typeof window !== "undefined")
    window.localStorage.setItem(TOKEN_KEY, token);
}

export function clearToken() {
  if (typeof window !== "undefined") window.localStorage.removeItem(TOKEN_KEY);
}

/**
 * The session token is checked once, when the app mounts. It also EXPIRES —
 * eight hours by default, which is one shift — and nothing was watching for
 * that in a tab that stays open. Every request after the moment of expiry came
 * back 401, and the screen showed "Unauthorized" on every panel with no way
 * forward: the sign-in redirect only runs on mount, so the fix was to reload
 * the page, which nothing on screen said.
 *
 * A 401 from our own API means one thing — this session is over. Say so once,
 * and go to the sign-in page.
 *
 * Sign-in itself is excluded: a wrong password is also a 401, and treating it
 * as an expiry would bounce somebody off the page they are trying to use.
 */
function sessionEnded(path: string) {
  if (typeof window === "undefined") return;
  if (path.startsWith("/auth/login") || path.startsWith("/auth/google")) return;
  clearToken();
  // replace(), not assign(): the expired page must not come back on Back.
  if (!window.location.pathname.startsWith("/login")) {
    window.location.replace("/login?expired=1");
  }
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

async function attempt<T>(
  path: string,
  init?: RequestInit,
  timeoutMs = TIMEOUT_MS,
): Promise<T> {
  const token = getToken();
  let res: Response;
  try {
    res = await fetch(`${API_URL}${path}`, {
      ...init,
      // Without this a hung function leaves the request open indefinitely, and
      // the page sits on a spinner with nothing to retry and nothing to say.
      signal: AbortSignal.timeout(timeoutMs),
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
        ? `The API did not answer within ${timeoutMs / 1000}s.`
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
      if (body?.message)
        message = Array.isArray(body.message)
          ? body.message.join(", ")
          : body.message;
    } catch {
      /* non-JSON error body */
    }
    if (res.status === 401) sessionEnded(path);
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
  /**
   * `timeoutMs` is an override for the handful of endpoints that are SLOW BY
   * DESIGN rather than slow because something is wrong. The provider sync
   * spends a server-side budget walking days and then returns a cursor; with
   * the default ceiling the browser gave up at twenty seconds while the
   * function was still writing rows, which reported a timeout for work that
   * actually succeeded.
   */
  opts: { retries?: number; timeoutMs?: number } = {},
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
      return await attempt<T>(path, init, opts.timeoutMs);
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

/**
 * Wakes the API before anybody needs it.
 *
 * Everything behind this dashboard sleeps when nobody is using it: the API is a
 * serverless function with no instance running, and Postgres suspends its
 * compute after a few idle minutes. Neither is slow once awake — but the FIRST
 * request after a quiet period pays for both, one after the other, and that
 * request was always the one a person had just made. Leave the tab overnight,
 * come back, press Sign in, and the press that should take 200ms takes several
 * seconds or fails outright.
 *
 * So the waking is moved off the person and onto the page. Opening the sign-in
 * screen fires this immediately; by the time an email and a password have been
 * typed the function is up and the database is out of suspend, and the press
 * lands on something warm.
 *
 * It asks /health specifically, because that endpoint runs `SELECT 1`. A ping
 * that only reached the function would wake half of what is asleep and leave
 * the database wake-up still charged to the sign-in.
 *
 * Failure is not reported to the caller and not retried hard. This is an
 * optimisation: if it does not land, the real request behaves exactly as it did
 * before, which is to say it retries on its own.
 */
type WarmState = "cold" | "waking" | "ready" | "unreachable";

let warmAt = 0;
let warming: Promise<WarmState> | undefined;

/** A function stays warm for a few minutes; re-pinging inside that is waste. */
const WARM_FOR_MS = 60_000;

export function warmUp(): Promise<WarmState> {
  if (isDemoMode) return Promise.resolve("ready");
  if (Date.now() - warmAt < WARM_FOR_MS) return Promise.resolve("ready");
  // De-duplicated: mount, focus and a reconnect can all fire at once, and three
  // cold-start requests wake three instances instead of one.
  warming ??= apiFetch<{ status?: string }>("/health", undefined, { retries: 1 })
    .then((): WarmState => {
      warmAt = Date.now();
      return "ready";
    })
    .catch((): WarmState => "unreachable")
    .finally(() => {
      warming = undefined;
    });
  return warming;
}

export type { WarmState };
