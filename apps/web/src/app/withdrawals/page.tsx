import { PageHeader } from "@/components/ui/page-header";
import { type Stat } from "@/components/ui/stat-tile";
import { PaymentStats } from "@/components/payments/payment-stats";
import { TransactionsTable } from "@/components/payments/transactions-table";

// Shown only when no real payments exist yet — see PaymentStats.
const demoStats: Stat[] = [
  { label: "Today's Withdrawals", value: "$1.91M", delta: { text: "−3.2% vs yesterday", positive: false }, tone: "magenta", spark: [2.1, 2.0, 2.05, 1.95, 1.98, 1.9, 1.93, 1.91] },
  { label: "Awaiting Approval", value: "8", delta: { text: "1 large (>$50K)", positive: false }, tone: "orange", spark: [3, 4, 5, 6, 7, 7, 8, 8] },
  { label: "Avg Withdrawal", value: "$3,480", delta: { text: "+1.1%", positive: true }, tone: "blue", spark: [3.2, 3.3, 3.35, 3.4, 3.42, 3.45, 3.46, 3.48] },
  { label: "Avg Processing", value: "6m 12s", delta: { text: "−48s vs yesterday", positive: true }, tone: "purple", spark: [9, 8.5, 8, 7.5, 7, 6.8, 6.4, 6.2] },
];

export default function WithdrawalsPage() {
  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="Withdrawals" description="Outgoing transactions, approvals and risk flags." />
      <PaymentStats type="withdrawal" demo={demoStats} />
      <TransactionsTable fixedType="Withdrawal" />
    </div>
  );
}
