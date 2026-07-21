"use client";

import { useEffect, type ReactNode } from "react";
import { useRouter } from "next/navigation";

import { useAuth } from "@/lib/auth";

/**
 * Guards operations screens. In demo mode (no API) it's a pass-through so the
 * dashboard is browsable without a login. In live mode it redirects
 * unauthenticated users to /login.
 */
export function AuthGate({ children }: { children: ReactNode }) {
  const { user, isDemo, isLoading } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (isDemo || isLoading) return;
    if (!user) router.replace("/login");
  }, [isDemo, isLoading, user, router]);

  if (!isDemo && (isLoading || !user)) {
    return (
      <div className="flex min-h-[60vh] items-center justify-center">
        <span className="flex items-center gap-2 text-sm text-muted">
          <span className="size-4 animate-spin rounded-full border-2 border-border border-t-accent-blue" />
          Loading…
        </span>
      </div>
    );
  }

  return <>{children}</>;
}
