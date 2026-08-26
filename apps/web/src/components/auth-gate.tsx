"use client";

import { useEffect, type ReactNode } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

import { useAuth } from "@/lib/auth";

/**
 * Guards operations screens. In demo mode (no API) it's a pass-through so the
 * dashboard is browsable without a login. In live mode it redirects
 * unauthenticated users to /login.
 */
export function AuthGate({ children }: { children: ReactNode }) {
  const { user, isDemo, isLoading, unreachable, retry } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (isDemo || isLoading) return;
    // Not while the API is merely unreachable: the session may be perfectly
    // valid, and sending somebody to a login form they cannot complete —
    // because the same API is down — is the loop that made this dashboard
    // feel broken on every cold start.
    if (!user && !unreachable) router.replace("/login");
  }, [isDemo, isLoading, user, unreachable, router]);

  if (!isDemo && isLoading) {
    return (
      <div className="flex min-h-[60vh] items-center justify-center">
        <span className="flex items-center gap-2 text-sm text-muted">
          <span className="size-4 animate-spin rounded-full border-2 border-border border-t-accent-blue" />
          Checking your session…
        </span>
      </div>
    );
  }

  // Reachable question unanswered. Saying which of the two it is matters: one
  // is fixed by signing in, the other by waiting a moment.
  if (!isDemo && !user && unreachable) {
    return (
      <div className="flex min-h-[60vh] flex-col items-center justify-center gap-3 px-6 text-center">
        <p className="text-sm text-muted-foreground">
          Your session could not be confirmed because the API did not answer.
        </p>
        <p className="max-w-md text-xs text-muted">
          {unreachable} — you have not been signed out; this is the API being
          unreachable or waking up. It was retried automatically.
        </p>
        <div className="flex gap-2">
          <button
            onClick={retry}
            className="rounded-md border border-border px-4 py-2 text-sm transition hover:border-accent-blue"
          >
            Try again
          </button>
          <Link
            href="/login"
            className="rounded-md border border-border px-4 py-2 text-sm text-muted transition hover:border-accent-blue"
          >
            Sign in instead
          </Link>
        </div>
      </div>
    );
  }

  // Signed out. Previously this rendered the same endless spinner as the
  // loading state, so a redirect that did not fire — or an API the browser
  // could not reach — looked identical to "still working" and the page simply
  // span forever with nothing to act on. Say what happened, and offer the link
  // directly in case the redirect is what failed.
  if (!isDemo && !user) {
    return (
      <div className="flex min-h-[60vh] flex-col items-center justify-center gap-3 text-center">
        <p className="text-sm text-muted">You need to sign in to view this.</p>
        <Link
          href="/login"
          className="rounded-md border border-border px-4 py-2 text-sm text-fg transition hover:border-accent-blue"
        >
          Go to sign in
        </Link>
      </div>
    );
  }

  return <>{children}</>;
}
