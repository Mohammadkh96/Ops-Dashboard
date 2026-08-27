"use client";

import type { ReactNode } from "react";
import { usePathname } from "next/navigation";

import { Sidebar } from "@/components/shell/sidebar";
import { TopBar } from "@/components/shell/top-bar";
import { CommandPalette } from "@/components/command-palette";
import { AuthGate } from "@/components/auth-gate";

/**
 * Screens that render without the operations chrome — and, more importantly,
 * outside AuthGate.
 *
 * /auth/callback has to be here. It is the page that TAKES a session, and it
 * runs for a moment with a token stored but no user loaded yet. Inside the gate
 * that moment reads as "not signed in", and the gate redirects to /login while
 * the sign-in it was in the middle of is still in flight — Google sign-in would
 * simply bounce you back to the login page, having worked perfectly.
 */
const BARE_ROUTES = ["/login", "/auth/callback"];

/**
 * Path without a trailing slash, so route checks work in both builds.
 *
 * The static export sets `trailingSlash: true`, so the deployed login page is
 * "/login/" while local dev serves "/login". Comparing the raw pathname matched
 * only in dev — deployed, the login page fell through to the authenticated
 * shell and was blocked by the very gate whose job is to send you to it, with
 * its "sign in" link pointing back at itself. Nothing on the page moved, and no
 * error was logged, because as far as the app was concerned it had navigated.
 */
function normalizePath(pathname: string): string {
  return pathname.replace(/\/+$/, "") || "/";
}

export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();

  // Auth screens render without the operations chrome.
  if (BARE_ROUTES.includes(normalizePath(pathname))) {
    return <div className="min-h-screen bg-background">{children}</div>;
  }

  return (
    <div className="min-h-screen bg-background">
      <CommandPalette />
      <Sidebar />
      <div className="lg:pl-64">
        <TopBar />
        <main className="mx-auto max-w-[1600px] px-5 py-6 lg:px-8">
          <AuthGate>{children}</AuthGate>
        </main>
      </div>
    </div>
  );
}
