import type { LucideIcon } from "lucide-react";
import {
  LayoutDashboard,
  Activity,
  Timer,
  CreditCard,
  ArrowDownToLine,
  ArrowUpFromLine,
  ShieldCheck,
  AlertTriangle,
  BarChart3,
  FileText,
  Scale,
  Landmark,
  Settings,
  Users,
} from "lucide-react";

export type NavItem = {
  label: string;
  href: string;
  icon: LucideIcon;
  badge?: string;
  children?: { label: string; href: string }[];
};

export const primaryNav: NavItem[] = [
  { label: "Dashboard", href: "/", icon: LayoutDashboard },
  { label: "Shift", href: "/shift", icon: Timer },
  { label: "Operations", href: "/operations", icon: Activity },
  { label: "Payments", href: "/payments", icon: CreditCard },
  // Its own place in the main navigation, not a page inside Admin. Reading a
  // provider's ledger is desk work that happens every shift; configuring the
  // connection is administration that happens once. Putting the first behind
  // the second meant the admin passphrase got shared to look at payments.
  { label: "Providers", href: "/providers", icon: Landmark },
  { label: "Deposits", href: "/deposits", icon: ArrowDownToLine },
  { label: "Withdrawals", href: "/withdrawals", icon: ArrowUpFromLine },
  { label: "Compliance", href: "/compliance", icon: ShieldCheck },
  { label: "Reconciliation", href: "/reconciliation", icon: Scale },
  { label: "Incidents", href: "/incidents", icon: AlertTriangle },
  { label: "Analytics", href: "/analytics", icon: BarChart3 },
  { label: "Reports", href: "/reports", icon: FileText },
];

export const secondaryNav: NavItem[] = [
  { label: "Settings", href: "/settings", icon: Settings },
  {
    label: "Admin",
    href: "/admin/users",
    icon: Users,
    children: [
      { label: "Users", href: "/admin/users" },
      { label: "Audit Logs", href: "/admin/audit-logs" },
      { label: "Payment providers", href: "/admin/psps" },
      { label: "Integrations", href: "/admin/integrations" },
    ],
  },
];
