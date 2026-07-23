"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { Users, ScrollText, KeyRound } from "lucide-react";

import { cn } from "@/lib/utils";

const ADMIN_TABS = [
  { href: "/admin/users", label: "Users", icon: Users },
  { href: "/admin/audit-logs", label: "Audit Logs", icon: ScrollText },
  { href: "/admin/api-keys", label: "API Keys", icon: KeyRound },
];

export default function AdminLayout({ children }: { children: ReactNode }) {
  const pathname = usePathname();

  return (
    <div className="flex flex-col gap-6">
      <nav className="flex items-center gap-1 overflow-x-auto border-b border-border">
        {ADMIN_TABS.map((t) => {
          const active = pathname === t.href || pathname.startsWith(`${t.href}/`);
          const Icon = t.icon;
          return (
            <Link
              key={t.href}
              href={t.href}
              className={cn(
                "relative flex items-center gap-2 px-3 py-2.5 text-sm font-medium transition-colors",
                active ? "text-foreground" : "text-muted hover:text-muted-foreground",
              )}
            >
              <Icon className="size-4" />
              {t.label}
              {active ? (
                <span className="absolute inset-x-2 -bottom-px h-0.5 rounded-full bg-accent-blue" />
              ) : null}
            </Link>
          );
        })}
      </nav>

      {children}
    </div>
  );
}
