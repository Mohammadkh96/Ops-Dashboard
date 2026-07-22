"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { AnimatePresence, motion } from "framer-motion";
import { Menu, X, Radar } from "lucide-react";

import { primaryNav, secondaryNav, type NavItem } from "@/config/nav";
import { cn } from "@/lib/utils";

function isActive(pathname: string, href: string) {
  if (href === "/") return pathname === "/";
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function MobileNav() {
  const [open, setOpen] = useState(false);
  const pathname = usePathname();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const renderItem = (item: NavItem) => {
    const Icon = item.icon;
    const active = isActive(pathname, item.href);
    return (
      <Link
        key={item.href}
        href={item.href}
        onClick={() => setOpen(false)}
        className={cn(
          "flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors",
          active
            ? "bg-accent-blue-soft text-accent-blue"
            : "text-muted-foreground hover:bg-card hover:text-foreground",
        )}
      >
        <Icon className={cn("size-4 shrink-0", active ? "text-accent-blue" : "text-muted")} />
        {item.label}
      </Link>
    );
  };

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label="Open navigation"
        className="flex size-9 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-card hover:text-foreground lg:hidden"
      >
        <Menu className="size-5" />
      </button>

      <AnimatePresence>
        {open ? (
          <div className="fixed inset-0 z-[80] lg:hidden">
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="absolute inset-0 bg-black/50 backdrop-blur-sm"
              onClick={() => setOpen(false)}
            />
            <motion.aside
              initial={{ x: "-100%" }}
              animate={{ x: 0 }}
              exit={{ x: "-100%" }}
              transition={{ type: "spring", stiffness: 400, damping: 40 }}
              className="absolute inset-y-0 left-0 flex w-72 max-w-[80vw] flex-col border-r border-border bg-surface"
            >
              <div className="flex h-16 items-center justify-between border-b border-border px-5">
                <div className="flex items-center gap-2.5">
                  <span className="flex size-8 items-center justify-center rounded-lg bg-accent-blue-soft ring-1 ring-accent-blue/20">
                    <Radar className="size-4 text-accent-blue" />
                  </span>
                  <span className="text-sm font-semibold tracking-tight">OpsOS</span>
                </div>
                <button
                  type="button"
                  onClick={() => setOpen(false)}
                  aria-label="Close navigation"
                  className="rounded-lg p-1.5 text-muted transition-colors hover:bg-card hover:text-foreground"
                >
                  <X className="size-4" />
                </button>
              </div>
              <nav className="flex flex-1 flex-col gap-1 overflow-y-auto p-3">
                {primaryNav.map(renderItem)}
                <span className="px-3 pb-1 pt-4 text-[11px] font-medium uppercase tracking-wider text-muted">
                  System
                </span>
                {secondaryNav.map(renderItem)}
              </nav>
            </motion.aside>
          </div>
        ) : null}
      </AnimatePresence>
    </>
  );
}
