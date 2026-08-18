"use client";

import type { ReactNode } from "react";
import { usePathname } from "next/navigation";

import { Sidebar } from "@/components/shell/sidebar";
import { TopBar } from "@/components/shell/top-bar";
import { CommandPalette } from "@/components/command-palette";
import { AuthGate } from "@/components/auth-gate";

const BARE_ROUTES = ["/login"];

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
