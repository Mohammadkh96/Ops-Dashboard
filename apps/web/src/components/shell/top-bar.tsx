"use client";

import {
  Bell,
  Search,
  Command,
  Sun,
  Moon,
  ChevronDown,
  LogOut,
  UserCog,
  Timer,
  AlertOctagon,
  ShieldCheck,
  ArrowUpFromLine,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { LiveDot } from "@/components/ui/live-dot";
import { openCommandPalette } from "@/components/command-palette";
import { MobileNav } from "@/components/shell/mobile-nav";
import { useAuth } from "@/lib/auth";
import { useTheme } from "@/lib/theme";
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

const notifications = [
  { icon: AlertOctagon, tone: "text-accent-red", title: "ForumPay gateway offline", time: "2m ago" },
  { icon: ArrowUpFromLine, tone: "text-accent-orange", title: "Large withdrawal needs approval", time: "26m ago" },
  { icon: ShieldCheck, tone: "text-accent-green", title: "KYC completed — Client #66203", time: "1h ago" },
];

export function TopBar() {
  const { theme, toggle } = useTheme();
  const { user, isDemo, logout } = useAuth();

  const email = user?.email ?? "mohammad@tradin.com";
  const role = user?.role ? user.role.replace(/_/g, " ").toLowerCase() : "Operations Manager";

  return (
    <header className="glass-surface sticky top-0 z-30 flex h-16 items-center gap-4 px-5 lg:px-8">
      <MobileNav />
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
        onClick={toggle}
        aria-label={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
      >
        {theme === "dark" ? <Moon className="size-4" /> : <Sun className="size-4" />}
      </Button>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            className="relative flex size-9 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-card hover:text-foreground"
            aria-label="Notifications"
          >
            <Bell className="size-4" />
            <span className="absolute right-1.5 top-1.5 flex size-2 rounded-full bg-accent-red" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-80">
          <div className="flex items-center justify-between px-2.5 py-1.5">
            <span className="text-xs font-medium uppercase tracking-wider text-muted">
              Notifications
            </span>
            <span className="rounded-full bg-accent-red-soft px-1.5 py-0.5 text-[10px] font-semibold text-accent-red">
              {notifications.length} new
            </span>
          </div>
          <DropdownMenuSeparator />
          {notifications.map((n) => (
            <DropdownMenuItem key={n.title} className="items-start gap-3 py-2.5">
              <n.icon className={`mt-0.5 size-4 shrink-0 ${n.tone}`} />
              <div className="flex flex-1 flex-col gap-0.5">
                <span className="text-sm text-foreground">{n.title}</span>
                <span className="text-[11px] text-muted">{n.time}</span>
              </div>
            </DropdownMenuItem>
          ))}
          <DropdownMenuSeparator />
          <DropdownMenuItem className="justify-center text-xs text-muted-foreground">
            View all notifications
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

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
