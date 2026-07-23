"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Command } from "cmdk";
import {
  ArrowDownToLine,
  ArrowUpFromLine,
  BarChart3,
  CreditCard,
  LayoutDashboard,
  Search,
  ShieldCheck,
  AlertTriangle,
  Activity,
  FileText,
  Scale,
  Settings,
  Users,
  ScrollText,
  KeyRound,
  UserPlus,
  Timer,
  FilePlus2,
} from "lucide-react";

const OPEN_EVENT = "opsos:open-command";

/** Fire from anywhere to open the palette (e.g. the top-bar search button). */
export function openCommandPalette() {
  window.dispatchEvent(new CustomEvent(OPEN_EVENT));
}

const navItems = [
  { label: "Dashboard", href: "/", icon: LayoutDashboard },
  { label: "Operations", href: "/operations", icon: Activity },
  { label: "Payments", href: "/payments", icon: CreditCard },
  { label: "Deposits", href: "/deposits", icon: ArrowDownToLine },
  { label: "Withdrawals", href: "/withdrawals", icon: ArrowUpFromLine },
  { label: "Compliance", href: "/compliance", icon: ShieldCheck },
  { label: "Reconciliation", href: "/reconciliation", icon: Scale },
  { label: "Incidents", href: "/incidents", icon: AlertTriangle },
  { label: "Analytics", href: "/analytics", icon: BarChart3 },
  { label: "Reports", href: "/reports", icon: FileText },
  { label: "Settings", href: "/settings", icon: Settings },
  { label: "Users", href: "/admin/users", icon: Users },
  { label: "Audit Logs", href: "/admin/audit-logs", icon: ScrollText },
  { label: "API Keys", href: "/admin/api-keys", icon: KeyRound },
];

const quickActions = [
  { label: "New incident", icon: AlertTriangle, href: "/incidents" },
  { label: "Review KYC queue", icon: UserPlus, href: "/compliance" },
  { label: "Approve withdrawal", icon: ArrowUpFromLine, href: "/withdrawals" },
  { label: "Generate report", icon: FilePlus2, href: "/reports" },
  { label: "End shift", icon: Timer, href: "/operations" },
];

export function CommandPalette() {
  const [open, setOpen] = useState(false);
  const router = useRouter();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((o) => !o);
      }
    };
    const onOpen = () => setOpen(true);
    window.addEventListener("keydown", onKey);
    window.addEventListener(OPEN_EVENT, onOpen);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener(OPEN_EVENT, onOpen);
    };
  }, []);

  const go = (href: string) => {
    setOpen(false);
    router.push(href);
  };

  return (
    <Command.Dialog
      open={open}
      onOpenChange={setOpen}
      label="Command palette"
      className="fixed inset-0 z-[100]"
    >
      <div
        className="fixed inset-0 bg-black/50 backdrop-blur-sm data-[state=open]:animate-in data-[state=open]:fade-in-0"
        onClick={() => setOpen(false)}
      />
      <div className="fixed left-1/2 top-[18%] z-10 w-[92vw] max-w-xl -translate-x-1/2">
        <div className="glass overflow-hidden rounded-2xl border border-border-strong shadow-[var(--shadow-pop)]">
          <div className="flex items-center gap-3 border-b border-border px-4">
            <Search className="size-4 text-muted" />
            <Command.Input
              autoFocus
              placeholder="Search or jump to…"
              className="h-12 flex-1 bg-transparent text-sm text-foreground placeholder:text-muted outline-none"
            />
            <kbd className="rounded border border-border bg-surface px-1.5 py-0.5 text-[10px] text-muted">
              ESC
            </kbd>
          </div>
          <Command.List className="max-h-[320px] overflow-y-auto p-2">
            <Command.Empty className="py-8 text-center text-sm text-muted">
              No results found.
            </Command.Empty>

            <Command.Group
              heading="Quick actions"
              className="[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-[11px] [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-wider [&_[cmdk-group-heading]]:text-muted"
            >
              {quickActions.map((action) => (
                <Command.Item
                  key={action.label}
                  value={`action ${action.label}`}
                  onSelect={() => go(action.href)}
                  className="flex cursor-pointer items-center gap-3 rounded-lg px-2.5 py-2.5 text-sm text-muted-foreground data-[selected=true]:bg-accent-blue-soft data-[selected=true]:text-foreground"
                >
                  <action.icon className="size-4 text-accent-blue" />
                  {action.label}
                </Command.Item>
              ))}
            </Command.Group>

            <Command.Separator className="my-1.5 h-px bg-border" />

            <Command.Group
              heading="Go to"
              className="[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-[11px] [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-wider [&_[cmdk-group-heading]]:text-muted"
            >
              {navItems.map((item) => (
                <Command.Item
                  key={item.href}
                  value={`nav ${item.label}`}
                  onSelect={() => go(item.href)}
                  className="flex cursor-pointer items-center gap-3 rounded-lg px-2.5 py-2.5 text-sm text-muted-foreground data-[selected=true]:bg-card-hover data-[selected=true]:text-foreground"
                >
                  <item.icon className="size-4 text-muted" />
                  {item.label}
                </Command.Item>
              ))}
            </Command.Group>
          </Command.List>
        </div>
      </div>
    </Command.Dialog>
  );
}
