"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { motion } from "framer-motion";
import { Radar } from "lucide-react";

import { primaryNav, secondaryNav, type NavItem } from "@/config/nav";
import { cn } from "@/lib/utils";

function isActive(pathname: string, href: string) {
  if (href === "/") return pathname === "/";
  return pathname === href || pathname.startsWith(`${href}/`);
}

function NavLink({ item, active }: { item: NavItem; active: boolean }) {
  const Icon = item.icon;
  return (
    <Link
      href={item.href}
      className={cn(
        "group relative flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors",
        active ? "text-accent-blue" : "text-muted-foreground hover:bg-card hover:text-foreground",
      )}
    >
      {active ? (
        <motion.span
          layoutId="nav-active"
          transition={{ type: "spring", stiffness: 420, damping: 34 }}
          className="absolute inset-0 rounded-lg border border-accent-blue/20 bg-accent-blue-soft"
        />
      ) : null}
      <Icon
        className={cn(
          "relative z-10 size-4 shrink-0",
          active ? "text-accent-blue" : "text-muted group-hover:text-foreground",
        )}
      />
      <span className="relative z-10 truncate">{item.label}</span>
      {item.badge ? (
        <span className="relative z-10 ml-auto rounded-full bg-accent-red-soft px-1.5 py-0.5 text-[10px] font-semibold text-accent-red">
          {item.badge}
        </span>
      ) : null}
    </Link>
  );
}

export function Sidebar() {
  const pathname = usePathname();

  return (
    <aside className="fixed inset-y-0 left-0 z-40 hidden w-64 flex-col border-r border-border bg-surface/80 backdrop-blur-xl lg:flex">
      <div className="flex h-16 items-center gap-2.5 border-b border-border px-5">
        <div className="flex size-8 items-center justify-center rounded-lg bg-accent-blue-soft ring-1 ring-accent-blue/20">
          <Radar className="size-4 text-accent-blue" />
        </div>
        <div className="flex flex-col leading-none">
          <span className="text-sm font-semibold tracking-tight">OpsOS</span>
          <span className="text-[11px] text-muted">Operations OS</span>
        </div>
      </div>

      <nav className="flex flex-1 flex-col gap-6 overflow-y-auto px-3 py-5">
        <div className="flex flex-col gap-1">
          {primaryNav.map((item) => (
            <NavLink key={item.href} item={item} active={isActive(pathname, item.href)} />
          ))}
        </div>

        <div className="mt-auto flex flex-col gap-1">
          <span className="px-3 pb-1 text-[11px] font-medium uppercase tracking-wider text-muted">
            System
          </span>
          {secondaryNav.map((item) => (
            <NavLink key={item.href} item={item} active={isActive(pathname, item.href)} />
          ))}
        </div>
      </nav>
    </aside>
  );
}
