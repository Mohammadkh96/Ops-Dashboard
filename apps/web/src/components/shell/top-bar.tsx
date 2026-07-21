"use client";

import { Bell, Search, Command, Sun, Moon, ChevronDown, LogOut, UserCog, Timer } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

export function TopBar() {
  const [theme, setTheme] = useState<"dark" | "light">("dark");

  return (
    <header className="glass-surface sticky top-0 z-30 flex h-16 items-center gap-4 px-5 lg:px-8">
      <div className="relative flex-1 max-w-xl">
        <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted" />
        <input
          type="text"
          placeholder="Search clients, transactions, tickets, cases..."
          className="h-9 w-full rounded-lg border border-border bg-card pl-9 pr-16 text-sm text-foreground placeholder:text-muted outline-none transition-colors focus:border-border-strong"
        />
        <kbd className="pointer-events-none absolute right-2.5 top-1/2 flex -translate-y-1/2 items-center gap-0.5 rounded border border-border bg-surface px-1.5 py-0.5 text-[10px] text-muted">
          <Command className="size-3" />K
        </kbd>
      </div>

      <div className="flex items-center gap-2 rounded-lg border border-accent-green/20 bg-accent-green-soft px-3 py-1.5">
        <Timer className="size-3.5 text-accent-green" />
        <span className="text-xs font-medium text-accent-green">Shift active · 3h 12m</span>
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
              <AvatarFallback>MK</AvatarFallback>
            </Avatar>
            <div className="hidden flex-col items-start leading-none xl:flex">
              <span className="text-xs font-medium">Mohammad K.</span>
              <span className="text-[11px] text-muted">Operations Manager</span>
            </div>
            <ChevronDown className="size-3.5 text-muted" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuLabel>mohammad@tradin.com</DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuItem>
            <UserCog className="size-4" /> Profile settings
          </DropdownMenuItem>
          <DropdownMenuItem>
            <Timer className="size-4" /> End shift
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem className="text-accent-red">
            <LogOut className="size-4" /> Sign out
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </header>
  );
}
