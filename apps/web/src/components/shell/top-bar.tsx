"use client";

import { Bell, Search, Command, Sun, Moon, ChevronDown, LogOut, UserCog, Timer } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { LiveDot } from "@/components/ui/live-dot";
import { openCommandPalette } from "@/components/command-palette";
import { useAuth } from "@/lib/auth";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

function initials(email: string) {
  const name = email.split("@")[0].replace(/[._-]+/g, " ").trim();
  const parts = name.split(" ");
  return ((parts[0]?.[0] ?? "") + (parts[1]?.[0] ?? "")).toUpperCase() || "OP";
}

export function TopBar() {
  const [theme, setTheme] = useState<"dark" | "light">("dark");
  const { user, isDemo, logout } = useAuth();

  const email = user?.email ?? "mohammad@tradin.com";
  const role = user?.role ? user.role.replace(/_/g, " ").toLowerCase() : "Operations Manager";

  return (
    <header className="glass-surface sticky top-0 z-30 flex h-16 items-center gap-4 px-5 lg:px-8">
      <button
        type="button"
        onClick={openCommandPalette}
        className="group relative flex h-9 flex-1 max-w-xl items-center gap-2 rounded-lg border border-border bg-card pl-3 pr-2 text-left transition-colors hover:border-border-strong"
      >
        <Search className="size-4 text-muted" />
        <span className="flex-1 truncate text-sm text-muted">
          Search clients, transactions, tickets, cases…
        </span>
        <kbd className="flex items-center gap-0.5 rounded border border-border bg-surface px-1.5 py-0.5 text-[10px] text-muted">
          <Command className="size-3" />K
        </kbd>
      </button>

      <div className="hidden items-center gap-2 rounded-lg border border-accent-green/20 bg-accent-green-soft px-3 py-1.5 md:flex">
        <LiveDot tone="green" />
        <span className="tnum text-xs font-medium text-accent-green">Shift · 3h 12m</span>
      </div>

      <Separator orientation="vertical" className="h-6" />

      <Button
        variant="ghost"
        size="icon"
        onClick={() => setTheme((t) => (t === "dark" ? "light" : "dark"))}
        aria-label="Toggle theme"
      >
        {theme === "dark" ? <Moon className="size-4" /> : <Sun className="size-4" />}
      </Button>

      <Button variant="ghost" size="icon" className="relative" aria-label="Notifications">
        <Bell className="size-4" />
        <span className="absolute right-1.5 top-1.5 flex size-2 rounded-full bg-accent-red" />
      </Button>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button className="flex items-center gap-2 rounded-lg py-1 pl-1 pr-2 transition-colors hover:bg-card">
            <Avatar className="size-8">
              <AvatarFallback>{initials(email)}</AvatarFallback>
            </Avatar>
            <div className="hidden flex-col items-start leading-none xl:flex">
              <span className="text-xs font-medium">{email.split("@")[0]}</span>
              <span className="text-[11px] capitalize text-muted">{role}</span>
            </div>
            <ChevronDown className="size-3.5 text-muted" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuLabel>{email}</DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuItem>
            <UserCog className="size-4" /> Profile settings
          </DropdownMenuItem>
          <DropdownMenuItem>
            <Timer className="size-4" /> End shift
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            className="text-accent-red"
            onSelect={() => {
              if (!isDemo) logout();
            }}
          >
            <LogOut className="size-4" /> Sign out
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </header>
  );
}
