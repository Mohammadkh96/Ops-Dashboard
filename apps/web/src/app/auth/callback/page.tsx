"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useRouter } from "next/navigation";

import { useAuth } from "@/lib/auth";

/**
 * Where Google sign-in lands.
 *
 * The API redirects here with the session token in the URL FRAGMENT. A fragment
 * never reaches a server, never appears in an access log and never leaks in a
 * Referer header — all three of which a query parameter would do, and this is a
 * credential.
 *
 * The fragment is removed from the address bar before anything else happens, so
 * the token is not sitting in browser history or on screen while the page
 * finishes loading.
 */

type Handoff = { token: string | null; next: string };

/**
 * The fragment, read exactly once.
 *
 * Cached at module scope because the effect below clears the fragment
 * immediately: a second read would find an empty URL and report a missing token
 * for a sign-in that was in fact fine. Safe to cache because arriving here is
 * always a full browser navigation from the API, which loads this module fresh.
 */
let handoff: Handoff | undefined;

function readHandoff(): Handoff {
  if (!handoff) {
    const params = new URLSearchParams(window.location.hash.replace(/^#/, ""));
    handoff = { token: params.get("token"), next: params.get("next") ?? "/" };
  }
  return handoff;
}

/**
 * The prerender has no URL to read, which is NOT the same as a link with no
 * token in it — so it returns null, "not looked yet", and the page waits rather
 * than flashing "could not complete sign-in" at somebody whose sign-in is fine.
 */
const NOT_READ = null;
const neverChanges = () => () => {};

export default function AuthCallbackPage() {
  const router = useRouter();
  const { adopt } = useAuth();
  // Read during render rather than set from an effect: setting state in an
  // effect renders the page twice, once wrong and once right, and React now
  // refuses to compile it. The server snapshot keeps the prerender consistent.
  const link = useSyncExternalStore<Handoff | null>(
    neverChanges,
    readHandoff,
    () => NOT_READ,
  );
  const token = link?.token ?? null;
  const next = link?.next ?? "/";
  // Only a failure that happens later — the API refusing the token — needs
  // state, and that arrives in a promise callback rather than an effect body.
  const [failure, setFailure] = useState<string | null>(null);
  // React runs effects twice in development; adopting a token twice is
  // harmless, but the second run would race the first one's redirect.
  const done = useRef(false);

  useEffect(() => {
    if (!link) return;
    // Cleared first, whatever happens next, so the credential is not sitting in
    // browser history or on screen.
    window.history.replaceState(null, "", window.location.pathname);

    if (!token || done.current) return;
    done.current = true;

    void adopt(token)
      .then(() => {
        // Only a path, never an absolute URL: this value came back through the
        // browser, and following it anywhere would be an open redirect at the
        // exact moment a fresh session exists.
        router.replace(next.startsWith("/") && !next.startsWith("//") ? next : "/");
      })
      .catch((e: unknown) => {
        setFailure(e instanceof Error ? e.message : String(e));
      });
  }, [adopt, router, link, token, next]);

  const error =
    failure ??
    (link && !link.token
      ? "That sign-in link carried no session. Start again."
      : null);

  return (
    <div className="flex min-h-screen items-center justify-center p-6">
      <div className="flex max-w-sm flex-col items-center gap-3 text-center">
        {error ? (
          <>
            <span className="text-sm font-medium text-accent-red">
              Could not complete sign-in
            </span>
            <span className="text-xs text-muted">{error}</span>
            <a
              href="/login"
              className="mt-2 text-xs text-accent-blue underline underline-offset-2"
            >
              Back to sign in
            </a>
          </>
        ) : (
          <span className="text-sm text-muted">Signing you in…</span>
        )}
      </div>
    </div>
  );
}
