import { Badge } from "@/components/ui/badge";

type Variant = "default" | "blue" | "green" | "red" | "orange" | "purple";

// Maps common domain states to a semantic badge variant + label.
const STATUS_MAP: Record<string, { variant: Variant; label: string }> = {
  // transactions
  approved: { variant: "green", label: "Approved" },
  processing: { variant: "blue", label: "Processing" },
  pending: { variant: "purple", label: "Pending" },
  review: { variant: "orange", label: "Review" },
  declined: { variant: "red", label: "Declined" },
  failed: { variant: "red", label: "Failed" },
  refunded: { variant: "orange", label: "Refunded" },
  // kyc / compliance
  approved_kyc: { variant: "green", label: "Approved" },
  in_review: { variant: "blue", label: "In review" },
  rejected: { variant: "red", label: "Rejected" },
  edd_required: { variant: "orange", label: "EDD required" },
  // incidents / tickets
  open: { variant: "orange", label: "Open" },
  investigating: { variant: "blue", label: "Investigating" },
  resolved: { variant: "green", label: "Resolved" },
  closed: { variant: "default", label: "Closed" },
  escalated: { variant: "red", label: "Escalated" },
};

export function StatusBadge({ status, label }: { status: string; label?: string }) {
  const cfg = STATUS_MAP[status] ?? { variant: "default" as Variant, label: label ?? status };
  return <Badge variant={cfg.variant}>{label ?? cfg.label}</Badge>;
}

const RISK_MAP: Record<string, { variant: Variant; label: string }> = {
  low: { variant: "green", label: "Low" },
  medium: { variant: "orange", label: "Medium" },
  high: { variant: "red", label: "High" },
  critical: { variant: "red", label: "Critical" },
};

export function RiskBadge({ level }: { level: string }) {
  const cfg = RISK_MAP[level] ?? { variant: "default" as Variant, label: level };
  return (
    <Badge variant={cfg.variant}>
      <span className="size-1.5 rounded-full bg-current opacity-80" />
      {cfg.label}
    </Badge>
  );
}
