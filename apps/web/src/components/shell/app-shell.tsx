"use client";

import type { ReactNode } from "react";
import { usePathname } from "next/navigation";

import { Sidebar } from "@/components/shell/sidebar";
import { TopBar } from "@/components/shell/top-bar";
import { CommandPalette } from "@/components/command-palette";
import { AuthGate } from "@/components/auth-gate";

const BARE_ROUTES = ["/login"];

export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();

  // Auth screens render without the operations chrome.
  if (BARE_ROUTES.includes(pathname)) {
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
