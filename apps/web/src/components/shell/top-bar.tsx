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
import { openCommandPalette } from "@/components/command-palette";
import { MobileNav } from "@/components/shell/mobile-nav";
import { RangePicker } from "@/components/shell/range-picker";
import { SyncStatus } from "@/components/shell/sync-status";
import { useAuth } from "@/lib/auth";
import {
  useMarkRead,
  useNotificationRuns,
  useNotifications,
} from "@/hooks/use-notifications";
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

/**
 * WHAT USED TO BE HERE was three invented notifications — a gateway that is not
 * offline, a withdrawal nobody requested, a KYC completion for a client id that
 * does not exist. On an operations dashboard a fabricated alert is worse than
 * no alerting at all: it teaches the desk that this bell means nothing, and the
 * day it means something they have already learned to ignore it.
 *
 * They are the demo-mode fallback now, and nothing else.
 */
const demoNotifications = [
  { icon: AlertOctagon, tone: "text-accent-red", title: "ForumPay gateway offline", time: "2m ago" },
  { icon: ArrowUpFromLine, tone: "text-accent-orange", title: "Large withdrawal needs approval", time: "26m ago" },
  { icon: ShieldCheck, tone: "text-accent-green", title: "KYC completed — Client #66203", time: "1h ago" },
];

/** Severity to the tone the rest of the product uses for the same word. */
const TONE: Record<string, string> = {
  critical: "text-accent-red",
  high: "text-accent-red",
  medium: "text-accent-orange",
  low: "text-muted-foreground",
};

const ICON: Record<string, typeof AlertOctagon> = {
  critical: AlertOctagon,
  high: AlertOctagon,
  medium: ArrowUpFromLine,
  low: ShieldCheck,
};

/** "4m ago" from an instant, without pulling in a date library. */
function ago(iso: string): string {
  const mins = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60_000));
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

export function TopBar() {
  const { theme, toggle } = useTheme();
  const { user, isDemo, logout } = useAuth();
  /**
   * The detection pass, on a timer, while somebody has the dashboard open.
   *
   * The bell lives on every page, so this is the one place it can run from
   * without being tied to whichever screen happens to be showing.
   */
  useNotificationRuns();
  const { data: feed } = useNotifications();
  const markRead = useMarkRead();
  const live = !isDemo && feed.notifications.length > 0;

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

      {/*
        Was a fixed "Shift · 3h 12m" that never moved — no shift system feeds
        it. Replaced by the window selector, which belongs here for the same
        reason: it applies to every screen, and every screen should say which
        period it is describing.
      */}
      <div className="hidden md:flex">
        <RangePicker />
      </div>

      {/* Beside the window selector on purpose: together they say which period
          is on screen and how current it is. Visible at every width — it is the
          refresh control as well as the freshness read-out, and hiding it on a
          phone hid the only way to pull new data. */}
      <SyncStatus />

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
            {/* The dot meant nothing before — it was painted on. It now means
                there is something unread, and its absence means there is not. */}
            {(isDemo ? demoNotifications.length : feed.unread) > 0 ? (
              <span className="absolute right-1.5 top-1.5 flex size-2 rounded-full bg-accent-red" />
            ) : null}
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-80">
          <div className="flex items-center justify-between px-2.5 py-1.5">
            <span className="text-xs font-medium uppercase tracking-wider text-muted">
              Notifications
            </span>
            {(isDemo ? demoNotifications.length : feed.unread) > 0 ? (
              <span className="rounded-full bg-accent-red-soft px-1.5 py-0.5 text-[10px] font-semibold text-accent-red">
                {isDemo ? demoNotifications.length : feed.unread} new
              </span>
            ) : null}
          </div>
          <DropdownMenuSeparator />

          {isDemo ? (
            demoNotifications.map((n) => (
              <DropdownMenuItem key={n.title} className="items-start gap-3 py-2.5">
                <n.icon className={`mt-0.5 size-4 shrink-0 ${n.tone}`} />
                <div className="flex flex-1 flex-col gap-0.5">
                  <span className="text-sm text-foreground">{n.title}</span>
                  <span className="text-[11px] text-muted">{n.time}</span>
                </div>
              </DropdownMenuItem>
            ))
          ) : live ? (
            feed.notifications.slice(0, 8).map((n) => {
              const Icon = ICON[n.severity] ?? ShieldCheck;
              return (
                <DropdownMenuItem
                  key={n.id}
                  className="items-start gap-3 py-2.5"
                  onSelect={() => markRead.mutate({ ids: [n.id] })}
                >
                  <Icon
                    className={`mt-0.5 size-4 shrink-0 ${TONE[n.severity] ?? "text-muted-foreground"}`}
                  />
                  <div className="flex flex-1 flex-col gap-0.5">
                    <span
                      className={`text-sm ${n.readAt ? "text-muted-foreground" : "text-foreground"}`}
                    >
                      {n.title}
                    </span>
                    {/* The first evidence line, because a title alone rarely
                        says what to do about it. */}
                    {n.body[0] ? (
                      <span className="line-clamp-2 text-[11px] text-muted">
                        {n.body[0]}
                      </span>
                    ) : null}
                    <span className="text-[11px] text-muted">
                      {ago(n.lastSeenAt)}
                      {n.source === "kyc" ? " · KYC" : " · payments"}
                      {/* An alert that never left the building is a fact the
                          desk needs about their own alerting. */}
                      {n.emailError ? ` · not emailed: ${n.emailError}` : ""}
                    </span>
                  </div>
                </DropdownMenuItem>
              );
            })
          ) : (
            <div className="px-2.5 py-4 text-center text-xs text-muted">
              Nothing to report. Conditions are checked every five minutes while
              this page is open, and after each nightly sync.
            </div>
          )}

          {live ? (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                className="justify-center text-xs text-muted-foreground"
                onSelect={() => markRead.mutate({ all: true })}
              >
                Mark all as read
              </DropdownMenuItem>
            </>
          ) : null}
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
